import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import type { Readable } from 'node:stream';
import { ByteStream } from './byte-stream.js';
import { decodeWavStream, UnsupportedWavFormatError, type DecodedWavInfo } from './wav.js';

// 解码入口：
// 1. 所有文件先走内置流式 WAV 解析器（读到前 12 字节即可判断）；
// 2. 非 RIFF/WAVE 或容器内编码不支持（MP3-in-WAV、µ-law 等）时，
//    用 ffmpeg 转成单声道 f32le 原始 PCM 流式消费；
// 3. ffmpeg 不存在时抛 DecodeUnavailableError。
//
// 两条路径都返回输出端的 sampleRate/channels（ffmpeg 统一为单声道），
// 时长由消费到的帧数与输出采样率推出，不依赖容器元数据。

export class DecodeUnavailableError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'DecodeUnavailableError';
  }
}

export interface FrameHandler {
  onFrame(value: number): void;
}

export interface DecodeResult extends DecodedWavInfo {
  decoder: 'wav' | 'ffmpeg';
}

function isWavFallback(error: unknown): boolean {
  if (error instanceof UnsupportedWavFormatError) return true;
  if (error instanceof Error) {
    return (
      error.message.includes('不是 RIFF/WAVE 文件') ||
      error.message.includes('RIFF 文件不是 WAVE 类型')
    );
  }
  return false;
}

async function decodeViaFfmpeg(
  filePath: string,
  handler: FrameHandler,
  ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg',
): Promise<DecodeResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      ffmpegPath,
      [
        '-nostdin',
        '-hide_banner',
        '-loglevel',
        'info',
        '-i',
        filePath,
        '-vn',
        '-ac',
        '1', // 下混单声道；不指定 -ar，保留源采样率
        '-f',
        'f32le',
        'pipe:1',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );

    let settled = false;
    let sampleRate = 0;
    let stderr = '';
    let frameCount = 0;

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
      if (stderr.length > 64 * 1024) stderr = stderr.slice(-32 * 1024);
      if (sampleRate === 0) {
        // 形如: Stream #0:0: Audio: mp3, 44100 Hz, stereo, fltp, 320 kb/s
        const match = /Audio:.*?,\s*(\d+)\s*Hz/.exec(stderr);
        if (match) sampleRate = Number(match[1]);
      }
    });

    const input = new ByteStream(child.stdout as Readable);

    const pump = async (): Promise<void> => {
      for (;;) {
        const frame = await input.readExact(4);
        if (!frame) return;
        handler.onFrame(frame.readFloatLE(0));
        frameCount += 1;
        if ((frameCount & 0xffff) === 0) {
          await new Promise((r) => setImmediate(r));
        }
      }
    };

    const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      if (code !== 0) {
        settled = true;
        reject(new Error(`ffmpeg 解码失败 (code=${code}, signal=${signal}): ${stderr.slice(-500)}`));
        return;
      }
      if (sampleRate === 0) {
        settled = true;
        reject(new Error('ffmpeg 未输出音频流或无法识别采样率'));
        return;
      }
      settled = true;
      resolve({
        decoder: 'ffmpeg',
        sampleRate,
        channels: 1,
        bitsPerSample: 32,
        sampleFormat: 'ieee32',
      });
    };

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        reject(new DecodeUnavailableError(`找不到 ffmpeg 可执行文件: ${ffmpegPath}`, error));
      } else {
        reject(error);
      }
    });
    child.on('close', finish);

    pump().catch((error) => {
      if (!settled) {
        settled = true;
        child.kill('SIGKILL');
        reject(error);
      }
    });
  });
}

/**
 * 流式解码整个音频文件，逐帧回调。调用方负责把帧喂进 PeakAccumulator。
 */
export async function decodeAudioFile(
  filePath: string,
  handler: FrameHandler,
  options: { ffmpegPath?: string } = {},
): Promise<DecodeResult> {
  // 第一次尝试：内置 WAV 解析器。失败后（非 WAV / 不支持的编码）重新开流走 ffmpeg。
  let stream = createReadStream(filePath, { highWaterMark: 256 * 1024 });
  try {
    const result = await decodeWavStream(new ByteStream(stream), handler);
    return { ...result, decoder: 'wav' };
  } catch (error) {
    stream.destroy();
    if (!isWavFallback(error)) throw error;
    return decodeViaFfmpeg(filePath, handler, options.ffmpegPath);
  }
}
