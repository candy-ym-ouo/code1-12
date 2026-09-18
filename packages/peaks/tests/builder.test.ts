import { describe, expect, it } from 'vitest';
import { StreamingPeakBuilder } from '../src/builder.js';

/** 生成简单的交错 PCM：第 i 帧的样本随帧号正弦变化，多声道幅度不同。 */
function sineFrames(frameCount: number, channels: number): Int16Array {
  const out = new Int16Array(frameCount * channels);
  for (let frame = 0; frame < frameCount; frame++) {
    for (let channel = 0; channel < channels; channel++) {
      out[frame * channels + channel] = Math.round(
        10000 * Math.sin((frame / frameCount) * Math.PI * 4 + channel) *
          (1 - channel * 0.3),
      );
    }
  }
  return out;
}

/** 与构建器无关的参考实现：直接在完整样本上分块取极值。 */
function referenceBlocks(samples: Int16Array, channels: number, blockFrames: number) {
  const frameCount = Math.floor(samples.length / channels);
  const blockCount = Math.ceil(frameCount / blockFrames);
  const mins = new Int16Array(blockCount);
  const maxs = new Int16Array(blockCount);
  for (let block = 0; block < blockCount; block++) {
    let min = 32767;
    let max = -32768;
    const from = block * blockFrames * channels;
    const to = Math.min((block + 1) * blockFrames, frameCount) * channels;
    for (let i = from; i < to; i++) {
      if (samples[i] < min) min = samples[i];
      if (samples[i] > max) max = samples[i];
    }
    mins[block] = min;
    maxs[block] = max;
  }
  return { mins, maxs };
}

describe('StreamingPeakBuilder', () => {
  it('builds level-0 peaks equal to a direct reference computation', () => {
    const samples = sineFrames(10_000, 2);
    const builder = new StreamingPeakBuilder(48_000, 2, { baseBlockFrames: 256 });
    builder.push(samples);
    const pyramid = builder.finish();

    expect(pyramid.totalFrames).toBe(10_000);
    const expected = referenceBlocks(samples, 2, 256);
    expect(Array.from(pyramid.levels[0].mins)).toEqual(Array.from(expected.mins));
    expect(Array.from(pyramid.levels[0].maxs)).toEqual(Array.from(expected.maxs));
  });

  it('produces identical output regardless of chunk boundaries (incl. odd sizes)', () => {
    const samples = sineFrames(5000, 1);
    const chunks = [1, 3, 7, 255, 256, 257, 1000, 4096];

    for (const chunkSize of chunks) {
      const builder = new StreamingPeakBuilder(44_100, 1, { baseBlockFrames: 100 });
      for (let offset = 0; offset < samples.length; offset += chunkSize) {
        builder.push(samples.subarray(offset, offset + chunkSize));
      }
      const pyramid = builder.finish();
      const expected = referenceBlocks(samples, 1, 100);
      expect(Array.from(pyramid.levels[0].mins)).toEqual(Array.from(expected.mins));
      expect(Array.from(pyramid.levels[0].maxs)).toEqual(Array.from(expected.maxs));
      expect(pyramid.totalFrames).toBe(5000);
    }
  });

  it('builds the mipmap pyramid where each parent is the union of two children', () => {
    const samples = sineFrames(10_000, 1);
    const builder = new StreamingPeakBuilder(8000, 1, { baseBlockFrames: 64 });
    builder.push(samples);
    const pyramid = builder.finish();

    expect(pyramid.levels.length).toBeGreaterThan(1);
    for (let level = 0; level < pyramid.levels.length - 1; level++) {
      const child = pyramid.levels[level];
      const parent = pyramid.levels[level + 1];
      const expectedParentCount = Math.ceil(child.mins.length / 2);
      expect(parent.mins.length).toBe(expectedParentCount);
      for (let p = 0; p < parent.mins.length; p++) {
        const leftMin = child.mins[p * 2];
        const rightMin = child.mins[p * 2 + 1] ?? leftMin;
        const leftMax = child.maxs[p * 2];
        const rightMax = child.maxs[p * 2 + 1] ?? leftMax;
        expect(parent.mins[p]).toBe(Math.min(leftMin, rightMin));
        expect(parent.maxs[p]).toBe(Math.max(leftMax, rightMax));
      }
    }
  });

  it('handles input shorter than one block and empty input', () => {
    const small = new StreamingPeakBuilder(48_000, 2, { baseBlockFrames: 256 });
    small.push(sineFrames(3, 2));
    const smallPyramid = small.finish();
    expect(smallPyramid.totalFrames).toBe(3);
    expect(smallPyramid.levels[0].mins.length).toBe(1);

    const empty = new StreamingPeakBuilder(48_000, 1).finish();
    expect(empty.totalFrames).toBe(0);
    expect(empty.levels.length).toBe(1);
  });

  it('rejects invalid construction parameters', () => {
    expect(() => new StreamingPeakBuilder(0, 1)).toThrow();
    expect(() => new StreamingPeakBuilder(48_000, 0)).toThrow();
    expect(() => new StreamingPeakBuilder(48_000, 1, { baseBlockFrames: 0 })).toThrow();
  });
});
