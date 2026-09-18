import { open } from 'node:fs/promises';
import type { AudioInfo, AudioStream } from '../types.js';

/** WAV 不支持或文件损坏时抛出；上层可据此回退到 ffmpeg。 */
export class WavDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WavDecodeError';
  }
}

const WAVE_FORMAT_PCM = 0x0001;
const WAVE_FORMAT_IEEE_FLOAT = 0x0003;
const WAVE_FORMAT_EXTENSIBLE = 0xfffe;

type SampleFormat = 'u8' | 's16' | 's24' | 's32' | 'f32' | 'f64';

interface ParsedWavHeader extends AudioInfo {
  dataStart: number;
  dataLength: number;
  format: SampleFormat;
  frameBytes: number;
}

/** 顺序读取器，所有读取均在给定字节区间内，越界/截断即报错。 */
class SequentialReader {
  private position: number;

  constructor(
    private readonly fh: import('node:fs/promises').FileHandle,
    private readonly end: number,
    start = 0,
  ) {
    this.position = start;
  }

  get offset(): number {
    return this.position;
  }

  /** 精确读取 size 字节；提前 EOF 时抛出异常（不会返回残缺缓冲）。 */
  async readExact(size: number): Promise<Buffer> {
    if (this.position + size > this.end) {
      throw new WavDecodeError(
        `WAV 数据被截断：需要 ${size} 字节 @${this.position}，文件仅剩 ${this.end - this.position} 字节`,
      );
    }
    const buffer = Buffer.allocUnsafe(size);
    let read = 0;
    while (read < size) {
      const { bytesRead } = await this.fh.read(
        buffer,
        read,
        size - read,
        this.position + read,
      );
      if (bytesRead <= 0) {
        throw new WavDecodeError('WAV 数据被截断：读取时提前到达文件末尾');
      }
      read += bytesRead;
    }
    this.position += size;
    return buffer;
  }

  skip(size: number): void {
    this.position += size;
  }

  seek(position: number): void {
    this.position = position;
  }
}

