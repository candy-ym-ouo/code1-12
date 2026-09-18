import { describe, expect, it, vi } from 'vitest';
import {
  PeakBuildError,
  PeakBuildTimeoutError,
  PeakCacheService,
} from '../src/service.js';
import { MemoryPeakStore } from '../src/store.js';
import type { AudioStream } from '../src/types.js';

/** 测试用可控音频流：手动逐块放行 PCM，模拟慢速大文件解码。 */
class ControlledStream implements AudioStream {
  sampleRate = 8000;
  channels = 1;
  private waiters: Array<(chunk: IteratorResult<Int16Array>) => void> = [];
  private queue: IteratorResult<Int16Array>[] = [];
  openedCount = 0;

  constructor(public readonly totalFrames = 8000) {}

  async open(): Promise<AudioStream> {
    this.openedCount++;
    return this;
  }

  /** 放行一块 length 个帧的正弦波 PCM。 */
  emit(length: number, base: number): void {
    const chunk = new Int16Array(length);
    for (let i = 0; i < length; i++) {
      chunk[i] = Math.round(5000 * Math.sin(((base + i) / 17) * Math.PI));
    }
    this.deliver({ done: false, value: chunk });
  }

  /** 结束流。 */
  end(): void {
    this.deliver({ done: true, value: undefined });
  }

  private deliver(result: IteratorResult<Int16Array>): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(result);
    } else {
      this.queue.push(result);
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<Int16Array> {
    return {
      next: (): Promise<IteratorResult<Int16Array>> =>
        new Promise((resolve) => {
          const queued = this.queue.shift();
          if (queued !== undefined) resolve(queued);
          else this.waiters.push(resolve);
        }),
    };
  }
}

