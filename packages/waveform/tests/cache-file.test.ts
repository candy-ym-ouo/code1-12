import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildPyramid,
  CacheCorruptError,
  Crc32,
  loadCacheFile,
  PeakAccumulator,
  saveCacheFile,
  type WaveformSnapshot,
} from '../src/index.js';

function makeSnapshot(): WaveformSnapshot {
  const acc = new PeakAccumulator(8);
  for (let i = 0; i < 10_000; i += 1) acc.push(Math.sin(i * 0.1));
  return buildPyramid(acc.finish(), 10_000, 44_100, 2, 8);
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'wvpk-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const SOURCE = { size: 123_456, mtimeMs: 1_700_000_000_123.456 };

describe('WVPK 缓存文件', () => {
  it('保存后原样加载，所有层级逐值一致', async () => {
    const snap = makeSnapshot();
    const file = path.join(dir, 'a.wvpk');
    await saveCacheFile(file, snap, SOURCE);
    const loaded = await loadCacheFile(file);

    expect(loaded.source).toEqual(SOURCE);
    expect(loaded.snapshot.sampleRate).toBe(44_100);
    expect(loaded.snapshot.channels).toBe(2);
    expect(loaded.snapshot.totalFrames).toBe(10_000);
    expect(loaded.snapshot.samplesPerPeak).toBe(8);
    expect(loaded.snapshot.levels.length).toBe(snap.levels.length);
    snap.levels.forEach((level, li) => {
      expect(Array.from(loaded.snapshot.levels[li]!.min)).toEqual(Array.from(level.min));
      expect(Array.from(loaded.snapshot.levels[li]!.max)).toEqual(Array.from(level.max));
    });
  });

  it('目标路径不存在时自动建目录', async () => {
    const file = path.join(dir, 'nested', 'deep', 'a.wvpk');
    await saveCacheFile(file, makeSnapshot(), SOURCE);
    const loaded = await loadCacheFile(file);
    expect(loaded.snapshot.totalFrames).toBe(10_000);
  });

  it('并发保存互不覆盖，最终文件完整（临时名随机 + rename）', async () => {
    const a = makeSnapshot();
    const file = path.join(dir, 'shared.wvpk');
    const acc = new PeakAccumulator(8);
    for (let i = 0; i < 5_000; i += 1) acc.push(Math.cos(i * 0.07));
    const bSnap = buildPyramid(acc.finish(), 5_000, 22_050, 1, 8);

    await Promise.all([
      saveCacheFile(file, a, { ...SOURCE, size: 1 }),
      saveCacheFile(file, bSnap, { ...SOURCE, size: 2 }),
    ]);
    const loaded = await loadCacheFile(file);
    expect([10_000, 5_000]).toContain(loaded.snapshot.totalFrames);
    expect(loaded.snapshot.levels[0]!.min.length).toBeGreaterThan(0);
  });

  it('保存后不留临时文件', async () => {
    const file = path.join(dir, 'a.wvpk');
    await saveCacheFile(file, makeSnapshot(), SOURCE);
    const { readdir } = await import('node:fs/promises');
    const files = await readdir(dir);
    expect(files.filter((f) => f.endsWith('.tmp') || f.includes('.tmp-'))).toEqual([]);
  });

  it('CRC 不匹配判定损坏', async () => {
    const file = path.join(dir, 'a.wvpk');
    await saveCacheFile(file, makeSnapshot(), SOURCE);
    const bytes = await readFile(file);
    // 翻转 payload 中间一个字节
    bytes[bytes.length - 50] = bytes[bytes.length - 50]! ^ 0xff;
    await import('node:fs/promises').then((fs) => fs.writeFile(file, bytes));
    await expect(loadCacheFile(file)).rejects.toBeInstanceOf(CacheCorruptError);
  });

  it('magic/版本错误判定损坏', async () => {
    const file = path.join(dir, 'a.wvpk');
    await saveCacheFile(file, makeSnapshot(), SOURCE);
    const bytes = await readFile(file);
    bytes[0] = 0x58; // 'X'
    await import('node:fs/promises').then((fs) => fs.writeFile(file, bytes));
    await expect(loadCacheFile(file)).rejects.toBeInstanceOf(CacheCorruptError);
  });

  it('截断文件判定损坏而不是返回部分层级', async () => {
    const file = path.join(dir, 'a.wvpk');
    await saveCacheFile(file, makeSnapshot(), SOURCE);
    const bytes = await readFile(file);
    await import('node:fs/promises').then((fs) => fs.writeFile(file, bytes.subarray(0, bytes.length - 300)));
    await expect(loadCacheFile(file)).rejects.toBeInstanceOf(CacheCorruptError);
  });

  it('Crc32 与已知向量一致', () => {
    expect(new Crc32().update(Buffer.from('123456789')).digest()).toBe(0xcbf43926);
  });
});
