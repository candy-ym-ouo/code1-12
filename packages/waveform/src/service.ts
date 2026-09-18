import { stat } from 'node:fs/promises';
import path from 'node:path';
import {
  CacheCorruptError,
  evictCacheFile,
  loadCacheFile,
  saveCacheFile,
  type SourceFingerprint,
} from './cache-file.js';
import { decodeAudioFile } from './decode.js';
import {
  buildPyramid,
  PeakAccumulator,
  readPeaks,
  type ReadPeaksOptions,
  type ReadPeaksResult,
  type WaveformSnapshot,
} from './peaks.js';// 波形峰值缓存服务。
//
// 每个音频 key 对应一个 Entry，状态机：
//
//   empty ──build start──▶ building ──成功──▶ ready
//     ▲                      │
//     │                      └──失败──▶ failed（若曾有旧快照则回到 ready）
//     └──── invalidate ──────┘
//
// 关键不变式：
// 1. 对外只发布"完整快照"——构建结果在解码、金字塔、磁盘 rename 全部完成后，
//    通过单次引用赋值生效；读到 snapshot 的任何调用都拿到不可变完整数据。
// 2. 同一 key 同一时刻只有一个构建在跑；并发首请求共用同一个 promise。
// 3. 重建期间旧快照继续服务（stale:true），不返回半成品；没有旧快照的读取者
//    等待同一次构建结束。
// 4. 构建失败：旧快照保留（继续可读）；无旧快照进入 failed，下一次请求重试。
//    磁盘上只通过 temp + rename 发布完整文件。

export type EntryState = 'empty' | 'building' | 'ready' | 'failed';

export interface GetOptions {
  /** 强制重建（忽略可用缓存）。 */
  force?: boolean;
  /** 重建期间若有旧快照，是否立即返回旧快照而不是等待（默认 true）。 */
  staleWhileRebuild?: boolean;
}

export interface GetResult {
  snapshot: WaveformSnapshot;
  /** true 表示拿到的是旧快照，新构建尚在进行或源文件已变化。 */
  stale: boolean;
  state: EntryState;
}

export interface ReadResult extends ReadPeaksResult {
  stale: boolean;
  state: EntryState;
}

export interface PeakCacheServiceOptions {
  /** 缓存目录，默认 ${STORAGE_DIR}/waveform 或 ./storage/waveform。 */
  cacheDir?: string;
  samplesPerPeak?: number;
  /** 注入解码器（测试用）；默认走 decodeAudioFile。 */
  decode?: typeof decodeAudioFile;
  /** 自定义 key -> 缓存文件路径。 */
  resolveCachePath?: (key: string) => string;
}

interface BuildGate {
  promise: Promise<WaveformSnapshot>;
  /** 本次构建针对的源指纹；等待者据此判断结果是否仍然对题。 */
  fingerprint: SourceFingerprint;
  forced: boolean;
}

interface Entry {
  state: EntryState;
  snapshot: WaveformSnapshot | null;
  /** 当前内存快照对应的源指纹。 */
  fingerprint: SourceFingerprint | null;
  build: BuildGate | null;
}

class Mutex {
  #tail: Promise<void> = Promise.resolve();
  async run<T>(fn: () => T | Promise<T>): Promise<T> {
    // 链式互斥：新任务排在上一个任务之后，同一 key 的决策天然串行。
    let resolveNext!: () => void;
    const previous = this.#tail;
    this.#tail = new Promise<void>((resolve) => {
      resolveNext = resolve;
    });
    await previous;
    try {
      return await fn();
    } finally {
      resolveNext();
    }
  }
}

const DEFAULT_SAMPLES_PER_PEAK = 256;

type Decision =
  | { kind: 'ready'; snapshot: WaveformSnapshot; stale: boolean; state: EntryState }
  | { kind: 'wait'; gate: BuildGate; fingerprint: SourceFingerprint };

type AfterBuildResult =
  | { kind: 'retry' }
  | { kind: 'ready'; snapshot: WaveformSnapshot; stale: boolean; state: EntryState };

export class PeakCacheService {
  readonly cacheDir: string;
  readonly samplesPerPeak: number;
  readonly #entries = new Map<string, Entry>();
  readonly #locks = new Map<string, Mutex>();
  readonly #decode: typeof decodeAudioFile;
  readonly #resolveCachePath: (key: string) => string;

  constructor(options: PeakCacheServiceOptions = {}) {
    this.cacheDir =
      options.cacheDir ||
      path.join(process.env.STORAGE_DIR || path.resolve('storage'), 'waveform');
    this.samplesPerPeak = options.samplesPerPeak ?? DEFAULT_SAMPLES_PER_PEAK;
    this.#decode = options.decode ?? decodeAudioFile;
    this.#resolveCachePath =
      options.resolveCachePath ??
      ((key) => path.join(this.cacheDir, `${sanitizeKey(key)}.wvpk`));
  }

