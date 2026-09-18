import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  PeakBuildTimeoutError,
  PeakServiceClosedError,
  type AudioSource,
  type GetSnapshotOptions,
} from './service.js';
import {
  DecoderUnavailableError,
  FfmpegDecodeError,
  WavDecodeError,
} from './decoder/audio.js';
import type { PeakCacheService } from './service.js';

export type PeakHttpServer = Server;

/** 把请求里的录音标识解析为音频来源；返回 null 表示 404。 */
export type PeakHttpSourceResolver = (
  request: IncomingMessage,
  key: string,
) => Promise<AudioSource | null> | AudioSource | null;

export interface PeakHttpOptions {
  service: PeakCacheService;
  resolveSource: PeakHttpSourceResolver;
  /** 最大允许一次请求的桶数，默认 10000。 */
  maxBuckets?: number;
  /** 默认返回桶数，默认 1000。 */
  defaultBuckets?: number;
  /** 额外鉴权中间件：抛出/返回 false 时请求被拒绝（401）。 */
  authorize?: (request: IncomingMessage) => Promise<boolean> | boolean;
}

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' } as const;

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.writeHead(statusCode, JSON_HEADERS);
  res.end(JSON.stringify(body));
}

function intParam(searchParams: URLSearchParams, name: string): number | undefined {
  const raw = searchParams.get(name);
  if (raw === null) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) return undefined;
  return value;
}

/**
 * 创建波形峰值 HTTP 服务（node:http 原生实现，可直接监听或交给现有网关）。
 *
 * 路由：
 * - GET  /v1/peaks/:key?start=&end=&buckets=&timeoutMs=&noWait=1
 * - POST /v1/peaks/:key/rebuild
 * - GET  /v1/peaks/:key/status
 * - GET  /health
 *
 * 关键语义：正在重建时 GET 要么等待到完整快照，要么返回 status=stale 的旧快照，
 * 响应中绝不会出现构建一半的峰值数据。
 */
export function createPeakHttpServer(options: PeakHttpOptions): PeakHttpServer {
  const { service, resolveSource, maxBuckets = 10_000, defaultBuckets = 1000 } = options;

  const server = createServer(async (req, res) => {
    try {
      if (options.authorize && !(await options.authorize(req))) {
        sendJson(res, 401, { error: { code: 'UNAUTHENTICATED', message: '请先登录' } });
        return;
      }

      const url = new URL(req.url || '/', 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/health') {
        sendJson(res, 200, { ok: true });
        return;
      }

      const peakMatch = /^\/v1\/peaks\/([^/]+)(\/rebuild|\/status)?$/.exec(url.pathname);
      if (!peakMatch || !req.method) {
        sendJson(res, 404, { error: { code: 'NOT_FOUND', message: '接口不存在' } });
        return;
      }
      const [, key, suffix] = peakMatch;
      const decodedKey = decodeURIComponent(key);
      const source = await resolveSource(req, decodedKey);
      if (!source) {
        sendJson(res, 404, { error: { code: 'NOT_FOUND', message: '录音不存在' } });
        return;
      }

      if (suffix === '/status' && req.method === 'GET') {
        const status = service.status(extractStatusKey(source, decodedKey));
        sendJson(res, 200, { data: status });
        return;
      }

      if (suffix === '/rebuild' && req.method === 'POST') {
        const result = await service.getSnapshot(source, {
          force: true,
          noWait: url.searchParams.get('noWait') === '1',
          timeoutMs: intParam(url.searchParams, 'timeoutMs'),
        });
        sendJson(res, 200, {
          data: {
            status: result.status,
            meta: result.snapshot ? describeSnapshot(result.snapshot) : null,
          },
        });
        return;
      }

      if (suffix === undefined && req.method === 'GET') {
        const buckets = intParam(url.searchParams, 'buckets') ?? defaultBuckets;
        if (buckets <= 0 || buckets > maxBuckets) {
          sendJson(res, 400, {
            error: {
              code: 'INVALID_INPUT',
              message: `buckets 必须在 1..${maxBuckets} 之间`,
            },
          });
          return;
        }

        const getOptions: GetSnapshotOptions = {
          noWait: url.searchParams.get('noWait') === '1',
          timeoutMs: intParam(url.searchParams, 'timeoutMs'),
        };
        const result = await service.getSnapshot(source, getOptions);

        if (result.status === 'building' || !result.snapshot) {
          // 缓存尚未构建完成且调用方要求不等待：202 告知稍后重试，绝不返回半成品。
          sendJson(res, 202, { data: { status: 'building' } });
          return;
        }

        const stale = result.status === 'stale';
        const window = result.snapshot.readWindow({
          startFrame: intParam(url.searchParams, 'start'),
          endFrame: intParam(url.searchParams, 'end'),
          buckets,
          stale,
        });

        sendJson(res, 200, {
          data: {
            status: result.status,
            stale,
            sampleRate: result.snapshot.sampleRate,
            channels: result.snapshot.channels,
            totalFrames: result.snapshot.totalFrames,
            startFrame: window.startFrame,
            endFrame: window.endFrame,
            framesPerBucket: window.framesPerBucket,
            level: window.level,
            // 归一化到 -1..1，减少前端处理成本。
            mins: Array.from(window.mins, (v) => roundPeak(v / 32768)),
            maxs: Array.from(window.maxs, (v) => roundPeak(v / 32768)),
          },
        });
        return;
      }

      sendJson(res, 404, { error: { code: 'NOT_FOUND', message: '接口不存在' } });
    } catch (error) {
      respondError(res, error);
    }
  });

  return server;
}

