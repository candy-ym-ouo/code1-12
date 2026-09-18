import {
  spawn,
  execFile,
  type ChildProcess,
} from 'node:child_process';
import { promisify } from 'node:util';
import type { AudioInfo, AudioStream } from '../types.js';

const execFileAsync = promisify(execFile);

/** 系统未安装 ffmpeg/ffprobe 或可执行文件无法启动。 */
export class DecoderUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DecoderUnavailableError';
  }
}

/** ffprobe/ffmpeg 返回非零退出码或输出无法解析。 */
export class FfmpegDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FfmpegDecodeError';
  }
}

export interface FfmpegOptions {
  /** 自定义可执行文件名或绝对路径。 */
  ffmpegPath?: string;
  ffprobePath?: string;
  /** 解码单声道（默认 false：保留原始声道，在峰值阶段跨声道取极值）。 */
  mono?: boolean;
  /** 取消解码时中止子进程。 */
  signal?: AbortSignal;
}

/** 用 ffprobe 读取采样率、声道数和时长推导的总帧数。 */
export async function probeAudio(
  filePath: string,
  ffprobePath = process.env.FFPROBE_PATH || 'ffprobe',
): Promise<AudioInfo> {
  let stdout: string;
  try {
    const result = await execFileAsync(
      ffprobePath,
      [
        '-v',
        'error',
        '-select_streams',
        'a:0',
        '-show_entries',
        'stream=sample_rate,channels:format=duration',
        '-of',
        'default=noprint_wrappers=1:nokey=1',
        filePath,
      ],
      { timeout: 60_000, maxBuffer: 1024 * 1024 },
    );
    stdout = result.stdout;
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === 'ENOENT') {
      throw new DecoderUnavailableError(`未找到 ffprobe（${ffprobePath}）`);
    }
    throw new FfmpegDecodeError(
      error instanceof Error ? `ffprobe 失败: ${error.message}` : 'ffprobe 失败',
    );
  }

  const parts = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  // 输出顺序为流条目（sample_rate、channels）与格式条目（duration），逐行按数值特征解析更稳。
  let sampleRate: number | undefined;
  let channels: number | undefined;
  let durationSeconds: number | undefined;
  for (const part of parts) {
    if (/^\d+$/.test(part)) {
      const value = Number(part);
      if (sampleRate === undefined && value > 0) sampleRate = value;
      else if (channels === undefined && value > 0 && value <= 32) channels = value;
    } else {
      const value = Number.parseFloat(part);
      if (Number.isFinite(value) && value >= 0) durationSeconds = value;
    }
  }

  if (!sampleRate || !channels) {
    throw new FfmpegDecodeError(`ffprobe 未能解析音频参数: ${stdout.trim() || '(空输出)'}`);
  }
  const totalFrames =
    durationSeconds !== undefined ? Math.round(durationSeconds * sampleRate) : undefined;
  return { sampleRate, channels, totalFrames };
}

function waitForProcessExit(child: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve(code ?? 0));
  });
}

/**
 * 通过 ffmpeg 将任意压缩/容器格式解码为流式交错 s16 PCM。
 *
 * ffmpeg 直接输出到管道，调用方按块消费，内存占用与文件大小无关；保留原始声道，
 * 跨声道极值由构建器在交错数据上直接完成。
 */
