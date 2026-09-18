import { Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { PrismaClient } from '@prisma/client';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseFile } from 'music-metadata';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PeakCacheService } from '@history/waveform';

const execFileAsync = promisify(execFile);
const prisma = new PrismaClient();
const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
  maxRetriesPerRequest: null,
});

// 波形峰值缓存与 API 使用同一目录，worker 负责在录音 READY 后预热；
// 预热失败不影响录音上线（API 首次访问时会惰性重建）。
const currentDir = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(currentDir, '../../..');
const configuredStorage = process.env.STORAGE_DIR || './storage';
const storageDir = path.isAbsolute(configuredStorage)
  ? configuredStorage
  : path.resolve(repositoryRoot, configuredStorage);
const waveformService = new PeakCacheService({
  cacheDir: path.join(storageDir, 'waveform'),
  samplesPerPeak: Number(process.env.WAVEFORM_SAMPLES_PER_PEAK) || 256,
});

async function probeWithFfprobe(filePath: string): Promise<number> {
  const { stdout } = await execFileAsync(
    'ffprobe',
    [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'default=noprint_wrappers=1:nokey=1',
      filePath,
    ],
    { timeout: 60_000, maxBuffer: 1024 * 1024 },
  );
  const seconds = Number.parseFloat(stdout.trim());
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new Error('ffprobe 未返回有效时长');
  }
  return Math.round(seconds * 1000);
}

async function probeWithMusicMetadata(filePath: string): Promise<number> {
  const metadata = await parseFile(filePath, { duration: true });
  const seconds = metadata.format.duration;
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) {
    throw new Error('无法读取音频时长');
  }
  return Math.round(seconds * 1000);
}

async function probeDurationMs(filePath: string): Promise<number> {
  try {
    return await probeWithFfprobe(filePath);
  } catch (ffprobeError) {
    try {
      return await probeWithMusicMetadata(filePath);
    } catch (metadataError) {
      const ffprobeMessage =
        ffprobeError instanceof Error ? ffprobeError.message : String(ffprobeError);
      const metadataMessage =
        metadataError instanceof Error ? metadataError.message : String(metadataError);
      throw new Error(
        `无法解析音频元数据（ffprobe: ${ffprobeMessage}; fallback: ${metadataMessage}）`,
      );
    }
  }
}

async function processMediaJob(job: Job) {
  const recordingId = String(job.data?.recordingId || '');
  if (!recordingId) throw new Error('任务缺少 recordingId');

  const recording = await prisma.recording.findUnique({ where: { id: recordingId } });
  if (!recording) throw new Error(`录音不存在: ${recordingId}`);

  await prisma.recording.update({
    where: { id: recordingId },
    data: { status: 'PROCESSING', processingError: null },
  });

  const durationMs = await probeDurationMs(recording.originalPath);
  if (durationMs <= 0) throw new Error('音频时长为 0，无法进入编辑');

  const playbackPath = recording.playbackPath || recording.originalPath;
  await prisma.recording.update({
    where: { id: recordingId },
    data: {
      status: 'READY',
      durationMs,
      playbackPath,
      processingError: null,
    },
  });

  // 预热波形峰值缓存。失败只记录，不把任务标记失败——
  // API 的波形接口在下次访问时会惰性重建。
  try {
    await waveformService.rebuild(recordingId, playbackPath);
    console.log(`waveform peaks warmed for ${recordingId}`);
  } catch (waveformError) {
    console.error(`waveform warmup failed for ${recordingId}:`, waveformError);
  }

  return { recordingId, durationMs };
}

const worker = new Worker('media', processMediaJob, {
  connection: redis,
  concurrency: 2,
});

worker.on('completed', (job) => {
  console.log(`media job ${job.id} completed`);
});

worker.on('failed', async (job, error) => {
  const recordingId = job?.data?.recordingId;
  if (!recordingId) return;

  const maxAttempts = job.opts.attempts ?? 1;
  const hasAttemptsLeft = job.attemptsMade < maxAttempts;
  try {
    await prisma.recording.update({
      where: { id: String(recordingId) },
      data: {
        status: hasAttemptsLeft ? 'PROCESSING' : 'FAILED',
        processingError: error.message,
      },
    });
  } catch (updateError) {
    console.error(`failed to persist media job error for ${recordingId}`, updateError);
  }
});

worker.on('error', (error) => {
  console.error('media worker error', error);
});

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`received ${signal}, shutting down media worker`);
  await worker.close();
  if (redis.status !== 'end') redis.disconnect();
  await prisma.$disconnect();
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

console.log('media worker listening');
