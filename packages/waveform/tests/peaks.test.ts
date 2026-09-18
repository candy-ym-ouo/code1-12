import { describe, expect, it } from 'vitest';
import {
  aggregateLevel,
  buildPyramid,
  PeakAccumulator,
  quantizePeak,
  readPeaks,
  QUANT_MAX,
  QUANT_MIN,
  type WaveformLevel,
} from '../src/peaks.js';

function levelFrom(values: Array<[number, number]>): WaveformLevel {
  const min = new Int16Array(values.length);
  const max = new Int16Array(values.length);
  values.forEach(([lo, hi], i) => {
    min[i] = lo;
    max[i] = hi;
  });
  return { min, max };
}

describe('quantizePeak', () => {
  it('饱和处理越界与非有限值', () => {
    expect(quantizePeak(1.5)).toBe(QUANT_MAX);
    expect(quantizePeak(-1.5)).toBe(QUANT_MIN);
    expect(quantizePeak(Number.POSITIVE_INFINITY)).toBe(QUANT_MAX);
    expect(quantizePeak(Number.NaN)).toBe(QUANT_MIN);
  });

  it('远离零方向取整，微小峰值不被抹零', () => {
    const q = quantizePeak(0.5 / QUANT_MAX);
    expect(q).toBe(1);
    expect(quantizePeak(-0.5 / QUANT_MAX)).toBe(-1);
  });
});

describe('PeakAccumulator', () => {
  it('按 samplesPerPeak 求每桶 min/max，末桶为真实部分桶而非零填充', () => {
    const acc = new PeakAccumulator(4);
    const samples = [0.1, -0.2, 0.5, 0.0, 0.3, -0.8];
    for (const s of samples) acc.push(s);
    const level = acc.finish();
    expect(level.min.length).toBe(2);
    expect(level.max[0]).toBe(quantizePeak(0.5));
    expect(level.min[0]).toBe(quantizePeak(-0.2));
    // 部分桶（2 个采样）：max 0.3 / min -0.8，而不是 0。
    expect(level.max[1]).toBe(quantizePeak(0.3));
    expect(level.min[1]).toBe(quantizePeak(-0.8));
    expect(acc.totalFrames).toBe(6);
  });

  it('空输入产出零层', () => {
    const level = new PeakAccumulator(4).finish();
    expect(level.min.length).toBe(0);
    expect(level.max.length).toBe(0);
  });

  it('拒绝非法 samplesPerPeak', () => {
    expect(() => new PeakAccumulator(0)).toThrow();
    expect(() => new PeakAccumulator(1.5)).toThrow();
  });

  it('分块容量边界不丢桶', () => {
    const acc = new PeakAccumulator(2, 3);
    for (let i = 0; i < 20; i += 1) acc.push((i % 5) / 5);
    const level = acc.finish();
    expect(level.min.length).toBe(10);
  });
});

describe('aggregateLevel / buildPyramid', () => {
  it('相邻两对峰值精确聚合', () => {
    const l0 = levelFrom([
      [-10, 5],
      [-4, 8],
      [-20, 2],
      [-2, 9],
    ]);
    const l1 = aggregateLevel(l0);
    expect(Array.from(l1.min)).toEqual([-10, -20]);
    expect(Array.from(l1.max)).toEqual([8, 9]);
  });

  it('奇数桶向下取整，金字塔逐层减半直到单层', () => {
    const acc = new PeakAccumulator(1);
    for (let i = 0; i < 9; i += 1) acc.push(0);
    const snap = buildPyramid(acc.finish(), 9, 100, 1, 1);
    expect(snap.levels.map((l) => l.min.length)).toEqual([9, 4, 2, 1]);
  });

  it('聚合无损：粗层极值不会超过其覆盖细桶的真实范围', () => {
    const acc = new PeakAccumulator(3);
    for (let i = 0; i < 300; i += 1) {
      acc.push(Math.sin(i * 0.3) * (i % 7 === 0 ? 1 : 0.4));
    }
    const snap = buildPyramid(acc.finish(), 300, 1000, 1, 3);
    const l0 = snap.levels[0]!;
    const l2 = snap.levels[2]!;
    for (let i = 0; i < l2.min.length; i += 1) {
      const base = i * 4;
      let lo = QUANT_MAX;
      let hi = QUANT_MIN;
      for (let j = base; j < base + 4 && j < l0.min.length; j += 1) {
        lo = Math.min(lo, l0.min[j]!);
        hi = Math.max(hi, l0.max[j]!);
      }
      expect(l2.min[i]).toBe(lo);
      expect(l2.max[i]).toBe(hi);
    }
  });
});

describe('readPeaks', () => {
  function snapshot() {
    // 1000 个桶，samplesPerPeak=10，sampleRate=100 → 每桶 100ms。
    const acc = new PeakAccumulator(10);
    for (let i = 0; i < 10_000; i += 1) {
      const bucket = Math.floor(i / 10);
      acc.push(bucket % 2 === 0 ? 0.5 : -0.5);
    }
    return buildPyramid(acc.finish(), 10_000, 100, 1, 10);
  }

  it('输出桶数严格等于 width，值归一化到 [-1,1]', () => {
    const result = readPeaks(snapshot(), { width: 128 });
    expect(result.buckets).toHaveLength(128);
    for (const b of result.buckets) {
      expect(b.min).toBeGreaterThanOrEqual(-1);
      expect(b.max).toBeLessThanOrEqual(1);
      expect(b.min).toBeLessThanOrEqual(b.max);
    }
  });

  it('width 大于总桶数时用最细层，输出仍为 width 且极值不丢', () => {
    const result = readPeaks(snapshot(), { width: 5000 });
    expect(result.level).toBe(0);
    expect(result.buckets).toHaveLength(5000);
    // 信号只有 ±0.5，任何桶都不应出现超过真实范围的值。
    for (const b of result.buckets) {
      expect(b.max).toBeLessThanOrEqual(0.5 + 1 / QUANT_MAX);
      expect(b.min).toBeGreaterThanOrEqual(-0.5 - 1 / QUANT_MAX);
    }
  });

  it('自动选择最粗的够用层级', () => {
    const snap = snapshot();
    // 全长 10s=10000ms；width=100 需要范围内 >=100 桶：
    // level 0 每桶 100ms 共 1000 桶；level 3 每桶 800ms 共 125 桶；level 4 共 62 桶不够。
    const result = readPeaks(snap, { width: 100 });
    expect(result.level).toBe(3);
  });

  it('时间范围裁剪：只读 [startMs, endMs) 并返回实际边界', () => {
    const snap = snapshot();
    const result = readPeaks(snap, { width: 10, startMs: 1000, endMs: 2000 });
    expect(result.buckets).toHaveLength(10);
    expect(result.startMs).toBe(1000);
    expect(result.endMs).toBe(2000);
    // 该区间全部是桶 10..19：奇数桶(11,13,…)在区间内，负峰必须出现。
    const hasNegative = result.buckets.some((b) => b.min < 0);
    expect(hasNegative).toBe(true);
  });

  it('显式指定 level 时优先使用', () => {
    const snap = snapshot();
    const result = readPeaks(snap, { width: 10, level: 1 });
    expect(result.level).toBe(1);
  });

  it('拒绝非法 width', () => {
    const snap = snapshot();
    expect(() => readPeaks(snap, { width: 0 })).toThrow();
    expect(() => readPeaks(snap, { width: -1 })).toThrow();
    expect(() => readPeaks(snap, { width: 100_001 })).toThrow();
  });
});
