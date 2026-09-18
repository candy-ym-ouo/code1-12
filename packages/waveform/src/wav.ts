import { ByteStream } from './byte-stream.js';

// 流式 RIFF/WAVE 解析器：只扫描文件头与 chunk 目录，音频数据块按帧泵方式
// 边到达边消费，从不把整个文件读入内存。
//
// 支持：PCM 16-bit、IEEE float 32-bit（含 WAVEFORMATEXTENSIBLE 包装），
// 任意声道数（帧回调中做下混）。其余编码（µ-law、ADPCM、MP3-in-WAV 等）
// 抛 UnsupportedWavFormatError，由上层走 ffmpeg 兜底。

const RIFF_MAGIC = 0x52494646; // 'RIFF'
const WAVE_MAGIC = 0x57415645; // 'WAVE'
const FMT_MAGIC = 0x666d7420; // 'fmt '
const DATA_MAGIC = 0x64617461; // 'data'

const WAVE_FORMAT_PCM = 0x0001;
const WAVE_FORMAT_IEEE_FLOAT = 0x0003;
const WAVE_FORMAT_EXTENSIBLE = 0xfffe;

export class UnsupportedWavFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedWavFormatError';
  }
}

export interface DecodedWavInfo {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  /** 'pcm16' | 'ieee32' */
  sampleFormat: 'pcm16' | 'ieee32';
}

export interface WavFrameHandler {
  /** 每帧（一个时间点上全部声道的采样）调用一次，value 为下混后的 [-1,1]。 */
  onFrame(value: number): void;
}

function asciiId(buffer: Buffer): number {
  return (
    (buffer[0]! << 24) |
    (buffer[1]! << 16) |
    (buffer[2]! << 8) |
    buffer[3]!
  );
}

interface FmtChunk {
  formatTag: number;
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  extensionData1?: number;
}

async function readFmtBody(input: ByteStream, bodySize: number): Promise<FmtChunk> {
  const body = await input.readExact(bodySize);
  if (!body) throw new Error('WAV fmt 块被截断');
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  if (bodySize < 16) throw new UnsupportedWavFormatError('WAV fmt 块长度不足');

  const fmt: FmtChunk = {
    formatTag: view.getUint16(0, true),
    channels: view.getUint16(2, true),
    sampleRate: view.getUint32(4, true),
    bitsPerSample: view.getUint16(14, true),
  };

  if (fmt.formatTag === WAVE_FORMAT_EXTENSIBLE) {
    // 标准 16 字节后：cbSize(2) + ValidBitsPerSample(2) + ChannelMask(4)
    // + SubFormat(16)，SubFormat GUID 前 4 字节即 Data1。
    if (bodySize < 40) throw new UnsupportedWavFormatError('WAV extensible fmt 块被截断');
    fmt.extensionData1 = view.getUint32(24, true);
  }
  return fmt;
}

function describeFormat(fmt: FmtChunk): DecodedWavInfo {
  const effectiveTag =
    fmt.formatTag === WAVE_FORMAT_EXTENSIBLE ? (fmt.extensionData1 ?? -1) : fmt.formatTag;

  let sampleFormat: DecodedWavInfo['sampleFormat'];
  if (effectiveTag === WAVE_FORMAT_PCM && fmt.bitsPerSample === 16) {
    sampleFormat = 'pcm16';
  } else if (effectiveTag === WAVE_FORMAT_IEEE_FLOAT && fmt.bitsPerSample === 32) {
    sampleFormat = 'ieee32';
  } else {
    throw new UnsupportedWavFormatError(
      `不支持的 WAV 采样格式: tag=${fmt.formatTag} bits=${fmt.bitsPerSample}`,
    );
  }
  if (fmt.channels === 0) throw new UnsupportedWavFormatError('WAV 声道数为 0');
  if (fmt.sampleRate === 0) throw new UnsupportedWavFormatError('WAV 采样率为 0');

  return {
    sampleRate: fmt.sampleRate,
    channels: fmt.channels,
    bitsPerSample: fmt.bitsPerSample,
    sampleFormat,
  };
}

const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/**
 * 从 WAV 字节流解码。返回格式信息；每个解码帧调用 handler.onFrame。
 * data 块大小未知（流式 WAV 占位等）时读到流结尾。
 */
