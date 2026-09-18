import { mkdtemp, readFile, rm, writeFile, utimes, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PeakCacheService, type FrameHandler } from '../src/index.js';

let dir: string;
let sourceFile: string;
let cacheFile: string;

// 可控解码器：每次调用产生 N 帧，并在"开始/结束"处打点，让测试能在构建中途发请求。
function makeDecoder(frames: number, onStart?: () => void, onDone?: () => void) {
  return vi.fn(async (filePath: string, handler: FrameHandler) => {
    void filePath;
    onStart?.();
    for (let i = 0; i < frames; i += 1) {
      // 每帧让出，构建中途的请求能插入观察 building 状态。
      await new Promise((r) => setImmediate(r));
      handler.onFrame(Math.sin(i * 0.2));
    }
    onDone?.();
    return { decoder: 'wav' as const, sampleRate: 1000, channels: 1, bitsPerSample: 16, sampleFormat: 'pcm16' as const };
  });
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'peak-svc-'));
  sourceFile = path.join(dir, 'source.wav');
  cacheFile = path.join(dir, 'cache.wvpk');
  await writeFile(sourceFile, Buffer.alloc(100));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function service(decode: ReturnType<typeof makeDecoder>, samplesPerPeak = 4) {
  return new PeakCacheService({
    cacheDir: dir,
    samplesPerPeak,
    decode,
    resolveCachePath: () => cacheFile,
  });
}

