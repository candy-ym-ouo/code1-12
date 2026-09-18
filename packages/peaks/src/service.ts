import { stat } from 'node:fs/promises';
import { StreamingPeakBuilder } from './builder.js';
import { openAudio } from './decoder/audio.js';
import {
  FilePeakStore,
  MemoryPeakStore,
  PeakSnapshot,
  type PeakStore,
} from './store.js';
import type {
  AudioSourceMeta,
  AudioStream,
  PeakPyramid,
  PeakWindow,
} from './types.js';

/** 构建过程中出现的错误基类，区分于读取参数错误。 */
export class PeakBuildError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'PeakBuildError';
  }
}

/** 等待构建超时且没有可用旧快照时抛出。 */
export class PeakBuildTimeoutError extends PeakBuildError {
  constructor(key: string) {
    super(`波形峰值构建超时: ${key}`);
    this.name = 'PeakBuildTimeoutError';
  }
}

/** 服务关闭后再发起构建/等待时抛出。 */
export class PeakServiceClosedError extends PeakBuildError {
  constructor() {
    super('波形峰值服务已关闭');
    this.name = 'PeakServiceClosedError';
  }
}

/**
 * 音频来源：给定文件路径，服务自行流式解码；或直接提供解码流（如上传管道）。
 */
export type AudioSource =
  | { type: 'file'; path: string }
  | {
      type: 'stream';
      meta: AudioSourceMeta;
      open: (signal: AbortSignal) => Promise<AudioStream> | AudioStream;
    };

export interface PeakServiceOptions {
  /** 持久化存储；传入 { directory } 使用文件存储；默认使用 MemoryPeakStore。 */
  store?: PeakStore | { directory: string };
  /** 第 0 层桶覆盖帧数，默认 256。 */
  baseBlockFrames?: number;
  /** 金字塔最大层数，默认 24。 */
  maxLevels?: number;
  /** 后台构建最大并发，默认 2。 */
  buildConcurrency?: number;
  /** 构建失败后的冷却时间（毫秒），冷却期内直接拒绝以防打满解码器，默认 2000。 */
  failureCooldownMs?: number;
  /** 读取磁盘块大小（字节）透传给 WAV 解码器。 */
  chunkBytes?: number;
}

export interface GetSnapshotOptions {
  /** 即使已有缓存也强制重建（重建期间仍可按 stale 策略返回旧快照）。 */
  force?: boolean;
  /** 不等待构建：命中旧快照即返回，否则返回 building 状态。 */
  noWait?: boolean;
  /** 等待构建的超时（毫秒）；超时且无旧快照时抛出 {@link PeakBuildTimeoutError}。 */
  timeoutMs?: number;
}

export interface SnapshotResult {
  snapshot: PeakSnapshot | null;
  status: 'hit' | 'building' | 'stale';
  /** status === 'stale' 时附带后台构建的最新错误（若已知）。 */
  buildError?: unknown;
}

interface BuildingState {
  phase: 'building';
  promise: Promise<PeakSnapshot>;
  /** 本次构建的代号；invalidate 会抬升代号，旧构建完成后不得覆盖新状态。 */
  generation: number;
  controller: AbortController;
}

interface FailedState {
  phase: 'failed';
  error: PeakBuildError;
  at: number;
  generation: number;
}

type BuildState = BuildingState | FailedState;

interface Entry {
  state: BuildState | undefined;
  /** 每次失效/强制重建时递增；进行中的旧构建完成后凭它放弃提交。 */
  generation: number;
  /** 最近一次请求的来源，供构建被中止后无缝重启新一轮构建。 */
  lastSource: AudioSource | undefined;
  lastMeta: AudioSourceMeta | undefined;
}

class AsyncMutex {
  private tail: Promise<void> = Promise.resolve();

  /** 串行执行临界区；耗时的构建等待必须发生在锁外。 */
  async runExclusive<T>(fn: () => Promise<T> | T): Promise<T> {
    const previous = this.tail;
    let release: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await fn();
    } finally {
      release!();
    }
  }
}