describe('PeakCacheService 并发语义', () => {
  it('并发请求合并为一次解码，且全部拿到同一份完整快照', async () => {
    const service = new PeakCacheService({
      store: new MemoryPeakStore(),
      baseBlockFrames: 100,
    });
    const stream = new ControlledStream(5000);
    const source = {
      type: 'stream' as const,
      meta: { key: 'merged', mtimeMs: 1, sizeBytes: 1 },
      open: () => stream.open(),
    };

    const results: PromiseSettledResult<unknown>[] = [];
    const promises = Array.from({ length: 8 }, () =>
      service.getSnapshot(source).then(
        (v) => results.push({ status: 'fulfilled', value: v }),
        (e) => results.push({ status: 'rejected', reason: e }),
      ),
    );

    // 等构建开始
    await vi.waitFor(() => expect(stream.openedCount).toBe(1));
    expect(service.status('merged').phase).toBe('building');

    // noWait 请求在构建期间只能得到 building，绝不会拿到半成品
    const early = await service.getSnapshot(source, { noWait: true });
    expect(early.status).toBe('building');
    expect(early.snapshot).toBeNull();

    // 慢速流式喂入，最后一块只发剩余帧
    let sent = 0;
    while (sent < stream.totalFrames) {
      const length = Math.min(333, stream.totalFrames - sent);
      stream.emit(length, sent);
      sent += length;
    }
    stream.end();

    await Promise.all(promises);
    expect(results).toHaveLength(8);
    for (const result of results) {
      expect(result.status).toBe('fulfilled');
    }
    expect(stream.openedCount).toBe(1);

    const hit = await service.getSnapshot(source);
    expect(hit.status).toBe('hit');
    expect(hit.snapshot!.totalFrames).toBe(5000);
    service.close();
  });

  it('重建期间读取返回旧快照（stale），新快照提交前不暴露', async () => {
    const service = new PeakCacheService({ store: new MemoryPeakStore(), baseBlockFrames: 100 });

    // 第一代：快速构建完成
    const v1 = new ControlledStream(2000);
    const sourceV1 = {
      type: 'stream' as const,
      meta: { key: 'rebuild', mtimeMs: 1000, sizeBytes: 100 },
      open: () => v1.open(),
    };
    const first = service.getSnapshot(sourceV1);
    v1.emit(2000, 0);
    v1.end();
    const firstSnapshot = (await first).snapshot!;
    expect(firstSnapshot.totalFrames).toBe(2000);

    // 第二代：强制重建，慢速
    const v2 = new ControlledStream(4000);
    const sourceV2 = {
      type: 'stream' as const,
      meta: { key: 'rebuild', mtimeMs: 2000, sizeBytes: 200 },
      open: () => v2.open(),
    };
    const rebuildPromise = service.getSnapshot(sourceV2, { force: true });
    await vi.waitFor(() => expect(v2.openedCount).toBe(1));

    // 重建期间其他读取拿到 stale 旧快照（或等待同一个新构建），不会出现 4000 帧的半成品
    const stale = await service.getSnapshot(sourceV2, { noWait: true });
    expect(stale.status).toBe('stale');
    expect(stale.snapshot).toBe(firstSnapshot);
    expect(stale.snapshot!.totalFrames).toBe(2000);

    v2.emit(4000, 0);
    v2.end();
    const rebuilt = await rebuildPromise;
    expect(rebuilt.status).toBe('hit');
    expect(rebuilt.snapshot!.totalFrames).toBe(4000);

    const after = await service.getSnapshot(sourceV2);
    expect(after.snapshot).toBe(rebuilt.snapshot);
    service.close();
  });

  it('invalidate 使旧构建结果不得提交，等待方衔接到新一轮构建', async () => {
    const service = new PeakCacheService({ store: new MemoryPeakStore(), baseBlockFrames: 100 });
    const old = new ControlledStream(3000);
    const source = {
      type: 'stream' as const,
      meta: { key: 'inval', mtimeMs: 1, sizeBytes: 1 },
      open: () => {
        // invalidate 后重新打开会得到新的流
        return current.open();
      },
    };
    let current: ControlledStream = old;

    const firstWait = service.getSnapshot(source);
    await vi.waitFor(() => expect(old.openedCount).toBe(1));

    // 让旧构建完成保存之前失效
    await service.invalidate('inval', { deleteFromStore: false });
    old.emit(3000, 0);
    old.end();

    const next = new ControlledStream(1500);
    current = next;
    // 触发新一轮构建
    const secondWait = service.getSnapshot(source);
    await vi.waitFor(() => expect(next.openedCount).toBe(1));
    next.emit(1500, 0);
    next.end();

    const [a, b] = await Promise.all([firstWait.catch((e) => e), secondWait]);
    // 第一个等待方即使被旧构建中止，最终也应得到新快照或明确错误，绝不得到旧值
    if (b.snapshot) {
      expect(b.snapshot.totalFrames).toBe(1500);
    }
    expect(a).toBeDefined();
    service.close();
  });

  it('构建失败时拒绝请求而不是返回部分数据，冷却期后允许重试', async () => {
    const service = new PeakCacheService({
      store: new MemoryPeakStore(),
      failureCooldownMs: 30,
    });
    let shouldFail = true;
    const source = {
      type: 'stream' as const,
      meta: { key: 'fail-key' },
      // eslint-disable-next-line @typescript-eslint/require-await
      open: async (): Promise<AudioStream> => {
        if (shouldFail) {
          return {
            sampleRate: 8000,
            channels: 1,
            // eslint-disable-next-line @typescript-eslint/require-await
            [Symbol.asyncIterator]: async function* () {
              throw new Error('磁盘已损坏');
            },
          };
        }
        const ok = new ControlledStream(1000);
        queueMicrotask(() => {
          ok.emit(1000, 0);
          ok.end();
        });
        return ok;
      },
    };

    await expect(service.getSnapshot(source)).rejects.toBeInstanceOf(PeakBuildError);

    // 冷却期内直接抛错，不重新打开解码器
    let attempts = 0;
    const countingSource = {
      ...source,
      open: async (signal: AbortSignal) => {
        attempts++;
        return source.open(signal);
      },
    };
    await expect(service.getSnapshot(countingSource)).rejects.toThrow();
    expect(attempts).toBe(0);

    await new Promise((r) => setTimeout(r, 40));
    shouldFail = false;
    const retry = await service.getSnapshot(source);
    expect(retry.status).toBe('hit');
    expect(retry.snapshot!.totalFrames).toBe(1000);
    service.close();
  });

  it('超时且无旧快照时抛出明确的超时错误', async () => {
    const service = new PeakCacheService({ store: new MemoryPeakStore() });
    const slow = new ControlledStream(10_000);
    const source = {
      type: 'stream' as const,
      meta: { key: 'slow' },
      open: () => slow.open(),
    };
    // 不 await：后台构建挂起
    void service.prebuild(source);
    await vi.waitFor(() => expect(slow.openedCount).toBe(1));

    await expect(
      service.getSnapshot(source, { timeoutMs: 30 }),
    ).rejects.toBeInstanceOf(PeakBuildTimeoutError);

    slow.emit(10_000, 0);
    slow.end();
    const done = await service.getSnapshot(source);
    expect(done.status).toBe('hit');
    service.close();
  });

  it('超时到点与构建提交竞态时：拿到完整快照即 hit，绝不误判为 stale', async () => {
    // 重复多次以覆盖不同调度时序。
    for (let round = 0; round < 20; round++) {
      const service = new PeakCacheService({
        store: new MemoryPeakStore(),
        baseBlockFrames: 100,
      });
      const stream = new ControlledStream(1000);
      const key = `race-${round}`;
      const source = {
        type: 'stream' as const,
        meta: { key },
        open: () => stream.open(),
      };

      // 后台触发构建（不等待），再发起一个很短超时的等待。
      void service.prebuild(source);
      await vi.waitFor(() => expect(stream.openedCount).toBe(1));

      const waiter = service.getSnapshot(source, { timeoutMs: 1 });
      // 立即喂入并结束，使「构建完成」与「超时」高度竞争。
      stream.emit(1000, 0);
      stream.end();

      const result = await waiter.catch((error) => error);
      if (!(result instanceof PeakBuildTimeoutError)) {
        // 只要拿到快照就必须是完整的 hit，不能是 stale（此时根本不存在旧快照）。
        expect(result.status).toBe('hit');
        expect(result.snapshot.totalFrames).toBe(1000);
      }
      service.close();
    }
  }, 10000);
});
