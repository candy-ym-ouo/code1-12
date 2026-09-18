import { describe, expect, it } from 'vitest';
import { StreamingPeakBuilder } from '../src/builder.js';
import { readWindow, chooseLevel } from '../src/select.js';
import type { PeakPyramid } from '../src/types.js';

/** 构造确定性金字塔：帧 i 的值 = i 的函数，直接以每帧一个样本喂入构建器。 */
function buildPyramid(frameCount: number, baseBlockFrames = 100): PeakPyramid {
  const builder = new StreamingPeakBuilder(1000, 1, { baseBlockFrames });
  const chunk = new Int16Array(1000);
  for (let start = 0; start < frameCount; start += 1000) {
    for (let i = 0; i < Math.min(1000, frameCount - start); i++) {
      // 在 -10000..10000 间三角波，保证每个块都有明显的 min/max。
      const phase = ((start + i) % 400) / 400;
      chunk[i] = Math.round(-10000 + Math.abs(phase - 0.5) * 40000);
    }
    builder.push(chunk.subarray(0, Math.min(1000, frameCount - start)));
  }
  return builder.finish();
}

describe('readWindow', () => {
  it('returns the requested bucket count and stays within the frame range', () => {
    const pyramid = buildPyramid(100_000);
    const win = readWindow(pyramid, { startFrame: 10_000, endFrame: 20_000, buckets: 200 });

    expect(win.mins.length).toBe(win.bucketCount);
    expect(win.maxs.length).toBe(win.bucketCount);
    expect(win.startFrame).toBe(10_000);
    expect(win.endFrame).toBe(20_000);
    expect(win.bucketCount).toBeLessThanOrEqual(200);
    for (const v of win.mins) expect(v).toBeGreaterThanOrEqual(-10000);
    for (const v of win.maxs) expect(v).toBeLessThanOrEqual(10000);
  });

  it('picks a coarser level when the requested resolution is low', () => {
    const pyramid = buildPyramid(1_000_000, 100);
    const fine = readWindow(pyramid, { buckets: 100_000 });
    const coarse = readWindow(pyramid, { buckets: 10 });
    expect(coarse.level).toBeGreaterThan(fine.level);
    expect(coarse.framesPerBucket).toBeGreaterThan(fine.framesPerBucket);
  });

  it('never fabricates extrema outside the source peaks: output bounds hold', () => {
    const pyramid = buildPyramid(50_000, 100);
    const win = readWindow(pyramid, { startFrame: 5000, endFrame: 45_000, buckets: 333 });

    // 每个输出桶的极值必然被其覆盖的第 0 层桶包含（粗化只做极值合并）。
    const framesPerBucket = win.framesPerBucket;
    for (let bucket = 0; bucket < win.bucketCount; bucket++) {
      const start = win.startFrame + bucket * framesPerBucket;
      const end = Math.min(win.startFrame + (bucket + 1) * framesPerBucket, win.endFrame);
      const firstBlock = Math.floor(start / pyramid.baseBlockFrames);
      const lastBlock = Math.ceil(end / pyramid.baseBlockFrames);
      let refMin = 32767;
      let refMax = -32768;
      const base = pyramid.levels[0];
      for (let b = firstBlock; b < lastBlock && b < base.mins.length; b++) {
        refMin = Math.min(refMin, base.mins[b]);
        refMax = Math.max(refMax, base.maxs[b]);
      }
      expect(win.mins[bucket]).toBeGreaterThanOrEqual(refMin);
      expect(win.maxs[bucket]).toBeLessThanOrEqual(refMax);
    }
  });

  it('clamps ranges and returns an empty window for zero span', () => {
    const pyramid = buildPyramid(1000, 100);
    const clamped = readWindow(pyramid, { startFrame: -50, endFrame: 10 ** 9, buckets: 10 });
    expect(clamped.startFrame).toBe(0);
    expect(clamped.endFrame).toBe(1000);

    const empty = readWindow(pyramid, { startFrame: 100, endFrame: 100 });
    expect(empty.bucketCount).toBe(0);
    expect(empty.mins.length).toBe(0);
  });

  it('chooseLevel respects the available level count', () => {
    const pyramid = buildPyramid(350, 100);
    expect(chooseLevel(pyramid, 350, 1)).toBe(pyramid.levels.length - 1);
    expect(chooseLevel(pyramid, 100, 1)).toBe(0);
    expect(() => chooseLevel(pyramid, 100, 0)).toThrow();
  });

  it('propagates the stale flag', () => {
    const pyramid = buildPyramid(1000, 100);
    expect(readWindow(pyramid).stale).toBe(false);
    expect(readWindow(pyramid, { stale: true }).stale).toBe(true);
  });
});
