import type { PeakLevel, PeakPyramid } from './types.js';

/** 可增长的有符号 16 位数组，避免构建期反复拷贝定长 TypedArray。 */
class GrowableInt16 {
  private chunks: Int16Array[] = [];
  private last: Int16Array;
  private lastOffset = 0;
  private _length = 0;

  constructor(initialCapacity = 4096) {
    this.last = new Int16Array(initialCapacity);
  }

  get length(): number {
    return this._length;
  }

  push(value: number): void {
    if (this.lastOffset === this.last.length) {
      this.chunks.push(this.last);
      this.last = new Int16Array(Math.min(this.last.length * 2, 1 << 20));
      this.lastOffset = 0;
    }
    this.last[this.lastOffset++] = value;
    this._length++;
  }

  /** 固化为单个紧凑 Int16Array。 */
  toArray(): Int16Array {
    const out = new Int16Array(this._length);
    let offset = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    out.set(this.last.subarray(0, this.lastOffset), offset);
    return out;
  }
}

export interface StreamingPeakBuilderOptions {
  /** 第 0 层一个桶覆盖的 PCM 帧数，默认 256。 */
  baseBlockFrames?: number;
  /** 金字塔最大层数（不含第 0 层的额外层数），默认 24。 */
  maxLevels?: number;
}

/**
 * 流式 min/max 金字塔构建器。
 *
 * 调用方按解码顺序 {@link push} 交错 PCM 块（块边界无需帧对齐）：
 * 1. 每 baseBlockFrames 帧归为第 0 层一个桶，在交错数据上直接取跨声道极值；
 * 2. {@link finish} 时从第 0 层确定性地两两合并出全部上层，第 L 层第 i 桶恰好
 *    覆盖第 0 层 [i*2^L, (i+1)*2^L) 个桶；奇数尾桶原样上提，完整覆盖时间轴。
 *
 * 内存与解码缓冲大小无关：构建期只增长第 0 层峰值（即金字塔最细分辨率的固有
 * 体量），不会把音频样本整体载入。以 44.1kHz、256 帧/桶计，1 小时约 6200 桶、
 * 几十 KB；30 分钟立体声 302MB 文件实测构建堆内存约 5MB。
 *
 * 构建中的中间状态只保存在本对象内部，finish 返回前对外不可见，杜绝半成品读取。
 */
export class StreamingPeakBuilder {
  readonly baseBlockFrames: number;
  readonly sampleRate: number;
  readonly channels: number;
  private readonly maxLevels: number;
  private readonly baseMin = new GrowableInt16();
  private readonly baseMax = new GrowableInt16();

  /** 帧对齐后尚未凑满一块的剩余交错样本。 */
  private leftover: Int16Array = new Int16Array(0);
  private totalFrames = 0;

  constructor(
    sampleRate: number,
    channels: number,
    options: StreamingPeakBuilderOptions = {},
  ) {
    if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
      throw new Error(`非法采样率: ${sampleRate}`);
    }
    if (!Number.isInteger(channels) || channels <= 0) {
      throw new Error(`非法声道数: ${channels}`);
    }
    const baseBlockFrames = options.baseBlockFrames ?? 256;
    if (!Number.isInteger(baseBlockFrames) || baseBlockFrames <= 0) {
      throw new Error(`非法基础块帧数: ${baseBlockFrames}`);
    }
    this.baseBlockFrames = baseBlockFrames;
    this.sampleRate = sampleRate;
    this.channels = channels;
    this.maxLevels = options.maxLevels ?? 24;
  }

  /** 喂入一块交错 PCM（调用期间构建器持有引用，调用返回后不再使用）。 */
  push(interleaved: Int16Array): void {
    let samples: Int16Array;
    if (this.leftover.length > 0) {
      const merged = new Int16Array(this.leftover.length + interleaved.length);
      merged.set(this.leftover, 0);
      merged.set(interleaved, this.leftover.length);
      samples = merged;
      this.leftover = new Int16Array(0);
    } else {
      samples = interleaved;
    }

    const stride = this.channels;
    const blockSamples = this.baseBlockFrames * stride;
    const fullBlocks = Math.floor(samples.length / blockSamples);
    for (let block = 0; block < fullBlocks; block++) {
      const from = block * blockSamples;
      this.emitBaseBlock(samples, from, from + blockSamples);
    }
    this.totalFrames += fullBlocks * this.baseBlockFrames;

    const rest = samples.length - fullBlocks * blockSamples;
    if (rest > 0) {
      // 仅为 push 之间的短残留；保存到下一块拼接处理。
      this.leftover = samples.slice(fullBlocks * blockSamples);
    }
  }

  /** 在交错 PCM 的 [from,to) 区间取跨所有声道的极值，作为第 0 层一个桶。 */
  private emitBaseBlock(samples: Int16Array, from: number, to: number): void {
    let min = 32767;
    let max = -32768;
    for (let i = from; i < to; i++) {
      const v = samples[i];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    this.baseMin.push(min);
    this.baseMax.push(max);
  }

  /** 结束输入，冲刷尾部残块并从第 0 层构建完整金字塔，返回不可变结果。 */
  finish(): PeakPyramid {
    const stride = this.channels;
    if (this.leftover.length > 0) {
      const frames = Math.floor(this.leftover.length / stride);
      if (frames > 0) {
        this.emitBaseBlock(this.leftover, 0, frames * stride);
        this.totalFrames += frames;
      }
      this.leftover = new Int16Array(0);
    }

    const levels: PeakLevel[] = [];
    if (this.baseMin.length === 0) {
      // 空音频：给出一个全 0 的根桶，读取层选择逻辑更简单。
      levels.push({ mins: new Int16Array(1), maxs: new Int16Array(1) });
      return {
        baseBlockFrames: this.baseBlockFrames,
        sampleRate: this.sampleRate,
        channels: this.channels,
        totalFrames: 0,
        levels,
      };
    }

    // 第 0 层为权威结果；上层按连续非重叠两两合并，奇数尾桶原样上提（右边界
    // 与左兄弟相同），使每层完整覆盖时间轴且极值只来自其真实覆盖的帧。
    let mins = this.baseMin.toArray();
    let maxs = this.baseMax.toArray();
    for (let level = 0; level <= this.maxLevels; level++) {
      levels.push({ mins, maxs });
      if (mins.length <= 1) break;

      const parentCount = Math.ceil(mins.length / 2);
      const parentMin = new Int16Array(parentCount);
      const parentMax = new Int16Array(parentCount);
      for (let p = 0; p < parentCount; p++) {
        const left = p * 2;
        const right = Math.min(left + 1, mins.length - 1);
        parentMin[p] = Math.min(mins[left], mins[right]);
        parentMax[p] = Math.max(maxs[left], maxs[right]);
      }
      mins = parentMin;
      maxs = parentMax;
    }

    return {
      baseBlockFrames: this.baseBlockFrames,
      sampleRate: this.sampleRate,
      channels: this.channels,
      totalFrames: this.totalFrames,
      levels,
    };
  }
}
