import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { ByteStream, decodeWavStream, UnsupportedWavFormatError } from '../src/index.js';
import { buildWav, chunkBuffer } from './helpers/wav.js';

function toReadable(buffer: Buffer, chunkSizes = [4096]): Readable {
  const chunks = chunkBuffer(buffer, chunkSizes);
  return Readable.from(chunks);
}

describe('ByteStream', () => {
  it('readExact 跨 chunk 拼接，结尾返回 null', async () => {
    const input = new ByteStream(toReadable(Buffer.from([1, 2, 3, 4, 5, 6, 7]), [3]));
    const a = await input.readExact(4);
    expect(Array.from(a!)).toEqual([1, 2, 3, 4]);
    const b = await input.readExact(3);
    expect(Array.from(b!)).toEqual([5, 6, 7]);
    await expect(input.readExact(1)).resolves.toBeNull();
  });

  it('takeMax 返回不超过请求长度的可用字节', async () => {
    const input = new ByteStream(toReadable(Buffer.from([1, 2, 3, 4, 5]), [2]));
    // 首块尚未到达时允许返回空
    let first = input.takeMax(2);
    if (first.length === 0) {
      await new Promise((r) => setImmediate(r));
      first = input.takeMax(2);
    }
    expect(first.length).toBeLessThanOrEqual(2);
    expect(first.length).toBeGreaterThan(0);
  });

  it('skip 跨越块边界', async () => {
    const input = new ByteStream(toReadable(Buffer.from([0, 0, 1, 2, 3]), [2]));
    expect(await input.skip(2)).toBe(true);
    const rest = await input.readExact(3);
    expect(Array.from(rest!)).toEqual([1, 2, 3]);
    expect(await input.skip(1)).toBe(false);
  });
});

describe('decodeWavStream', () => {
  it('PCM16 单声道精确解码', async () => {
    const wav = buildWav({
      sampleRate: 8000,
      channels: 1,
      frames: [[0], [0.5], [-0.5], [1], [-1]],
      format: 'pcm16',
    });
    const frames: number[] = [];
    const info = await decodeWavStream(new ByteStream(toReadable(wav, [37])), {
      onFrame: (v) => frames.push(v),
    });
    expect(info).toMatchObject({ sampleRate: 8000, channels: 1, sampleFormat: 'pcm16' });
    expect(frames[0]).toBe(0);
    expect(frames[1]).toBeCloseTo(0.5, 2);
    expect(frames[2]).toBeCloseTo(-0.5, 2);
    expect(frames[3]).toBeCloseTo(1, 2);
    expect(frames[4]).toBeCloseTo(-1, 2);
  });

  it('多声道下混为平均值', async () => {
    const wav = buildWav({
      sampleRate: 16000,
      channels: 2,
      frames: [
        [0.5, -0.5],
        [0.2, 0.4],
      ],
      format: 'pcm16',
    });
    const frames: number[] = [];
    await decodeWavStream(new ByteStream(toReadable(wav, [5])), {
      onFrame: (v) => frames.push(v),
    });
    expect(frames[0]).toBeCloseTo(0, 3);
    expect(frames[1]).toBeCloseTo(0.3, 2);
  });

  it('IEEE float32 解码（含 >1 的超调值，峰值不被截断）', async () => {
    const wav = buildWav({
      sampleRate: 48000,
      channels: 1,
      frames: [[1.2], [-1.4]],
      format: 'ieee32',
    });
    const frames: number[] = [];
    const info = await decodeWavStream(new ByteStream(toReadable(wav, [11])), {
      onFrame: (v) => frames.push(v),
    });
    expect(info.sampleFormat).toBe('ieee32');
    expect(frames[0]).toBeCloseTo(1.2, 5);
    expect(frames[1]).toBeCloseTo(-1.4, 5);
  });

  it('跳过 fmt 与 data 之间的未知 chunk（LIST）', async () => {
    const listBody = Buffer.from('some playlist metadata padding');
    const wav = buildWav({
      sampleRate: 8000,
      channels: 1,
      frames: [[0.25], [-0.25]],
      extraChunks: [{ id: 'LIST', body: listBody }],
    });
    const frames: number[] = [];
    await decodeWavStream(new ByteStream(toReadable(wav, [13])), {
      onFrame: (v) => frames.push(v),
    });
    expect(frames).toHaveLength(2);
    expect(frames[0]).toBeCloseTo(0.25, 2);
  });

  it('奇数长度 chunk 的 padding 字节被正确跳过', async () => {
    const wav = buildWav({
      sampleRate: 8000,
      channels: 1,
      frames: [[0.1], [-0.1]],
      extraChunks: [{ id: 'bext', body: Buffer.from('x') }], // 1 字节 + 1 padding
    });
    const frames: number[] = [];
    await decodeWavStream(new ByteStream(toReadable(wav, [7])), {
      onFrame: (v) => frames.push(v),
    });
    expect(frames).toHaveLength(2);
  });

  it('非 RIFF 文件抛错（触发 ffmpeg 回退判断）', async () => {
    await expect(
      decodeWavStream(new ByteStream(Readable.from([Buffer.from('ID3\x03otherbytes')])), {
        onFrame() {},
      }),
    ).rejects.toThrow(/RIFF/);
  });

  it('不支持的编码抛 UnsupportedWavFormatError', async () => {
    // µ-law: format tag 7, 8-bit
    const fmt = Buffer.alloc(16);
    fmt.writeUInt16LE(7, 0);
    fmt.writeUInt16LE(1, 2);
    fmt.writeUInt32LE(8000, 4);
    fmt.writeUInt32LE(8000, 8);
    fmt.writeUInt16LE(1, 12);
    fmt.writeUInt16LE(8, 14);
    const fmtChunk = Buffer.concat([Buffer.from('fmt ', ), Buffer.from([16, 0, 0, 0]), fmt]);
    const dataBody = Buffer.from([128, 200]);
    const dataChunk = Buffer.concat([Buffer.from('data'), Buffer.from([2, 0, 0, 0]), dataBody]);
    const body = Buffer.concat([fmtChunk, dataChunk]);
    const header = Buffer.alloc(12);
    Buffer.from('RIFF').copy(header, 0);
    header.writeUInt32LE(body.length + 4, 4);
    Buffer.from('WAVE').copy(header, 8);
    const wav = Buffer.concat([header, body]);

    await expect(
      decodeWavStream(new ByteStream(Readable.from([wav])), { onFrame() {} }),
    ).rejects.toBeInstanceOf(UnsupportedWavFormatError);
  });

  it('大文件逐块消费结果与帧数一致（流确定性）', async () => {
    const frames = Array.from({ length: 5000 }, (_, i) => [Math.sin(i * 0.05)]);
    const wav = buildWav({ sampleRate: 22050, channels: 1, frames, format: 'pcm16' });

    const runs: number[][] = [];
    for (const sizes of [
      [16],
      [100, 3, 4096, 17],
      [wav.length],
    ]) {
      const seen: number[] = [];
      await decodeWavStream(new ByteStream(toReadable(wav, sizes)), {
        onFrame: (v) => seen.push(v),
      });
      runs.push(seen);
    }
    for (const seen of runs) expect(seen).toHaveLength(frames.length);
    for (let i = 0; i < frames.length; i += 1) {
      expect(runs[0]![i]).toBeCloseTo(runs[1]![i]!, 4);
      expect(runs[0]![i]).toBeCloseTo(runs[2]![i]!, 4);
    }
  });
});