describe('PeakCacheService 基础语义', () => {
  it('冷启动构建后快照可用，磁盘缓存被原子写出', async () => {
    const decode = makeDecoder(40);
    const svc = service(decode);
    const result = await svc.read('k', sourceFile, { width: 10 });
    expect(decode).toHaveBeenCalledTimes(1);
    expect(result.buckets).toHaveLength(10);
    expect(result.state).toBe('ready');
    expect(result.stale).toBe(false);
    const bytes = await readFile(cacheFile);
    expect(bytes.subarray(0, 4).toString('ascii')).toBe('WVPK');
  });

  it('第二次读取命中内存，不再解码', async () => {
    const decode = makeDecoder(40);
    const svc = service(decode);
    await svc.read('k', sourceFile, { width: 5 });
    await svc.read('k', sourceFile, { width: 20 });
    expect(decode).toHaveBeenCalledTimes(1);
  });

  it('新服务实例从磁盘加载缓存，不触发解码', async () => {
    const decode = makeDecoder(40);
    const svc1 = service(decode);
    await svc1.read('k', sourceFile, { width: 5 });

    const decode2 = makeDecoder(40);
    const svc2 = service(decode2);
    const result = await svc2.read('k', sourceFile, { width: 5 });
    expect(decode2).not.toHaveBeenCalled();
    expect(result.state).toBe('ready');
  });

  it('磁盘缓存中源指纹过期（文件被替换）时必须重建，不返回旧文件的峰值', async () => {
    const svc1 = service(makeDecoder(40));
    await svc1.read('k', sourceFile, { width: 5 });
    await new Promise((r) => setTimeout(r, 20));
    await writeFile(sourceFile, Buffer.alloc(250));

    const decode2 = makeDecoder(16);
    const svc2 = service(decode2);
    const result = await svc2.read('k', sourceFile, { width: 5 });
    expect(decode2).toHaveBeenCalledTimes(1);
    expect(result.state).toBe('ready');
  });

  it('解码失败后状态为 failed 且不产生缓存文件', async () => {
    const failing = vi.fn(async () => {
      throw new Error('boom');
    });
    const svc = service(failing as never);
    await expect(svc.read('k', sourceFile, { width: 5 })).rejects.toThrow('构建失败');
    expect(svc.peek('k').state).toBe('failed');
    await expect(stat(cacheFile)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('失败后下一次请求自动重试', async () => {
    let attempt = 0;
    const decode = vi.fn(async (_f: string, h: FrameHandler) => {
      attempt += 1;
      if (attempt === 1) throw new Error('transient');
      for (let i = 0; i < 16; i += 1) h.onFrame(0.1);
      return { decoder: 'wav' as const, sampleRate: 1000, channels: 1, bitsPerSample: 16, sampleFormat: 'pcm16' as const };
    });
    const svc = service(decode);
    await expect(svc.read('k', sourceFile, { width: 4 })).rejects.toThrow();
    const result = await svc.read('k', sourceFile, { width: 4 });
    expect(decode).toHaveBeenCalledTimes(2);
    expect(result.state).toBe('ready');
  });
});

describe('重建与读取并发：不得返回半成品', () => {
  it('N 个并发冷请求只触发一次解码，全部得到完整且相同的快照', async () => {
    const decode = makeDecoder(80);
    const svc = service(decode);
    const results = await Promise.all(
      Array.from({ length: 12 }, () => svc.read('k', sourceFile, { width: 16 })),
    );
    expect(decode).toHaveBeenCalledTimes(1);
    for (const r of results) {
      expect(r.buckets).toHaveLength(16);
      expect(r.state).toBe('ready');
    }
    const sig = JSON.stringify(results[0]!.buckets);
    for (const r of results) expect(JSON.stringify(r.buckets)).toBe(sig);
  });

  it('重建进行中：默认立即返回旧完整快照并标 stale，而不是部分数据', async () => {
    let phase: 'old' | 'new' = 'old';
    let newBuildStarted = () => undefined;
    let allowFinish = () => undefined;
    const gate = new Promise<void>((resolve) => {
      allowFinish = resolve;
    });
    const decode = vi.fn(async (_f: string, h: FrameHandler) => {
      if (phase === 'old') {
        for (let i = 0; i < 40; i += 1) h.onFrame(0.3);
        return { decoder: 'wav' as const, sampleRate: 1000, channels: 1, bitsPerSample: 16, sampleFormat: 'pcm16' as const };
      }
      newBuildStarted();
      await gate; // 构建保持在途，直到测试显式放行
      for (let i = 0; i < 80; i += 1) h.onFrame(-0.9);
      return { decoder: 'wav' as const, sampleRate: 1000, channels: 1, bitsPerSample: 16, sampleFormat: 'pcm16' as const };
    });
    const svc = service(decode);
    await svc.read('k', sourceFile, { width: 10 });

    // 改变源指纹并切换解码器输出，触发重建。
    await new Promise((r) => setTimeout(r, 20));
    await writeFile(sourceFile, Buffer.alloc(140));
    phase = 'new';
    const started = new Promise<void>((resolve) => {
      newBuildStarted = resolve;
    });

    const rebuildPromise = svc.rebuild('k', sourceFile);
    await started;
    expect(svc.peek('k').state).toBe('building');

    const mid = await svc.read('k', sourceFile, { width: 10, staleWhileRebuild: true });
    expect(mid.stale).toBe(true);
    // 旧内容是 +0.3，绝不能混入第二轮的 -0.9（半成品特征）。
    expect(mid.buckets.every((b) => b.max >= 0.29)).toBe(true);
    expect(mid.buckets.every((b) => b.min >= 0)).toBe(true);

    allowFinish();
    const done = await rebuildPromise;
    expect(done.stale).toBe(false);
    const after = await svc.read('k', sourceFile, { width: 10 });
    expect(after.stale).toBe(false);
    expect(after.buckets.every((b) => b.max <= -0.89)).toBe(true);
  });

  it('staleWhileRebuild:false 时读取等待重建，拿到的是完整新快照', async () => {
    const decode = makeDecoder(40);
    const svc = service(decode);
    await svc.read('k', sourceFile, { width: 10 });
    await new Promise((r) => setTimeout(r, 20));
    await writeFile(sourceFile, Buffer.alloc(140));

    const rebuild = svc.rebuild('k', sourceFile);
    const waited = await svc.read('k', sourceFile, { width: 10, staleWhileRebuild: false });
    expect(waited.stale).toBe(false);
    expect(waited.state).toBe('ready');
    await rebuild;
  });

  it('重建失败时旧快照仍完整可读（stale），状态回到 ready', async () => {
    let phase: 'old' | 'new' = 'old';
    const decode = vi.fn(async (_f: string, h: FrameHandler) => {
      if (phase === 'old') {
        for (let i = 0; i < 20; i += 1) h.onFrame(0.4);
        return { decoder: 'wav' as const, sampleRate: 1000, channels: 1, bitsPerSample: 16, sampleFormat: 'pcm16' as const };
      }
      throw new Error('decode exploded');
    });
    const svc = service(decode);
    await svc.read('k', sourceFile, { width: 5 });

    await new Promise((r) => setTimeout(r, 20));
    await writeFile(sourceFile, Buffer.alloc(140));
    phase = 'new';

    const rebuild = svc.rebuild('k', sourceFile, { staleWhileRebuild: false });
    await expect(rebuild).rejects.toThrow('构建失败');
    // 失败后：要求新鲜数据的读取仍会重新尝试并失败；允许 stale 的读取拿到旧完整快照。
    await expect(
      svc.read('k', sourceFile, { width: 5, staleWhileRebuild: false }),
    ).rejects.toThrow('构建失败');
    const fallback = await svc.read('k', sourceFile, { width: 5, staleWhileRebuild: true });
    expect(fallback.stale).toBe(true);
    expect(fallback.buckets.every((b) => b.max >= 0.39)).toBe(true);
    expect(svc.peek('k').state).toBe('ready');
  });

  it('invalidate 后读取触发全新构建', async () => {
    const decode = makeDecoder(20);
    const svc = service(decode);
    await svc.read('k', sourceFile, { width: 5 });
    await svc.invalidate('k');
    expect(svc.peek('k').state).toBe('empty');
    await svc.read('k', sourceFile, { width: 5 });
    expect(decode).toHaveBeenCalledTimes(2);
  });

  it('源文件内容变化（指纹变化）自动重建，旧请求不会把旧快照当新鲜结果', async () => {
    const decode = makeDecoder(20);
    const svc = service(decode);
    const first = await svc.read('k', sourceFile, { width: 5 });
    expect(first.stale).toBe(false);

    await new Promise((r) => setTimeout(r, 20));
    await writeFile(sourceFile, Buffer.alloc(250));
    const second = await svc.read('k', sourceFile, { width: 5 });
    expect(decode).toHaveBeenCalledTimes(2);
    expect(second.stale).toBe(false);
  });
});
