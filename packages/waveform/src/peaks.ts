// 波形峰值金字塔：
// level 0 是流式累积得到的最细粒度峰值（每 SAMPLES_PER_PEAK 个采样一对 min/max），
// level k+1 由 level k 每 2 对峰值精确聚合（min 取最小、max 取最大）。
//
// 峰值统一量化为有符号 16 位（[-32768, 32767]），与 audiowaveform .dat 的
// min/max peak 约定一致，最终给前端时再归一化到 [-1, 1]。

export const QUANT_MAX = 32767;
export const QUANT_MIN = -32768;

export interface WaveformLevel {
  /** minPeak / maxPeak，长度均为 bins，索引 i 表示同一个桶。 */
  min: Int16Array;
  max: Int16Array;
}

export interface WaveformSnapshot {
  version: number;
  /** level 0 每个桶覆盖的解码后单声道采样数。 */
  samplesPerPeak: number;
  sampleRate: number;
  channels: number;
  /** 实际消费到的解码后单声道帧总数。 */
  totalFrames: number;
  /** levels[0] 最细，越往后越粗。 */
  levels: WaveformLevel[];
}

/** 将 [-1, 1] 采样量化为 16 位整数，带饱和保护。 */
export function quantizePeak(value: number): number {
  if (!Number.isFinite(value)) return value > 0 ? QUANT_MAX : QUANT_MIN;
  if (value >= 1) return QUANT_MAX;
  if (value <= -1) return QUANT_MIN;
  // 向远离零的方向取整（Math.round(-0.5) 会得到 -0），避免微小峰值被抹成 0。
  const scaled = value * QUANT_MAX;
  const rounded = scaled >= 0 ? Math.floor(scaled + 0.5) : Math.ceil(scaled - 0.5);
  return Math.max(QUANT_MIN, Math.min(QUANT_MAX, rounded));
}

/**
 * 流式峰值累积器。喂入已经归一化到 [-1, 1] 的单声道采样；
 * 内部用固定大小的 Int16 分块存放，避免大音频下 number[] 的对象开销。
 */
export class PeakAccumulator {
  readonly samplesPerPeak: number;

  #chunks: Array<{ min: Int16Array; max: Int16Array }> = [];
  #chunkCapacity: number;
  #cursor = 0; // 当前桶在当前块中的位置
  #used = 0; // 已关闭 + 进行中的桶总数
  #inBucket = 0; // 当前桶已收集采样数
  #curMin = 1; // 空桶占位，第一个采样必定替换（见 push）
  #curMax = -1;
  #totalFrames = 0;