export async function openFfmpegStream(
  filePath: string,
  options: FfmpegOptions = {},
): Promise<AudioStream> {
  const ffmpegPath = options.ffmpegPath || process.env.FFMPEG_PATH || 'ffmpeg';
  const info = await probeAudio(filePath, options.ffprobePath);

  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-nostdin',
    '-i',
    filePath,
    '-vn',
    '-f',
    's16le',
    '-acodec',
    'pcm_s16le',
    '-ac',
    options.mono ? '1' : String(info.channels),
    '-ar',
    String(info.sampleRate),
    'pipe:1',
  ];

  const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  // 通过持有对象在事件回调与读取循环间共享启动错误，规避 TS 对闭包赋值的窄化。
  const spawnFailure: { error: NodeJS.ErrnoException | null } = { error: null };
  child.once('error', (error) => {
    spawnFailure.error = error as NodeJS.ErrnoException;
  });

  // 持续排空 stderr 防止管道阻塞，末尾保留少量内容用于错误信息。
  const stderrChunks: Buffer[] = [];
  let stderrLength = 0;
  child.stderr.on('data', (chunk: Buffer) => {
    if (stderrLength < 4096) {
      stderrChunks.push(chunk.subarray(0, 4096 - stderrLength));
      stderrLength = Math.min(4096, stderrLength + chunk.length);
    }
  });

  let terminated = false;
  const terminate = () => {
    if (!terminated && !child.killed) {
      terminated = true;
      child.kill('SIGKILL');
    }
  };
  options.signal?.addEventListener('abort', terminate, { once: true });

  // 等待 spawn 成功或启动失败（如 ENOENT），避免把启动失败伪装成语流正常结束。
  await new Promise<void>((resolve) => {
    child.once('spawn', () => resolve());
    child.once('error', () => resolve());
  });
  if (spawnFailure.error) {
    if (spawnFailure.error.code === 'ENOENT') {
      throw new DecoderUnavailableError(`未找到 ffmpeg（${ffmpegPath}）`);
    }
    throw new FfmpegDecodeError(`无法启动 ffmpeg: ${spawnFailure.error.message}`);
  }

  let leftover: Buffer = Buffer.alloc(0);

  /** 读取下一块；流结束时返回 null（含排空 end 时刻缓冲中的尾部数据）。 */
  const readChunk = (): Promise<Buffer | null> =>
    new Promise((resolve, reject) => {
      const attempt = (): Buffer | null => child.stdout.read() as Buffer | null;
      const chunk = attempt();
      if (chunk !== null) return resolve(chunk);
      if (child.exitCode !== null || child.stdout.destroyed || spawnFailure.error) {
        return resolve(null);
      }
      const onReadable = () => resolve(attempt());
      const onEnd = () => resolve(attempt());
      child.stdout.once('readable', onReadable);
      child.stdout.once('end', onEnd);
      child.stdout.once('error', reject);
    });

  const iterator: AsyncIterator<Int16Array> = {
    async next(): Promise<IteratorResult<Int16Array>> {
      while (true) {
        const chunk = await readChunk();
        if (chunk === null) break;
        const combined = leftover.length > 0 ? Buffer.concat([leftover, chunk]) : chunk;
        const usableBytes = Math.floor(combined.length / 2) * 2;
        if (usableBytes === 0) {
          leftover = combined;
          continue;
        }
        leftover = Buffer.from(combined.subarray(usableBytes));
        // 拷贝到按 2 字节对齐的新 ArrayBuffer，保证 Int16Array 可直接按小端视图构造。
        const buffer = new ArrayBuffer(usableBytes);
        Buffer.from(buffer).set(combined.subarray(0, usableBytes));
        return { done: false, value: new Int16Array(buffer) };
      }

      const exitCode = await waitForProcessExit(child);
      options.signal?.removeEventListener('abort', terminate);

      if (options.signal?.aborted || terminated) {
        throw new FfmpegDecodeError('音频解码已取消');
      }
      if (spawnFailure.error) {
        throw new FfmpegDecodeError(`ffmpeg 启动失败: ${spawnFailure.error.message}`);
      }
      if (exitCode !== 0) {
        throw new FfmpegDecodeError(
          `ffmpeg 退出码 ${exitCode}: ${Buffer.concat(stderrChunks).toString('utf8').trim() || '未知错误'}`,
        );
      }
      return { done: true, value: undefined };
    },
    async return(): Promise<IteratorResult<Int16Array>> {
      terminate();
      options.signal?.removeEventListener('abort', terminate);
      return { done: true, value: undefined };
    },
  };

  return {
    sampleRate: info.sampleRate,
    channels: info.channels,
    totalFrames: info.totalFrames,
    [Symbol.asyncIterator]: () => iterator,
  };
}