type Decision =
  | { kind: 'hit'; snapshot: PeakSnapshot }
  | { kind: 'stale'; snapshot: PeakSnapshot }
  | { kind: 'wait'; state: BuildingState }
  | { kind: 'fail'; error: PeakBuildError };

/**
 * 波形峰值缓存服务。
 *
 * 并发保证（核心不变式）：
 * - 同一 key 的并发请求只会触发一次解码/构建，其余请求等待同一个 Promise；
 * - 构建结果是完整不可变的 {@link PeakSnapshot}，只有在金字塔构建并持久化完成后
 *   才会通过引用替换对外可见——任何读取都拿不到「构建中」的半成品；
 * - 重建期间已有的旧快照保持可读（stale-while-revalidate），等待超时时也返回旧快照；
 * - 磁盘缓存通过临时文件 + fsync + 原子 rename 落盘，损坏文件会被 CRC 拦截并隔离；
 * - invalidate 会抬升 generation 并中止进行中的旧构建；旧构建即使晚完成也会放弃
 *   提交，绝不会用旧值覆盖新状态，等待方会自动衔接到新一轮构建。
 */
export class PeakCacheService {
  private readonly store: PeakStore;
  private readonly baseBlockFrames: number;
  private readonly maxLevels: number;
  private readonly failureCooldownMs: number;
  private readonly chunkBytes?: number;
  private readonly locks = new Map<string, AsyncMutex>();
  private readonly entries = new Map<string, Entry>();
  private readonly snapshots = new Map<string, PeakSnapshot>();
  private activeBuilds = 0;
  private readonly buildQueue: Array<() => void> = [];
  private readonly maxConcurrentBuilds: number;
  private closed = false;

  constructor(options: PeakServiceOptions = {}) {
    this.store = options.store
      ? 'directory' in options.store
        ? new FilePeakStore(options.store.directory)
        : options.store
      : new MemoryPeakStore();
    this.baseBlockFrames = options.baseBlockFrames ?? 256;
    this.maxLevels = options.maxLevels ?? 24;
    this.maxConcurrentBuilds = options.buildConcurrency ?? 2;
    this.failureCooldownMs = options.failureCooldownMs ?? 2000;
    this.chunkBytes = options.chunkBytes;
  }

  /**
   * 获取（必要时后台构建）一份不可变峰值快照。
   *
   * 「决策」在每 key 互斥区内快速完成（内存/磁盘命中检查、启动构建），对构建
   * Promise 的等待发生在锁外：不同 key 完全并行，同 key 的构建也绝不会重复。
   */
  async getSnapshot(source: AudioSource, options: GetSnapshotOptions = {}): Promise<SnapshotResult> {
    const meta = await this.resolveMeta(source);
    const lock = this.lockFor(meta.key);
    const initial = await lock.runExclusive(() => this.decide(source, meta, options));
    if (initial.kind === 'hit') return { snapshot: initial.snapshot, status: 'hit' };
    if (initial.kind === 'stale') return { snapshot: initial.snapshot, status: 'stale' };
    if (initial.kind === 'fail') throw initial.error;
    return this.awaitBuild(meta.key, initial.state, options);
  }

  /** 便捷方法：拿到快照后直接按窗口/分辨率读取。 */
  async getWindow(
    source: AudioSource,
    windowOptions?: Parameters<PeakSnapshot['readWindow']>[0],
    options?: GetSnapshotOptions,
  ): Promise<{ window: PeakWindow | null; status: SnapshotResult['status']; stale: boolean }> {
    const result = await this.getSnapshot(source, options);
    if (!result.snapshot) {
      return { window: null, status: result.status, stale: false };
    }
    const stale = result.status === 'stale';
    return {
      window: result.snapshot.readWindow({ ...(windowOptions ?? {}), stale }),
      status: result.status,
      stale,
    };
  }

  /** 预热：与读取相同的合并语义，但不等待构建。 */
  prebuild(source: AudioSource): Promise<SnapshotResult> {
    return this.getSnapshot(source, { noWait: true });
  }

