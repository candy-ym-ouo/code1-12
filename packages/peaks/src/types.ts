/**
 * 波形峰值缓存：公共类型定义。
 *
 * 峰值数据是一棵 min/max 金字塔（mipmap）：
 * - 第 0 层每个桶覆盖 {@link PeakPyramid.baseBlockFrames} 个 PCM 帧，记录其中所有
 *   声道所有样本的最小值/最大值（统一归一化到有符号 16 位整数范围）；
 * - 第 L>0 层的每个桶由第 L-1 层相邻两个桶合并而来，因此覆盖帧数翻倍、桶数减半；
 * - 读取时按「帧范围 + 期望桶数」选择最接近的一层，再做二次聚合，支持任意分辨率。
 */

/** 金字塔中的一层，mins/maxs 按桶下标一一对应，使用 Int16 紧凑存储。 */
export interface PeakLevel {
  mins: Int16Array;
  maxs: Int16Array;
}

/** 构建完成、不可变的 min/max 金字塔。 */
export interface PeakPyramid {
  /** 第 0 层一个桶覆盖的 PCM 帧数。 */
  baseBlockFrames: number;
  /** PCM 采样率（Hz）。 */
  sampleRate: number;
  /** 声道数（构建时已跨声道取极值，仅作元信息保留）。 */
  channels: number;
  /** 音频总帧数（每声道的样本数）。 */
  totalFrames: number;
  /** 从粗到细的层级，levels[0] 为最高分辨率层。 */
  levels: PeakLevel[];
}

/** 一次多分辨率读取的结果。 */
export interface PeakWindow {
  /** 输出桶数量，mins/maxs 的长度均等于该值。 */
  bucketCount: number;
  /** 每个输出桶覆盖的 PCM 帧数。 */
  framesPerBucket: number;
  /** 输出窗口起点（PCM 帧）。 */
  startFrame: number;
  /** 输出窗口终点（PCM 帧，不含）。 */
  endFrame: number;
  /** 实际选用的金字塔层级。 */
  level: number;
  /** 各桶最小值，范围 -32768..32767。 */
  mins: Int16Array;
  /** 各桶最大值，范围 -32768..32767。 */
  maxs: Int16Array;
  /** 本次读取是否基于重建中的旧快照（stale-while-revalidate）。 */
  stale: boolean;
}

/** 音频流元信息。 */
export interface AudioInfo {
  sampleRate: number;
  channels: number;
  /** 音频总帧数；无法从容器/解码器获知时为 undefined。 */
  totalFrames?: number;
}

/** 解码后的音频流：按块产出交错（interleaved）的有符号 16 位 PCM。 */
export interface AudioStream extends AudioInfo {
  /** PCM 数据块迭代器；每块是声道交错的 Int16Array，块边界不必帧对齐。 */
  [Symbol.asyncIterator](): AsyncIterator<Int16Array>;
}

/** 音频来源的稳定标识与定位信息。 */
export interface AudioSourceMeta {
  /**
   * 缓存键，同一音频必须稳定（建议使用录音 ID 或文件绝对路径的哈希）。
   * 服务内部以它合并并发重建、隔离不同音频的缓存。
   */
  key: string;
  /** 文件最后修改时间（毫秒），用于识别磁盘缓存是否过期。 */
  mtimeMs?: number;
  /** 文件字节数，用于识别磁盘缓存是否过期。 */
  sizeBytes?: number;
}
