import { describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { FilePeakStore, MemoryPeakStore, PeakSnapshot } from '../src/store.js';
import { StreamingPeakBuilder } from '../src/builder.js';

function makeSnapshot(key: string, frames = 10_000): PeakSnapshot {
  const builder = new StreamingPeakBuilder(48_000, 2, { baseBlockFrames: 256 });
  const pcm = new Int16Array(frames * 2);
  for (let i = 0; i < pcm.length; i++) pcm[i] = ((i * 7919) % 20001) - 10000;
  builder.push(pcm);
  return new PeakSnapshot(key, builder.finish(), 1_700_000_000_000, 123_456);
}

describe('peak snapshot persistence', () => {
  it('round-trips a pyramid through the file store', async () => {
    const dir = join(tmpdir(), `peaks-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(dir, { recursive: true });
    try {
      const store = new FilePeakStore(dir);
      const snapshot = makeSnapshot('recording-abc');
      await store.save(snapshot);

      const loaded = await store.load({ key: 'recording-abc' });
      expect(loaded).toBeDefined();
      expect(loaded!.totalFrames).toBe(snapshot.totalFrames);
      expect(loaded!.sampleRate).toBe(48_000);
      expect(loaded!.channels).toBe(2);
      expect(loaded!.sourceMtimeMs).toBe(1_700_000_000_000);
      expect(loaded!.levels.length).toBe(snapshot.levels.length);
      for (let level = 0; level < snapshot.levels.length; level++) {
        expect(Array.from(loaded!.levels[level].mins)).toEqual(
          Array.from(snapshot.levels[level].mins),
        );
        expect(Array.from(loaded!.levels[level].maxs)).toEqual(
          Array.from(snapshot.levels[level].maxs),
        );
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('treats stale cache as a miss when source mtime/size differ', async () => {
    const store = new MemoryPeakStore();
    const snapshot = makeSnapshot('k');
    await store.save(snapshot);
    const loaded = await store.load({ key: 'k' });
    expect(loaded!.matches({ key: 'k', mtimeMs: 1_700_000_000_001 })).toBe(false);
    expect(loaded!.matches({ key: 'k', mtimeMs: 1_700_000_000_000 })).toBe(true);
  });

  it('rejects truncated and corrupted cache files (no half-built data)', async () => {
    const dir = join(tmpdir(), `peaks-bad-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    try {
      const store = new FilePeakStore(dir);
      const snapshot = makeSnapshot('bad');
      await store.save(snapshot);

      const target = join(dir, 'bad.pwpk');

      // 1) 截断（模拟写入中途崩溃）
      const { readFile } = await import('node:fs/promises');
      const original = await readFile(target);
      await writeFile(target, original.subarray(0, Math.floor(original.length / 2)));
      await expect(store.load({ key: 'bad' })).rejects.toThrow();

      // 原文件已被隔离，再读返回 undefined
      const second = await store.load({ key: 'bad' }).catch(() => undefined);
      expect(second).toBeUndefined();

      // 2) 翻转一个载荷字节：CRC 不匹配
      const dir2 = join(tmpdir(), `peaks-bad2-${Date.now()}`);
      await mkdir(dir2, { recursive: true });
      const store2 = new FilePeakStore(dir2);
      await store2.save(makeSnapshot('bad'));
      const target2 = join(dir2, 'bad.pwpk');
      const copy = Buffer.from(await readFile(target2));
      copy[copy.length - 20] ^= 0xff;
      await writeFile(target2, copy);
      await expect(store2.load({ key: 'bad' })).rejects.toThrow(/CRC/);
      await rm(dir2, { recursive: true, force: true });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