  /**
   * 使缓存失效：丢弃内存快照、删除持久化缓存、抬升 generation 并中止进行中的旧
   * 构建。旧构建完成时会放弃提交；已在等待的调用方会衔接到之后的新一轮构建。
   */
  async invalidate(
    key: string,
    options: { deleteFromStore?: boolean; abort?: boolean } = {},
  ): Promise<void> {
    const { deleteFromStore = true, abort = true } = options;
    const lock = this.lockFor(key);
    let controller: AbortController | undefined;
    await lock.runExclusive(() => {
      const entry = this.entryFor(key);
      if (entry.state?.phase === 'building') controller = entry.state.controller;
      entry.generation++;
      entry.state = undefined;
      this.snapshots.delete(key);
    });
    if (abort) controller?.abort();
    if (deleteFromStore) await this.store.remove(key);
  }

  /** 查询当前 key 的缓存/构建状态（不同步等待，仅用于观测）。 */
  status(key: string): { hasSnapshot: boolean; phase?: 'building' | 'failed'; error?: unknown } {
    const snapshot = this.snapshots.get(key);
    const entry = this.entries.get(key);
    return {
      hasSnapshot: snapshot !== undefined,
      phase: entry?.state?.phase,
      error: entry?.state?.phase === 'failed' ? entry.state.error : undefined,
    };
  }

  /** 关闭服务：拒绝新请求，释放构建排队并中止所有进行中的构建。 */
  close(): void {
    this.closed = true;
    const queued = this.buildQueue.splice(0);
    for (const resolve of queued) resolve();
    for (const entry of this.entries.values()) {
      if (entry.state?.phase === 'building') entry.state.controller.abort();
    }
  }

  private lockFor(key: string): AsyncMutex {
    let lock = this.locks.get(key);
    if (!lock) {
      lock = new AsyncMutex();
      this.locks.set(key, lock);
    }
    return lock;
  }