async function parseHeader(fh: import('node:fs/promises').FileHandle, fileSize: number): Promise<ParsedWavHeader> {
  const reader = new SequentialReader(fh, fileSize);
  const riff = await reader.readExact(12);
  if (riff.toString('latin1', 0, 4) !== 'RIFF' || riff.toString('latin1', 8, 12) !== 'WAVE') {
    throw new WavDecodeError('不是 RIFF/WAVE 文件');
  }

  let audioFormat: number | undefined;
  let channels: number | undefined;
  let sampleRate: number | undefined;
  let blockAlign: number | undefined;
  let bitsPerSample: number | undefined;
  let dataStart: number | undefined;
  let dataLength: number | undefined;

  // 逐个解析 chunk；LIST 等未知 chunk 直接跳过。
  while (reader.offset + 8 <= fileSize) {
    const header = await reader.readExact(8);
    const id = header.toString('latin1', 0, 4);
    const chunkSize = header.readUInt32LE(4);
    const chunkBodyStart = reader.offset;
    if (chunkSize > fileSize - chunkBodyStart) {
      throw new WavDecodeError(`WAV chunk ${id} 声明长度超出文件范围`);
    }

    if (id === 'fmt ') {
      const body = await reader.readExact(Math.min(chunkSize, 40));
      audioFormat = body.readUInt16LE(0);
      channels = body.readUInt16LE(2);
      sampleRate = body.readUInt32LE(4);
      blockAlign = body.readUInt16LE(12);
      bitsPerSample = body.readUInt16LE(14);

      if (audioFormat === WAVE_FORMAT_EXTENSIBLE && chunkSize >= 40) {
        // WAVEFORMATEXTENSIBLE：真实编码位于 SubFormat GUID 的前两个字节。
        const dataFormat = body.readUInt16LE(24);
        audioFormat = dataFormat;
      }
      reader.seek(chunkBodyStart + chunkSize + (chunkSize & 1));
    } else if (id === 'data') {
      dataStart = chunkBodyStart;
      dataLength = chunkSize;
      break;
    } else {
      // chunk 为奇数长度时附带 1 字节填充。
      reader.seek(chunkBodyStart + chunkSize + (chunkSize & 1));
    }
  }

  if (audioFormat === undefined || channels === undefined || sampleRate === undefined) {
    throw new WavDecodeError('WAV 缺少 fmt chunk');
  }
  if (dataStart === undefined || dataLength === undefined) {
    throw new WavDecodeError('WAV 缺少 data chunk');
  }
  if (!Number.isInteger(channels) || channels < 1 || channels > 32) {
    throw new WavDecodeError(`不支持的声道数: ${channels}`);
  }
  if (!Number.isInteger(sampleRate) || sampleRate <= 0) {
    throw new WavDecodeError(`不支持的采样率: ${sampleRate}`);
  }

  let format: SampleFormat;
  if (audioFormat === WAVE_FORMAT_PCM) {
    switch (bitsPerSample) {
      case 8: format = 'u8'; break;
      case 16: format = 's16'; break;
      case 24: format = 's24'; break;
      case 32: format = 's32'; break;
      default:
        throw new WavDecodeError(`不支持的 PCM 位深: ${bitsPerSample}`);
    }
  } else if (audioFormat === WAVE_FORMAT_IEEE_FLOAT) {
    if (bitsPerSample === 32) format = 'f32';
    else if (bitsPerSample === 64) format = 'f64';
    else throw new WavDecodeError(`不支持的浮点位深: ${bitsPerSample}`);
  } else {
    throw new WavDecodeError(
      `压缩 WAV（audioFormat=${audioFormat}）请通过 ffmpeg 解码`,
    );
  }

  const frameBytes = (bitsPerSample! / 8) * channels;
  if (blockAlign !== undefined && blockAlign !== frameBytes) {
    throw new WavDecodeError(
      `WAV blockAlign(${blockAlign}) 与 声道数*位深(${frameBytes}) 不一致`,
    );
  }

  // chunk 声明可能包含尾部填充或超出实际文件，统一夹到可读字节范围。
  const usableLength = Math.max(
    0,
    Math.min(dataLength, fileSize - dataStart) - (dataLength & 1 && dataLength > fileSize - dataStart ? 1 : 0),
  );
  const totalFrames = Math.floor(usableLength / frameBytes);

  return {
    sampleRate,
    channels,
    totalFrames,
    dataStart,
    dataLength: totalFrames * frameBytes,
    format,
    frameBytes,
  };
}

function clampToInt16(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value > 32767) return 32767;
  if (value < -32768) return -32768;
  return value;
}

/** 把一段恰好包含整数帧的 PCM 缓冲转换成交错 Int16Array（跨声道保留全部样本）。 */
function convertPcm(header: ParsedWavHeader, bytes: Buffer): Int16Array {
  const { channels, frameBytes, format } = header;
  const frameCount = bytes.length / frameBytes;
  const out = new Int16Array(frameCount * channels);

  switch (format) {
    case 'u8':
      for (let i = 0, o = 0; i < bytes.length; i++, o++) {
        // 8 位 WAV 是无符号、中点 128。
        out[o] = (bytes[i] - 128) << 8;
      }
      break;
    case 's16':
      for (let i = 0, o = 0; i < bytes.length; i += 2, o++) {
        out[o] = bytes.readInt16LE(i);
      }
      break;
    case 's24':
      for (let frame = 0, offset = 0; frame < frameCount; frame++) {
        for (let channel = 0; channel < channels; channel++, offset += 3) {
          // 拼成有符号 32 位整数后算术右移 8 位。
          const int24 =
            bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
          out[frame * channels + channel] = int24 >> 8;
        }
      }
      break;
    case 's32':
      for (let i = 0, o = 0; i < bytes.length; i += 4, o++) {
        out[o] = bytes.readInt32LE(i) >> 16;
      }
      break;
    case 'f32':
      for (let i = 0, o = 0; i < bytes.length; i += 4, o++) {
        out[o] = clampToInt16(bytes.readFloatLE(i) * 32768);
      }
      break;
    case 'f64':
      for (let i = 0, o = 0; i < bytes.length; i += 8, o++) {
        out[o] = clampToInt16(bytes.readDoubleLE(i) * 32768);
      }
      break;
  }
  return out;
}

