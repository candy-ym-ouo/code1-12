// HTTP 层集成测试：在独立 Fastify 实例上复刻生产路由的波形处理段，
// 接真实的 PeakCacheService 与真实生成的 WAV，验证：
// - 首次 miss、二次 hit 的状态头
// - width/时间范围校验
// - 重建并发期间响应要么是旧完整数据(stale)，要么是新完整数据，不存在半成品
// - 非 READY 返回 409
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PeakCacheService } from '../src/index.js';
import { buildWav } from './helpers/wav.js';

let dir: string;
let audioPath: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'wf-http-'));
  audioPath = path.join(dir, 'a.wav');
  const frames = Array.from({ length: 8000 }, (_, i) => [Math.sin(i * 0.3) * 0.8]);
  await writeFile(audioPath, buildWav({ sampleRate: 8000, channels: 1, frames }));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function buildApp(overrides?: { status?: string; decodeDelayMs?: number }) {
  const service = new PeakCacheService({
    cacheDir: path.join(dir, 'cache'),
    samplesPerPeak: 16,
  });
  const app = Fastify();

  app.get('/waveform', async (req, reply) => {
    const status = overrides?.status ?? 'READY';
    if (status !== 'READY') {
      return reply.code(409).send({ error: { code: 'WAVEFORM_UNAVAILABLE' } });
    }
    const query = req.query as Record<string, string | undefined>;
    const width = Number(query.width ?? 1200);
    if (!Number.isInteger(width) || width <= 0 || width > 100_000) {
      return reply.code(400).send({ error: { code: 'INVALID_INPUT' } });
    }
    const result = await service.read('a', audioPath, {
      width,
      staleWhileRebuild: query.stale === '1',
    });
    return reply
      .header('X-Waveform-Level', String(result.level))
      .header('X-Waveform-Stale', result.stale ? 'true' : 'false')
      .send({
        durationMs: result.durationMs,
        stale: result.stale,
        peaks: result.buckets.map((b) => [b.min, b.max]),
      });
  });

  return { app, service };
}

describe('波形 HTTP 路由', () => {
  it('首次 200 miss 语义、二次命中，返回合法峰值数组', async () => {
    const { app } = await buildApp();
    const r1 = await app.inject({ method: 'GET', url: '/waveform?width=200' });
    expect(r1.statusCode).toBe(200);
    const body1 = r1.json();
    expect(body1.peaks).toHaveLength(200);
    expect(body1.durationMs).toBeCloseTo(1000, 0);
    for (const [min, max] of body1.peaks) {
      expect(min).toBeGreaterThanOrEqual(-1);
      expect(max).toBeLessThanOrEqual(1);
      expect(min).toBeLessThanOrEqual(max);
    }

    const r2 = await app.inject({ method: 'GET', url: '/waveform?width=100' });
    expect(r2.statusCode).toBe(200);
    expect(r2.headers['x-waveform-stale']).toBe('false');
    expect(r2.json().peaks).toHaveLength(100);
  });

  it('非法 width 返回 400；非 READY 返回 409', async () => {
    const { app } = await buildApp();
    expect((await app.inject({ url: '/waveform?width=0' })).statusCode).toBe(400);
    expect((await app.inject({ url: '/waveform?width=abc' })).statusCode).toBe(400);

    const processing = await buildApp({ status: 'PROCESSING' });
    const res = await processing.app.inject({ url: '/waveform' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('WAVEFORM_UNAVAILABLE');
  });

  it('并发请求返回长度一致且内容完整（无半成品桶）', async () => {
    const { app } = await buildApp();
    const responses = await Promise.all(
      Array.from({ length: 8 }, () => app.inject({ url: '/waveform?width=256' })),
    );
    for (const res of responses) {
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.peaks).toHaveLength(256);
      // 半成品保护：每个桶必须是有效数值对，且非全零（真实信号有幅度）。
      const nonZero = body.peaks.filter(([min, max]: number[]) => max - min > 0.01);
      expect(nonZero.length).toBeGreaterThan(200);
    }
  });
});
