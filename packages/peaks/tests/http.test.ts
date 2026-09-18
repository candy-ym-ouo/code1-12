import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createPeakHttpServer, type PeakHttpSourceResolver } from '../src/http.js';
import { PeakCacheService } from '../src/service.js';
import { MemoryPeakStore } from '../src/store.js';
import type { AudioStream } from '../src/types.js';
import type { Server } from 'node:http';

/** 可在 HTTP 请求进行中控制放行节奏的音频源（队列式异步迭代器）。 */
class GatedAudio {
  sampleRate = 8000;
  channels = 1;
  private queue: IteratorResult<Int16Array>[] = [];
  private waiters: Array<(r: IteratorResult<Int16Array>) => void> = [];

  release(length: number): void {
    const chunk = new Int16Array(length);
    for (let i = 0; i < length; i++) chunk[i] = 2000 + (i % 500);
    this.deliver({ done: false, value: chunk });
  }

  finish(): void {
    this.deliver({ done: true, value: undefined });
  }

  private deliver(result: IteratorResult<Int16Array>): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter(result);
    else this.queue.push(result);
  }

  toStream(): AudioStream {
    return {
      sampleRate: this.sampleRate,
      channels: this.channels,
      [Symbol.asyncIterator]: () => ({
        next: () =>
          new Promise<IteratorResult<Int16Array>>((resolve) => {
            const queued = this.queue.shift();
            if (queued !== undefined) resolve(queued);
            else this.waiters.push(resolve);
          }),
      }),
    };
  }
}

describe('峰值 HTTP 服务', () => {
  let server: Server;
  let baseUrl: string;
  const gates = new Map<string, GatedAudio>();

  const resolver: PeakHttpSourceResolver = (_req, key) => ({
    type: 'stream',
    meta: { key },
    open: () => gates.get(key)!.toStream(),
  });

  beforeAll(async () => {
    const service = new PeakCacheService({
      store: new MemoryPeakStore(),
      baseBlockFrames: 100,
      buildConcurrency: 4,
    });
    server = createPeakHttpServer({ service, resolveSource: resolver });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('构建未完成时 noWait 请求得到 202 而非半成品，放行后得到完整峰值', async () => {
    const key = 'http-building';
    const gate = new GatedAudio();
    gates.set(key, gate);

    // 1) 首次 noWait 请求触发后台构建（流式解码挂起在第一块）
    const triggered = await fetch(`${baseUrl}/v1/peaks/${key}?buckets=50&noWait=1`);
    expect(triggered.status).toBe(202);
    expect((await triggered.json()).data.status).toBe('building');

    // 给构建留出打开迭代器的时间
    await new Promise((r) => setTimeout(r, 50));

    // 2) 构建进行中的 noWait 请求依旧只能得到 202，绝不返回部分峰值
    const during = await fetch(`${baseUrl}/v1/peaks/${key}?buckets=50&noWait=1`);
    expect(during.status).toBe(202);

    // 3) 放行完整音频
    gate.release(5000);
    gate.finish();

    // 4) 再读得到完整数据
    const ok = await fetch(`${baseUrl}/v1/peaks/${key}?buckets=50`).then((r) => r.json());
    expect(ok.data.totalFrames).toBe(5000);
    expect(ok.data.mins).toHaveLength(50);
    expect(ok.data.maxs).toHaveLength(50);
    expect(ok.data.stale).toBe(false);
  });

  it('健康检查与错误桶数校验', async () => {
    const health = await fetch(`${baseUrl}/health`);
    expect(health.status).toBe(200);

    const bad = await fetch(`${baseUrl}/v1/peaks/x?buckets=999999`);
    expect(bad.status).toBe(400);
  });
});