export async function decodeWavStream(
  input: ByteStream,
  handler: WavFrameHandler,
): Promise<DecodedWavInfo> {
  const riffHeader = await input.readExact(12);
  if (!riffHeader) throw new Error('文件为空，无法解析 WAV 头');
  const riffView = new DataView(riffHeader.buffer, riffHeader.byteOffset, riffHeader.byteLength);
  if (riffView.getUint32(0, false) !== RIFF_MAGIC) throw new Error('不是 RIFF/WAVE 文件');
  if (riffView.getUint32(8, false) !== WAVE_MAGIC) {
    throw new Error('RIFF 文件不是 WAVE 类型');
  }

  let fmt: FmtChunk | null = null;
  let dataSize = -1;

  // 扫描 chunk 目录直到找到 data。chunk 体按偶数字节对齐。
  for (;;) {
    const header = await input.readExact(8);
    if (!header) {
      // 某些流式 WAV 只有头没有 data：有 fmt 时按 0 帧处理。
      if (fmt) return describeFormat(fmt);
      throw new Error('WAV 文件缺少 data 块');
    }
    const chunkId = asciiId(header);
    const headerView = new DataView(header.buffer, header.byteOffset, header.byteLength);
    const chunkSize = headerView.getUint32(4, true);

    if (chunkId === FMT_MAGIC) {
      fmt = await readFmtBody(input, chunkSize);
      if (chunkSize % 2 === 1) await input.skip(1);
    } else if (chunkId === DATA_MAGIC) {
      dataSize = chunkSize;
      break;
    } else {
      // LIST/fact/bext 等整块跳过。
      const skipped = await input.skip(chunkSize + (chunkSize % 2));
      if (!skipped) {
        if (fmt) return describeFormat(fmt);
        throw new Error('WAV chunk 目录被截断');
      }
    }
  }

  if (!fmt) throw new UnsupportedWavFormatError('WAV 文件缺少 fmt 块');
  const info = describeFormat(fmt);
  const bytesPerSample = info.bitsPerSample / 8;
  const frameSize = bytesPerSample * info.channels;
  const dataBytes = dataSize >= 0 ? dataSize : Number.POSITIVE_INFINITY;

  let frameCount = 0;
  let consumed = 0; // 已消费的 data 字节数
  let pending: Buffer = Buffer.alloc(0); // 跨块的半帧

  const emitFrame = (frame: Buffer): void => {
    let sum = 0;
    for (let ch = 0; ch < info.channels; ch += 1) {
      const offset = ch * bytesPerSample;
      if (info.sampleFormat === 'pcm16') {
        sum += frame.readInt16LE(offset) / 32768;
      } else {
        sum += frame.readFloatLE(offset);
      }
    }
    handler.onFrame(sum / info.channels);
    frameCount += 1;
  };

  // 帧泵：攒到完整帧再解析；不完整的尾巴留到下一块，流结束后丢弃。
  const pump = (chunk: Buffer): void => {
    let data = chunk;
    if (pending.length > 0) {
      const need = frameSize - pending.length;
      const take = Math.min(need, data.length);
      pending = Buffer.concat([pending, data.subarray(0, take)]);
      data = data.subarray(take);
      if (pending.length === frameSize) {
        emitFrame(pending);
        pending = Buffer.alloc(0);
      }
    }
    const wholeBytes = Math.floor(data.length / frameSize) * frameSize;
    for (let offset = 0; offset < wholeBytes; offset += frameSize) {
      emitFrame(data.subarray(offset, offset + frameSize));
    }
    if (data.length > wholeBytes) {
      pending = pending.length > 0 ? Buffer.concat([pending, data.subarray(wholeBytes)]) : data.subarray(wholeBytes);
    }
  };

  for (;;) {
    const remaining =
      dataBytes === Number.POSITIVE_INFINITY ? Number.POSITIVE_INFINITY : dataBytes - consumed;
    if (remaining <= 0) break;

    const chunk = input.takeMax(1 << 20);
    if (chunk.length === 0) {
      if (input.ended) break;
      await yieldToEventLoop();
      continue;
    }

    const usable =
      remaining === Number.POSITIVE_INFINITY
        ? chunk
        : chunk.subarray(0, Math.min(chunk.length, remaining));
    pump(usable);
    consumed += usable.length;
    if ((frameCount & 0xffff) === 0) await yieldToEventLoop();
  }

  return info;
}
