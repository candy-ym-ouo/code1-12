// 测试用 WAV 生成器：在内存里拼最小 RIFF/WAVE（PCM16 / IEEE float32）。

export interface WavSpec {
  sampleRate: number;
  channels: number;
  /** 每声道采样；多声道时交错。 */
  frames: number[][];
  format?: 'pcm16' | 'ieee32';
  /** 在 data 前插入一个自定义 chunk，测试目录扫描。 */
  extraChunks?: Array<{ id: string; body: Buffer }>;
}

function fourcc(id: string): Buffer {
  return Buffer.from(id, 'ascii');
}

export function buildWav(spec: WavSpec): Buffer {
  const format = spec.format ?? 'pcm16';
  const bitsPerSample = format === 'pcm16' ? 16 : 32;
  const bytesPerSample = bitsPerSample / 8;
  const channels = spec.channels;
  const frameCount = spec.frames.length;
  const dataSize = frameCount * channels * bytesPerSample;

  const fmtBody = Buffer.alloc(16);
  fmtBody.writeUInt16LE(format === 'pcm16' ? 1 : 3, 0);
  fmtBody.writeUInt16LE(channels, 2);
  fmtBody.writeUInt32LE(spec.sampleRate, 4);
  fmtBody.writeUInt32LE(spec.sampleRate * channels * bytesPerSample, 8);
  fmtBody.writeUInt16LE(channels * bytesPerSample, 12);
  fmtBody.writeUInt16LE(bitsPerSample, 14);

  const data = Buffer.alloc(dataSize);
  spec.frames.forEach((frame, fi) => {
    for (let ch = 0; ch < channels; ch += 1) {
      const offset = (fi * channels + ch) * bytesPerSample;
      const value = frame[ch] ?? 0;
      if (format === 'pcm16') {
        const v = Math.max(-32768, Math.min(32767, Math.round(value * 32768)));
        data.writeInt16LE(v, offset);
      } else {
        data.writeFloatLE(value, offset);
      }
    }
  });

  const chunks: Buffer[] = [];
  for (const extra of spec.extraChunks ?? []) {
    const header = Buffer.alloc(8);
    fourcc(extra.id).copy(header, 0);
    header.writeUInt32LE(extra.body.length, 4);
    chunks.push(header, extra.body, extra.body.length % 2 === 1 ? Buffer.from([0]) : Buffer.alloc(0));
  }
  const dataHeader = Buffer.alloc(8);
  fourcc('data').copy(dataHeader, 0);
  dataHeader.writeUInt32LE(dataSize, 4);
  chunks.push(dataHeader, data);

  const riffBody = Buffer.concat([
    (() => {
      const h = Buffer.alloc(8);
      fourcc('fmt ').copy(h, 0);
      h.writeUInt32LE(fmtBody.length, 4);
      return h;
    })(),
    fmtBody,
    ...chunks,
  ]);

  const riff = Buffer.alloc(12);
  fourcc('RIFF').copy(riff, 0);
  riff.writeUInt32LE(riffBody.length + 4, 4);
  fourcc('WAVE').copy(riff, 8);
  return Buffer.concat([riff, riffBody]);
}

/** 把 Buffer 切成指定大小的块，模拟真实流式上传。 */
export function chunkBuffer(buffer: Buffer, sizes: number[]): Buffer[] {
  const out: Buffer[] = [];
  let offset = 0;
  let i = 0;
  while (offset < buffer.length) {
    const size = sizes[i % sizes.length]!;
    out.push(buffer.subarray(offset, Math.min(buffer.length, offset + size)));
    offset += size;
    i += 1;
  }
  return out;
}