function roundPeak(value: number): number {
  return Math.round(value * 1e5) / 1e5;
}

function extractStatusKey(source: AudioSource, fallback: string): string {
  return source.type === 'stream' ? source.meta.key : source.path || fallback;
}

function describeSnapshot(snapshot: {
  sampleRate: number;
  channels: number;
  totalFrames: number;
  baseBlockFrames: number;
  levels: unknown[];
}): unknown {
  return {
    sampleRate: snapshot.sampleRate,
    channels: snapshot.channels,
    totalFrames: snapshot.totalFrames,
    baseBlockFrames: snapshot.baseBlockFrames,
    levelCount: snapshot.levels.length,
  };
}

function respondError(res: ServerResponse, error: unknown): void {
  if (error instanceof PeakServiceClosedError) {
    sendJson(res, 503, { error: { code: 'SERVICE_CLOSED', message: '服务已关闭' } });
    return;
  }
  if (error instanceof PeakBuildTimeoutError) {
    sendJson(res, 503, {
      error: { code: 'PEAKS_PENDING', message: '波形峰值仍在构建中，请稍后重试' },
    });
    return;
  }
  if (error instanceof DecoderUnavailableError) {
    sendJson(res, 503, {
      error: { code: 'DECODER_UNAVAILABLE', message: error.message },
    });
    return;
  }
  if (error instanceof WavDecodeError || error instanceof FfmpegDecodeError) {
    sendJson(res, 422, { error: { code: 'AUDIO_DECODE_FAILED', message: error.message } });
    return;
  }
  if (error instanceof SyntaxError) {
    sendJson(res, 400, { error: { code: 'INVALID_INPUT', message: '请求参数无效' } });
    return;
  }
  const message = error instanceof Error ? error.message : '波形服务内部错误';
  sendJson(res, 500, { error: { code: 'INTERNAL_SERVER_ERROR', message } });
}

/** 便捷启动：监听端口并返回地址信息。 */
export async function listen(
  server: PeakHttpServer,
  port = 4100,
  host = '0.0.0.0',
): Promise<AddressInfo> {
  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  return server.address() as AddressInfo;
}