  #entry(key: string): Entry {
    let entry = this.#entries.get(key);
    if (!entry) {
      entry = { state: 'empty', snapshot: null, fingerprint: null, build: null };
      this.#entries.set(key, entry);
    }
    return entry;
  }

  #lockFor(key: string): Mutex {
    let lock = this.#locks.get(key);
    if (!lock) {
      lock = new Mutex();
      this.#locks.set(key, lock);
    }
    return lock;
  }

  async #fingerprint(sourcePath: string): Promise<SourceFingerprint> {
    const s = await stat(sourcePath);
    return { size: s.size, mtimeMs: s.mtimeMs };
  }

  static #matches(a: SourceFingerprint, b: SourceFingerprint): boolean {
    return a.size === b.size && a.mtimeMs === b.mtimeMs;
  }

  /**
   * 获取（必要时加载磁盘/构建）快照。构建过程对调用者表现为"等待一个 promise"，
   * 结果要么是完整快照，要么抛错，没有中间态。
   */
  get(key: string, sourcePath: string, options: GetOptions = {}): Promise<GetResult> {
    const opts: Required<GetOptions> = {
      force: options.force ?? false,
      // 默认语义：
      // - 自动重建（非强制，例如源文件被替换）：等待新结果，旧文件的峰值是错误数据，
      //   不能冒充当前文件（staleWhileRebuild 默认 false）；
      // - 显式强制重建：调用方知道自己在重建，默认同样等待。
      // 只有显式传 true 才在重建期间返回旧快照。
      staleWhileRebuild: options.staleWhileRebuild ?? false,
    };
    return this.#resolve(key, sourcePath, opts);
  }

  /**
   * 两阶段：
   * 1. 短临界区（mutex）内做一次决策——返回现成快照、附加到在途构建，或启动构建；
   * 2. 构建等待在锁外进行，因此重建不会阻塞同一 key 的其他读取，
   *    并发首请求也会附加到同一个 gate 而不是串行排队。
   */
  async #resolve(
    key: string,
    sourcePath: string,
    options: Required<GetOptions>,
  ): Promise<GetResult> {
    for (;;) {
      const decision = await this.#lockFor(key).run(() => this.#decide(key, sourcePath, options));

      switch (decision.kind) {
        case 'ready':
          return { snapshot: decision.snapshot, stale: decision.stale, state: decision.state };
        case 'wait': {
          const gate = decision.gate;
          const outcome = await gate.promise.then(
            (snapshot) => ({ ok: true as const, snapshot }),
            () => ({ ok: false as const }),
          );
          const followup: AfterBuildResult = await this.#lockFor(key).run(() =>
            this.#afterBuild(key, decision.fingerprint, options, gate, outcome),
          );
          if (followup.kind === 'retry') {
            // 构建失败：无论有没有旧快照，只要 #afterBuild 判定为 retry，
            // 就说明没有可返回给本次调用者的数据——抛错，由调用方稍后重试。
            if (!outcome.ok) throw new Error('波形峰值构建失败');
            continue;
          }
          return {
            snapshot: followup.snapshot,
            stale: followup.stale,
            state: followup.state,
          };
        }
      }
    }
  }

  /** 临界区内的单次决策，不允许在其中等待构建。 */
  async #decide(
    key: string,
    sourcePath: string,
    options: Required<GetOptions>,
  ): Promise<Decision> {
    const entry = this.#entry(key);
    const fingerprint = await this.#fingerprint(sourcePath);

    // 1) 已有进行中的构建。
    if (entry.build) {
      const gate = entry.build;
      const upToDate =
        entry.state === 'ready' &&
        entry.snapshot !== null &&
        entry.fingerprint !== null &&
        PeakCacheService.#matches(entry.fingerprint, fingerprint);

      // 非强制且现有快照与源一致：构建结果与现状等价，直接用现有快照。
      if (!options.force && upToDate) {
        return { kind: 'ready', snapshot: entry.snapshot!, stale: false, state: 'ready' };
      }
      // 显式允许 stale：立即返回旧的完整快照（绝不返回半成品）。
      if (entry.snapshot !== null && options.staleWhileRebuild) {
        return { kind: 'ready', snapshot: entry.snapshot, stale: true, state: 'building' };
      }
      // 其他情况到锁外等构建结束。
      return { kind: 'wait', gate, fingerprint };
    }

    // 2) 无构建中。内存快照新鲜且不要求强制：直接返回。
    if (
      !options.force &&
      entry.state === 'ready' &&
      entry.snapshot !== null &&
      entry.fingerprint !== null &&
      PeakCacheService.#matches(entry.fingerprint, fingerprint)
    ) {
      return { kind: 'ready', snapshot: entry.snapshot, stale: false, state: 'ready' };
    }

    // 3) 尝试磁盘缓存（强制重建时跳过）。
    if (!options.force) {
      const cachePath = this.#resolveCachePath(key);
      try {
        const loaded = await loadCacheFile(cachePath);
        if (
          loaded.snapshot.samplesPerPeak === this.samplesPerPeak &&
          PeakCacheService.#matches(loaded.source, fingerprint)
        ) {
          // 引用赋值发布，此前没有任何读者能见到这份快照。
          entry.snapshot = loaded.snapshot;
          entry.fingerprint = fingerprint;
          entry.state = 'ready';
          return { kind: 'ready', snapshot: loaded.snapshot, stale: false, state: 'ready' };
        }
        // 参数（samplesPerPeak）变化或源文件已替换：旧缓存不适用。
        await evictCacheFile(cachePath);
      } catch (error) {
        if (error instanceof CacheCorruptError) await evictCacheFile(cachePath);
        // ENOENT 是正常冷启动；其他 IO 错误也继续走重建路径。
      }
    }

    // 4) 启动新构建（旧快照字段保持不动，供 stale 服务）。等待在锁外发生。
    const gate = this.#startBuild(key, sourcePath, fingerprint, options.force);
    if (entry.snapshot !== null && options.staleWhileRebuild) {
      return { kind: 'ready', snapshot: entry.snapshot, stale: true, state: 'building' };
    }
    return { kind: 'wait', gate, fingerprint };
  }

  /** 构建结束后，重新进入临界区评估结果是否对题。 */
  #afterBuild(
    key: string,
    requestedFingerprint: SourceFingerprint,
    options: Required<GetOptions>,
    gate: BuildGate,
    outcome: { ok: true; snapshot: WaveformSnapshot } | { ok: false },
  ): AfterBuildResult {
    const entry = this.#entry(key);

    if (
      outcome.ok &&
      PeakCacheService.#matches(gate.fingerprint, requestedFingerprint) &&
      (!options.force || gate.forced)
    ) {
      return { kind: 'ready', snapshot: outcome.snapshot, stale: false, state: 'ready' };
    }

    // 失败但留下与当前源一致的旧快照：旧数据仍有效（失败发生在同一源上）。
    if (
      !outcome.ok &&
      entry.snapshot !== null &&
      entry.fingerprint !== null &&
      PeakCacheService.#matches(entry.fingerprint, requestedFingerprint)
    ) {
      return { kind: 'ready', snapshot: entry.snapshot, stale: false, state: 'ready' };
    }

    // 失败但留下旧快照：旧数据完整，只是可能对不上当前源（stale）。
    // 重建已经失败，立刻重试只会再次失败。
    if (!outcome.ok && entry.snapshot !== null) {
      const stale =
        entry.fingerprint === null ||
        !PeakCacheService.#matches(entry.fingerprint, requestedFingerprint);
      // 调用方明确不接受旧数据（要求强制重建或不允许 stale）时，把失败抛出去；
      // 自动重建路径中、存在同指纹旧快照的情况已在上面分支返回 fresh。
      if (!options.staleWhileRebuild && (options.force || stale)) {
        return { kind: 'retry' }; // #resolve 见到失败且无 fresh 数据会抛出
      }
      return { kind: 'ready', snapshot: entry.snapshot, stale, state: entry.state };
    }

    // 其他情况（要求强制但等完的不是强制构建 / 等待期间源又变化 / 成功但不对题）：
    // 重新决策一轮；"无快照的失败"由 #resolve 转为抛出。
    return { kind: 'retry' };
  }

  #startBuild(
    key: string,
    sourcePath: string,
    fingerprint: SourceFingerprint,
    forced: boolean,
  ): BuildGate {
    const entry = this.#entry(key);
    const cachePath = this.#resolveCachePath(key);
    entry.state = 'building';

    // Settler 模式：执行器同步执行，work.then 在 rejection 发生之前就同时挂上
    // 了 resolve 与 reject 两个 continuation，因此任何情况下都不会出现
    // "reject 时无 handler"的窗口；外部 await promise 仍会收到失败。
    const work = this.#runBuild(key, sourcePath, cachePath, fingerprint);
    let resolveGate!: (snapshot: WaveformSnapshot) => void;
    let rejectGate!: (error: unknown) => void;
    const promise = new Promise<WaveformSnapshot>((resolve, reject) => {
      resolveGate = resolve;
      rejectGate = reject;
    });
    work.then(resolveGate, rejectGate);
    // work 自身也保留一个 noop rejection handler：它的失败已转交给 gate promise，
    // 避免 work 独立被 unhandledRejection 追踪。
    work.catch(() => undefined);

    const gate: BuildGate = { fingerprint, forced, promise };
    entry.build = gate;

    // 构建结束（成功/失败）后摘除自己；只摘自己，不覆盖期间可能已开始的下一轮。
    // 注意：finally() 返回新 promise，失败时它也会 reject，必须单独挂 catch
    // （不能用 void，否则触发 unhandledRejection）。
    promise
      .finally(() => {
        if (entry.build === gate) entry.build = null;
      })
      .catch(() => undefined);
    return gate;
  }

  async #runBuild(
    key: string,
    sourcePath: string,
    cachePath: string,
    fingerprint: SourceFingerprint,
  ): Promise<WaveformSnapshot> {
    void key;
    const entry = this.#entry(key);
    const accumulator = new PeakAccumulator(this.samplesPerPeak);
    try {
      const info = await this.#decode(sourcePath, {
        onFrame: (value) => accumulator.push(value),
      });
      // finish 之后才有 level0；此前任何失败都不会产生部分快照。
      const level0 = accumulator.finish();
      const snapshot = buildPyramid(
        level0,
        accumulator.totalFrames,
        info.sampleRate,
        info.channels,
        this.samplesPerPeak,
      );

      // 磁盘原子发布。失败不影响内存快照可用性（下次重启重建即可）。
      try {
        await saveCacheFile(cachePath, snapshot, fingerprint);
      } catch (error) {
        console.warn(`[waveform] 缓存写入失败 ${cachePath}:`, error);
      }

      // 单次引用赋值：此前等待者只拿到 promise，旧快照读者拿的是旧引用；
      // 这行之后的新读者看到完整新快照。
      entry.snapshot = snapshot;
      entry.fingerprint = fingerprint;
      entry.state = 'ready';
      return snapshot;
    } catch (error) {
      // 有旧快照：恢复 ready（旧数据完整但可能陈旧）；无旧快照：failed。
      entry.state = entry.snapshot !== null ? 'ready' : 'failed';
      throw error;
    }
  }

  /** 只读快照：不触发构建。building 时若有旧快照则随 stale:true 一起返回。 */
  peek(key: string): { state: EntryState; snapshot: WaveformSnapshot | null; stale: boolean } {
    const entry = this.#entries.get(key);
    if (!entry) return { state: 'empty', snapshot: null, stale: false };
    return {
      state: entry.state,
      snapshot: entry.snapshot,
      stale: entry.state === 'building' && entry.snapshot !== null,
    };
  }

  /**
   * 多分辨率读取。语义：
   * - 冷启动（无任何快照）：等待本次构建，返回完整结果；
   * - 重建中且存在旧快照：默认立即返回旧数据（stale:true），不等待半成品；
   * - staleWhileRebuild:false：等待新快照构建完成。
   */
  async read(
    key: string,
    sourcePath: string,
    options: Omit<ReadPeaksOptions, 'width'> & GetOptions & { width?: number } = {},
  ): Promise<ReadResult> {
    const { force, staleWhileRebuild, width = 800, ...readOptions } = options;
    const result = await this.get(key, sourcePath, { force, staleWhileRebuild });
    const peaks = readPeaks(result.snapshot, { ...readOptions, width });
    return { ...peaks, stale: result.stale, state: result.state };
  }

  /**
   * 强制重建。默认等待重建完成并返回新快照；
   * 显式传 staleWhileRebuild:true 时，若有旧快照则立即返回 stale 旧快照。
   */
  rebuild(
    key: string,
    sourcePath: string,
    options: Omit<GetOptions, 'staleWhileRebuild'> & { staleWhileRebuild?: boolean } = {},
  ): Promise<GetResult> {
    return this.get(key, sourcePath, {
      force: true,
      staleWhileRebuild: options.staleWhileRebuild ?? false,
    });
  }

  /** 使条目失效：等待可能在跑的构建结束，丢弃内存快照并删除缓存文件。 */
  async invalidate(key: string): Promise<void> {
    await this.#lockFor(key).run(async () => {
      const entry = this.#entry(key);
      if (entry.build) await entry.build.promise.catch(() => undefined);
      entry.snapshot = null;
      entry.fingerprint = null;
      entry.state = 'empty';
      await evictCacheFile(this.#resolveCachePath(key));
    });
  }
}

function sanitizeKey(key: string): string {
  // key 通常是录音 UUID；兜底清洗防止路径穿越。
  const cleaned = path.basename(key).replace(/[^a-zA-Z0-9._-]/g, '_');
  return cleaned || 'unknown';
}
