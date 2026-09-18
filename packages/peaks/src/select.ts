import type { PeakPyramid, PeakWindow } from './types.js';

export interface ReadWindowOptions {
  /** 窗口起点（PCM 帧），默认 0。 */
  startFrame?: number;
  /** 窗口终点（PCM 帧，不含），默认音频总帧数。 */
  endFrame?: number;
  /** 期望输出桶数（波形画布上的像素列数），默认 1000。 */
  buckets?: number;
  /** 标记本次读取基于旧快照（stale-while-revalidate）。 */
  stale?: boolean;
}

/**
 * 选择能够以不超过 buckets 个桶覆盖请求窗口的最细金字塔层。
 * 第 level 层每个桶覆盖 baseBlockFrames * 2^level 帧。
 */
export function chooseLevel(pyramid: PeakPyramid, spanFrames: number, buckets: number): number {
  if (buckets <= 0) throw new Error(`期望桶数必须为正数: ${buckets}`);
  const wantedFramesPerBucket = Math.max(1, Math.ceil(spanFrames / buckets));
  let level = 0;
  while (
    level < pyramid.levels.length - 1 &&
    pyramid.baseBlockFrames * 2 ** level < wantedFramesPerBucket
  ) {
    level++;
  }
  return level;
}

/**
 * 多分辨率窗口读取。
 *
 * 选取最接近目标分辨率的一层，按桶中点把极值重新聚合为恰好 buckets 个输出桶；
 * 请求范围内没有覆盖到的输出桶沿用相邻值（前向/后向填充），避免渲染空洞。
 * 本函数只读取不可变快照，不做任何异步状态变更。
 */
export function readWindow(
  pyramid: PeakPyramid,
  options: ReadWindowOptions = {},
): PeakWindow {
  const stale = options.stale ?? false;
  const totalFrames = pyramid.totalFrames;
  const startFrame = Math.max(0, Math.floor(options.startFrame ?? 0));
  const endFrameRaw = options.endFrame ?? totalFrames;
  const endFrame = Number.isFinite(endFrameRaw)
    ? Math.max(startFrame, Math.min(totalFrames, Math.floor(endFrameRaw)))
    : totalFrames;
  const buckets = Math.max(1, Math.floor(options.buckets ?? 1000));
  const span = Math.max(0, endFrame - startFrame);

  if (span === 0) {
    return {
      bucketCount: 0,
      framesPerBucket: 0,
      startFrame,
      endFrame,
      level: 0,
      mins: new Int16Array(0),
      maxs: new Int16Array(0),
      stale,
    };
  }

  const level = chooseLevel(pyramid, span, buckets);
  const framesPerPeak = pyramid.baseBlockFrames * 2 ** level;
  const peakMins = pyramid.levels[level].mins;
  const peakMaxs = pyramid.levels[level].maxs;

  // 每多少个该层桶聚合成一个输出桶（至少 1，避免降采样不足时丢信息）。
  const grouping = Math.max(1, Math.ceil(span / buckets / framesPerPeak));
  const framesPerBucket = framesPerPeak * grouping;
  const bucketCount = Math.min(buckets, Math.ceil(span / framesPerBucket));

  const mins = new Int16Array(bucketCount);
  const maxs = new Int16Array(bucketCount);
  const filled = new Uint8Array(bucketCount);

  const firstPeak = Math.floor(startFrame / framesPerPeak);
  const lastPeakExclusive = Math.ceil(endFrame / framesPerPeak);
  for (let peakIndex = firstPeak; peakIndex < lastPeakExclusive; peakIndex++) {
    if (peakIndex >= peakMins.length) break;
    // 以桶中点决定归属，使边界处的极值只计入一个输出桶。
    const center = peakIndex * framesPerPeak + framesPerPeak / 2;
    const bucketIndex = Math.floor((center - startFrame) / framesPerBucket);
    if (bucketIndex < 0 || bucketIndex >= bucketCount) continue;
    const min = peakMins[peakIndex];
    const max = peakMaxs[peakIndex];
    if (!filled[bucketIndex]) {
      mins[bucketIndex] = min;
      maxs[bucketIndex] = max;
      filled[bucketIndex] = 1;
    } else {
      if (min < mins[bucketIndex]) mins[bucketIndex] = min;
      if (max > maxs[bucketIndex]) maxs[bucketIndex] = max;
    }
  }

  // 填充没有任何峰值覆盖的桶：前向填充首个有效值，之后向后填充。
  let lastMin = 0;
  let lastMax = 0;
  for (let i = 0; i < bucketCount; i++) {
    if (filled[i]) {
      lastMin = mins[i];
      lastMax = maxs[i];
    } else if (i > 0) {
      mins[i] = lastMin;
      maxs[i] = lastMax;
      filled[i] = 1;
    }
  }
  for (let i = bucketCount - 1; i >= 0; i--) {
    if (filled[i]) break;
    // 开头若干空桶：找后面第一个有效值反向填充。
    const nextFilled = filled.findIndex((v, j) => j > i && v === 1);
    if (nextFilled >= 0) {
      mins[i] = mins[nextFilled];
      maxs[i] = maxs[nextFilled];
      filled[i] = 1;
    }
  }

  return {
    bucketCount,
    framesPerBucket,
    startFrame,
    endFrame,
    level,
    mins,
    maxs,
    stale,
  };
}
