#!/usr/bin/env node
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import {
  createPeakHttpServer,
  listenPeakHttpServer,
  PeakCacheService,
  FilePeakStore,
} from './index.js';
import type { AudioSource } from './index.js';

/**
 * 独立波形峰值服务入口。
 *
 * 环境变量：
 *   PEAKS_PORT       监听端口，默认 4100
 *   PEAKS_CACHE_DIR 峰值缓存目录，默认 ./storage/peaks
 *   PEAKS_AUDIO_ROOT音频文件根目录（key 作为相对路径解析）；默认 key 即绝对路径
 *   PEAKS_BASE_BLOCK_FRAMES  第 0 层桶帧数，默认 256
 *   PEAKS_BUILD_CONCURRENCY  构建并发，默认 2
 *
 * 直接：node dist/server.js
 */
async function main(): Promise<void> {
  const port = Number(process.env.PEAKS_PORT || 4100);
  const cacheDir = path.resolve(process.env.PEAKS_CACHE_DIR || './storage/peaks');
  const audioRoot = process.env.PEAKS_AUDIO_ROOT
    ? path.resolve(process.env.PEAKS_AUDIO_ROOT)
    : undefined;
  await mkdir(cacheDir, { recursive: true });

  const store = new FilePeakStore(cacheDir);
  await store.cleanupTemporary();

  const service = new PeakCacheService({
    store,
    baseBlockFrames: Number(process.env.PEAKS_BASE_BLOCK_FRAMES || 256),
    buildConcurrency: Number(process.env.PEAKS_BUILD_CONCURRENCY || 2),
  });

  // 独立部署时把 URL 中的 key 解析为文件来源；接入主应用时可改用录音 ID 查库。
  const resolveSource = (_req: unknown, key: string): AudioSource => {
    const filePath = audioRoot
      ? path.join(audioRoot, path.basename(key)) // 简单防目录穿越
      : key;
    return { type: 'file', path: filePath };
  };

  const server = createPeakHttpServer({ service, resolveSource });
  const address = await listenPeakHttpServer(server, port);

  const shutdown = (signal: string): void => {
    console.log(`received ${signal}, closing peaks service`);
    service.close();
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  console.log(
    `peaks service listening on :${address.port} (cache=${cacheDir}${
      audioRoot ? `, audioRoot=${audioRoot}` : ''
    })`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