  constructor(samplesPerPeak = 256, chunkCapacity = 1 << 16) {
    if (!Number.isInteger(samplesPerPeak) || samplesPerPeak <= 0) {
      throw new Error('samplesPerPeak 必须是正整数');
    }
    this.samplesPerPeak = samplesPerPeak;
    this.#chunkCapacity = chunkCapacity;
    this.#chunks.push({
      min: new Int16Array(chunkCapacity),
      max: new Int16Array(chunkCapacity),
    });
  }

  push(sample: number): void {
    this.#totalFrames += 1;
    if (this.#inBucket === 0) {
      this.#curMin = sample;
      this.#curMax = sample;
    } else {
      if (sample < this.#curMin) this.#curMin = sample;
      if (sample > this.#curMax) this.#curMax = sample;
    }
    this.#inBucket += 1;
    if (this.#inBucket === this.samplesPerPeak) this.#closeBucket();
  }

  #closeBucket(): void {
    if (this.#inBucket === 0) return;
    const block = this.#chunks[this.#chunks.length - 1]!;
    block.min[this.#cursor] = quantizePeak(this.#curMin);
    block.max[this.#cursor] = quantizePeak(this.#curMax);
    this.#cursor += 1;
    this.#used += 1;
    this.#inBucket = 0;
    if (this.#cursor === this.#chunkCapacity) {
      this.#chunks.push({
        min: new Int16Array(this.#chunkCapacity),
        max: new Int16Array(this.#chunkCapacity),
      });
      this.#cursor = 0;
    }
  }

  /**
   * 结束流并产出 level 0（含可能未满的最后一个桶，partial 桶仍由真实样本计算，
   * 绝不用 0 补齐）。必须且只能调用一次。
   */
  finish(): WaveformLevel {
    this.#closeBucket();
    const min = new Int16Array(this.#used);
    const max = new Int16Array(this.#used);
    let offset = 0;
    for (const chunk of this.#chunks) {
      const n = Math.min(chunk.min.length, this.#used - offset);
      if (n <= 0) break;
      min.set(chunk.min.subarray(0, n), offset);
      max.set(chunk.max.subarray(0, n), offset);
      offset += n;
    }
    this.#chunks = [];
    return { min, max };
  }

  get totalFrames(): number {
    return this.#totalFrames;
  }
}

/** 由相邻两对峰值聚合出上一层（每 2 对 → 1 对）。 */
export function aggregateLevel(level: WaveformLevel): WaveformLevel {
  const bins = Math.floor(level.min.length / 2);
  const min = new Int16Array(bins);
  const max = new Int16Array(bins);
  for (let i = 0; i < bins; i += 1) {
    const a = i * 2;
    const b = a + 1;
    const x0 = level.min[a]!;
    const x1 = level.min[b]!;
    const y0 = level.max[a]!;
    const y1 = level.max[b]!;
    min[i] = x0 < x1 ? x0 : x1;
    max[i] = y0 > y1 ? y0 : y1;
  }
  return { min, max };
}

export function buildPyramid(
  level0: WaveformLevel,
  totalFrames: number,
  sampleRate: number,
  channels: number,
  samplesPerPeak: number,
): WaveformSnapshot {
  const levels: WaveformLevel[] = [level0];
  // 最细层不足 2 个桶时也停止，单层金字塔对所有宽度都够用。
  while (levels[levels.length - 1]!.min.length >= 2) {
    levels.push(aggregateLevel(levels[levels.length - 1]!));
  }
  return { version: 1, samplesPerPeak, sampleRate, channels, totalFrames, levels };
}

export interface ReadPeaksOptions {
  /** 目标像素/桶数，输出长度恒等于 width（输入为空时除外）。 */
  width: number;
  /** 起始时间（毫秒），缺省从头开始。 */
  startMs?: number;
  /** 结束时间（毫秒），缺省到结尾。 */
  endMs?: number;
  /** 直接指定金字塔层级；默认按 width 自动选择最粗的够用层级。 */
  level?: number;
}

export interface PeakBucket {
  min: number;
  max: number;
}

export interface ReadPeaksResult {
  level: number;
  durationMs: number;
  startMs: number;
  endMs: number;
  buckets: PeakBucket[];
}

/**
 * 读取多分辨率峰值。绝不返回半成品：输入是不可变快照，读取过程中重建只会让
 * 服务换用新快照，不影响本次结果。
 *
 * 重采样保证：每个输出桶由其覆盖的全部源桶的 min/max 聚合而来（数据无损），
 * 输出桶数严格等于 width；时间范围是左闭右开，端点按比例映射到桶索引。
 */
export function readPeaks(snapshot: WaveformSnapshot, options: ReadPeaksOptions): ReadPeaksResult {
  const width = options.width;
  if (!Number.isInteger(width) || width <= 0) {
    throw new RangeError('width 必须是正整数');
  }
  if (width > 100_000) throw new RangeError('width 最大为 100000');

  const durationMs =
    snapshot.sampleRate > 0 && snapshot.totalFrames > 0
      ? (snapshot.totalFrames / snapshot.sampleRate) * 1000
      : 0;

  const startMs = Math.max(0, Math.min(options.startMs ?? 0, durationMs));
  const endMsRaw = options.endMs ?? durationMs;
  const endMs = Math.max(startMs, Math.min(endMsRaw, durationMs));

  const levelCount = snapshot.levels.length;
  let levelIndex =
    options.level === undefined
      ? 0
      : Math.max(0, Math.min(options.level, levelCount - 1));

  const framesPerBucket = (level: number): number =>
    snapshot.samplesPerPeak * 2 ** level;

  const frameAt = (ms: number): number =>
    snapshot.sampleRate > 0 ? (ms / 1000) * snapshot.sampleRate : 0;

  // 自动选层：选“范围内桶数 >= width”的最粗层；若最细层都不够，则用最细层。
  if (options.level === undefined && durationMs > 0) {
    const startFrame = frameAt(startMs);
    const endFrame = endMs >= durationMs ? snapshot.totalFrames : frameAt(endMs);
    const spanFrames = Math.max(0, endFrame - startFrame);
    let chosen = 0;
    for (let l = 0; l < levelCount; l += 1) {
      const bucketsInRange = spanFrames / framesPerBucket(l);
      if (bucketsInRange >= width) chosen = l;
      else break;
    }
    levelIndex = chosen;
  }

  const level = snapshot.levels[levelIndex]!;
  const sourceBins = level.min.length;

  let from = 0;
  let to = sourceBins;
  if (durationMs > 0) {
    const fpb = framesPerBucket(levelIndex);
    const startFrame = frameAt(startMs);
    from = Math.floor(startFrame / fpb);
    to =
      endMs >= durationMs
        ? sourceBins
        : Math.min(sourceBins, Math.ceil(frameAt(endMs) / fpb));
    if (to < from) to = from;
  }

  const buckets: PeakBucket[] = [];
  const span = to - from;
  if (span > 0) {
    // 把 [from, to) 等分成 width 段，边界用乘法而不是累加，避免浮点漂移。
    for (let i = 0; i < width; i += 1) {
      const lo = from + Math.floor((i * span) / width);
      const hi = from + Math.floor(((i + 1) * span) / width);
      const start = Math.max(from, Math.min(to, lo));
      const end = Math.max(start, Math.min(to, hi === lo ? lo + 1 : hi));
      let loMin = QUANT_MAX;
      let hiMax = QUANT_MIN;
      for (let j = start; j < end; j += 1) {
        const vMin = level.min[j]!;
        const vMax = level.max[j]!;
        if (vMin < loMin) loMin = vMin;
        if (vMax > hiMax) hiMax = vMax;
      }
      buckets.push({ min: loMin / QUANT_MAX, max: hiMax / QUANT_MAX });
    }
  }

  // 实际时间范围回填，便于调用方对齐播放头。
  const actualStartMs = durationMs > 0 ? (from * framesPerBucket(levelIndex) / snapshot.sampleRate) * 1000 : 0;
  const actualEndMs =
    durationMs > 0 && to > 0
      ? (to * framesPerBucket(levelIndex) / snapshot.sampleRate) * 1000
      : durationMs;

  return {
    level: levelIndex,
    durationMs,
    startMs: actualStartMs,
    endMs: Math.min(durationMs, actualEndMs),
    buckets,
  };
}