  private entryFor(key: string): Entry {
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { state: undefined, generation: 0, lastSource: undefined, lastMeta: undefined };
      this.entries.set(key, entry);
    }
    return entry;
  }

  private async resolveMeta(source: AudioSource): Promise<AudioSourceMeta> {
    if (source.type === 'stream') return source.meta;
    try {
      const info = await stat(source.path);
      return {
        key: source.path,
        mtimeMs: Math.trunc(info.mtimeMs),
        sizeBytes: info.size,
      };
    } catch {
      // 文件尚不存在时也允许进入决策（构建阶段会再次失败并给出明确错误）。
      return { key: source.path };
    }
  }

  /** 临界区：根据内存/磁盘缓存与构建状态给出本次请求的决策。 */
  private async decide(
    source: AudioSource,
    meta: AudioSourceMeta,
    options: GetSnapshotOptions,
  ): Promise<Decision> {
    if (this.closed) throw new PeakServiceClosedError();

    const key = meta.key;
    const entry = this.entryFor(key);
    entry.lastSource = source;
    entry.lastMeta = meta;

    const inMemory = this.snapshots.get(key);
    const memoryFresh = inMemory && inMemory.matches(meta) ? inMemory : undefined;

    if (memoryFresh && !options.force) {
      return { kind: 'hit', snapshot: memoryFresh };
    }

    // 强制重建：抬升 generation 并中止旧构建，随后启动新一代构建。
    // 旧快照保留可读，等待期间按 stale 返回，新快照提交前不影响其他读者。
    if (options.force) {
      if (entry.state?.phase === 'building') entry.state.controller.abort();
      entry.generation++;
      entry.state = undefined;
    }

    // 构建进行中：等待同一个 Promise，绝不启动第二次解码。
    if (!options.force && entry.state?.phase === 'building') {
      return { kind: 'wait', state: entry.state };
    }

    // 失败冷却期：避免源文件持续错误时每次请求都重启解码器。
    if (
      !options.force &&
      entry.state?.phase === 'failed' &&
      Date.now() - entry.state.at < this.failureCooldownMs
    ) {
      if (inMemory) return { kind: 'stale', snapshot: inMemory };
      return { kind: 'fail', error: entry.state.error };
    }

    // 尝试磁盘缓存（仅当与源文件元信息匹配时）。
    if (!options.force) {
      let persisted: PeakSnapshot | undefined;
      try {
        persisted = await this.store.load(meta);
      } catch {
        persisted = undefined; // 损坏缓存已被存储层隔离，按未命中处理。
      }
      if (persisted && persisted.matches(meta)) {
        this.snapshots.set(key, persisted);
        return { kind: 'hit', snapshot: persisted };
      }
    }

    // 启动新构建（实际执行受全局并发闸控制）。
    return { kind: 'wait', state: this.spawnBuild(entry, source, meta) };
  }

  /** 临界区内创建构建状态；同一时刻同 key 只允许有一个 building 状态。 */
  private spawnBuild(entry: Entry, source: AudioSource, meta: AudioSourceMeta): BuildingState {
    const generation = entry.generation;
    const controller = new AbortController();
    const state: BuildingState = {
      phase: 'building',
      generation,
      controller,
      promise: undefined as unknown as Promise<PeakSnapshot>,
    };
    state.promise = this.startBuild(source, meta, generation, controller.signal);
    entry.state = state;
    // 防止没有其他调用方 await 时产生 unhandledRejection。
    state.promise.catch(() => undefined);
    return state;
  }

  /**
   * 锁外等待构建完成。被 invalidate 中止而进入下一轮构建时会自动衔接，因此调用方
   * 要么拿到完整快照、要么得到 stale 旧快照/明确错误，期间永远观察不到半成品。
   */
  private async awaitBuild(
    key: string,
    first: BuildingState,
    options: GetSnapshotOptions,
  ): Promise<SnapshotResult> {
    if (options.noWait) {
      const staleSnapshot = this.snapshots.get(key);
      if (staleSnapshot) return { snapshot: staleSnapshot, status: 'stale' };
      return { snapshot: null, status: 'building' };
    }

    const deadline =
      options.timeoutMs && options.timeoutMs > 0 ? Date.now() + options.timeoutMs : undefined;
    let current = first;
    let lastError: unknown;
    let hops = 0;

    for (;;) {
      const remainingMs = deadline ? deadline - Date.now() : Infinity;
      if (deadline && remainingMs <= 0) {
        const staleSnapshot = this.snapshots.get(key);
        if (staleSnapshot) {
          return { snapshot: staleSnapshot, status: 'stale', buildError: lastError };
        }
        throw new PeakBuildTimeoutError(key);
      }

      // 等待当前这一代构建结束（成功 resolve / 失败 reject / 超时到点）。
      let outcome: 'settled' | 'timeout' = 'timeout';
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        outcome = await Promise.race([
          current.promise.then(() => 'settled' as const),
          new Promise<'timeout'>((resolve) => {
            timer = setTimeout(
              () => resolve('timeout'),
              deadline ? Math.max(1, remainingMs) : 0x7fffffff,
            );
          }),
        ]);
      } catch (error) {
        lastError = error;
      } finally {
        if (timer) clearTimeout(timer);
      }

      // 在锁内依据「构建后的当前状态」重新决策：命中 / 失败 / 衔接下一代构建。
      const decision = await this.lockFor(key).runExclusive(() =>
        this.settleDecision(key),
      );

      if (decision.kind === 'wait') {
        // 仅在真正跨代（旧构建被 invalidate）时计数，普通超时重等同一构建不计数。
        if (decision.state !== current) hops++;
        if (hops > 64) throw new PeakBuildError('峰值构建衔接次数超限');
        current = decision.state;
        continue;
      }

      if (decision.kind === 'hit') {
        // 构建已成功提交即为 hit；若 outcome 是 timeout 但快照在 settle 前刚提交，
        // 快照本身完整且新鲜，也按 hit 返回（调用方拿到的不是半成品也不是旧值）。
        return { snapshot: decision.snapshot, status: 'hit' };
      }

      if (decision.kind === 'stale') {
        return { snapshot: decision.snapshot, status: 'stale', buildError: lastError };
      }

      // kind === 'fail'
      const staleSnapshot = this.snapshots.get(key);
      if (staleSnapshot) {
        return { snapshot: staleSnapshot, status: 'stale', buildError: decision.error };
      }
      throw decision.error;
    }
  }

  /** 临界区：构建结束后依据当前状态决定命中、stale、失败，或启动下一代构建。 */
  private async settleDecision(key: string): Promise<Decision> {
    const entry = this.entries.get(key);
    if (!entry || !entry.lastSource || !entry.lastMeta) {
      return { kind: 'fail', error: new PeakBuildError(`峰值缓存状态缺失: ${key}`) };
    }
    return this.decide(entry.lastSource, entry.lastMeta, { force: false });
  }

  private async acquireBuildSlot(): Promise<void> {
    if (this.closed) throw new PeakServiceClosedError();
    if (this.activeBuilds < this.maxConcurrentBuilds) {
      this.activeBuilds++;
      return;
    }
    await new Promise<void>((resolve) => this.buildQueue.push(resolve));
    if (this.closed) throw new PeakServiceClosedError();
    this.activeBuilds++;
  }

  private releaseBuildSlot(): void {
    this.activeBuilds--;
    const next = this.buildQueue.shift();
    if (next) next();
  }

  private startBuild(
    source: AudioSource,
    meta: AudioSourceMeta,
    generation: number,
    signal: AbortSignal,
  ): Promise<PeakSnapshot> {
    return (async () => {
      await this.acquireBuildSlot();
      try {
        return await this.runBuild(source, meta, generation, signal);
      } finally {
        this.releaseBuildSlot();
      }
    })();
  }

  private async runBuild(
    source: AudioSource,
    meta: AudioSourceMeta,
    generation: number,
    signal: AbortSignal,
  ): Promise<PeakSnapshot> {
    let stream: AudioStream;
    try {
      stream =
        source.type === 'file'
          ? await openAudio(source.path, { chunkBytes: this.chunkBytes, signal })
          : await source.open(signal);
    } catch (error) {
      this.finishBuildAsFailed(meta.key, generation, error);
      throw normalizeBuildError(error);
    }

    const builder = new StreamingPeakBuilder(stream.sampleRate, stream.channels, {
      baseBlockFrames: this.baseBlockFrames,
      maxLevels: this.maxLevels,
    });

    try {
      for await (const chunk of stream) {
        if (signal.aborted) throw new PeakBuildError('波形峰值构建已取消');
        builder.push(chunk);
      }
      if (signal.aborted) throw new PeakBuildError('波形峰值构建已取消');
      const pyramid: PeakPyramid = builder.finish();
      const snapshot = new PeakSnapshot(
        meta.key,
        pyramid,
        meta.mtimeMs ?? -1,
        meta.sizeBytes ?? -1,
      );

      // 先持久化（原子落盘）；成功后在临界区内做 generation 校验再替换内存引用。
      await this.store.save(snapshot);
      await this.lockFor(meta.key).runExclusive(() => {
        const entry = this.entryFor(meta.key);
        if (entry.generation !== generation) return; // 已失效：放弃提交。
        entry.state = undefined;
        this.snapshots.set(meta.key, snapshot);
      });
      return snapshot;
    } catch (error) {
      this.finishBuildAsFailed(meta.key, generation, error);
      throw normalizeBuildError(error);
    }
  }

  private finishBuildAsFailed(key: string, generation: number, error: unknown): void {
    const normalized = normalizeBuildError(error);
    void this.lockFor(key).runExclusive(() => {
      const entry = this.entries.get(key);
      if (!entry || entry.generation !== generation) return;
      if (entry.state?.phase !== 'building') return;
      entry.state = { phase: 'failed', error: normalized, at: Date.now(), generation };
    });
  }
}

function normalizeBuildError(error: unknown): PeakBuildError {
  if (error instanceof PeakBuildError) return error;
  if (error instanceof Error) return new PeakBuildError(error.message, error);
  return new PeakBuildError(`波形峰值构建失败: ${String(error)}`);
}