export interface OpenWavOptions {
  /** 每次从磁盘读取的块大小（字节），默认 64 KiB。 */
  chunkBytes?: number;
}

/**
 * 打开 PCM/IEEE-float WAV 并流式解码为交错 s16 PCM。
 *
 * 仅持有一个文件句柄和小块读取缓冲，与音频总大小无关；不完整的读取会抛出
 * {@link WavDecodeError}，由上层决定回退 ffmpeg 还是失败。
 */
export async function openWavFile(
  filePath: string,
  options: OpenWavOptions = {},
): Promise<AudioStream> {
  const fh = await open(filePath, 'r');
  let header: ParsedWavHeader;
  try {
    const stat = await fh.stat();
    header = await parseHeader(fh, stat.size);
  } catch (error) {
    await fh.close();
    throw error;
  }

  const chunkBytes = options.chunkBytes ?? 64 * 1024;
  const { frameBytes, dataStart, dataLength } = header;
  let position = dataStart;
  const dataEnd = dataStart + dataLength;
  let carry: Buffer = Buffer.alloc(0);
  let closed = false;
  const closeFile = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await fh.close().catch(() => undefined);
  };

  const iterator: AsyncIterator<Int16Array> = {
    async next(): Promise<IteratorResult<Int16Array>> {
      try {
        let usable: Buffer | null = null;

        while (usable === null) {
          if (position >= dataEnd && carry.length === 0) {
            await closeFile();
            return { done: true, value: undefined };
          }

          const readSize = Math.min(chunkBytes, dataEnd - position);
          let chunk: Buffer;
          if (readSize > 0) {
            chunk = Buffer.allocUnsafe(readSize);
            let read = 0;
            while (read < readSize) {
              const { bytesRead } = await fh.read(chunk, read, readSize - read, position + read);
              if (bytesRead <= 0) break;
              read += bytesRead;
            }
            position += read;
            if (read < readSize) {
              throw new WavDecodeError('WAV data chunk 读取不完整');
            }
          } else {
            chunk = Buffer.alloc(0);
          }

          const combined = carry.length > 0 ? Buffer.concat([carry, chunk]) : chunk;
          const alignedLength = Math.floor(combined.length / frameBytes) * frameBytes;
          if (alignedLength === 0) {
            carry = combined;
            continue;
          }
          usable = combined.subarray(0, alignedLength);
          carry = Buffer.from(combined.subarray(alignedLength));
        }

        return { done: false, value: convertPcm(header, usable) };
      } catch (error) {
        await closeFile();
        throw error;
      }
    },
    async return(): Promise<IteratorResult<Int16Array>> {
      await closeFile();
      return { done: true, value: undefined };
    },
  };

  return {
    sampleRate: header.sampleRate,
    channels: header.channels,
    totalFrames: header.totalFrames,
    [Symbol.asyncIterator]: () => iterator,
  };
}

/** 通过文件头快速判断是否为 RIFF/WAVE，避免对压缩音频做完整解析。 */
export async function isLikelyWav(filePath: string): Promise<boolean> {
  const fh = await open(filePath, 'r');
  try {
    const head = Buffer.allocUnsafe(12);
    const { bytesRead } = await fh.read(head, 0, 12, 0);
    return (
      bytesRead >= 12 &&
      head.toString('latin1', 0, 4) === 'RIFF' &&
      head.toString('latin1', 8, 12) === 'WAVE'
    );
  } catch {
    return false;
  } finally {
    await fh.close();
  }
}
