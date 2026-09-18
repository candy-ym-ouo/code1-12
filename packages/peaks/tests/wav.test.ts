import { describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { openWavFile, isLikelyWav, WavDecodeError } from '../src/decoder/wav.js';

/** 生成一个最小合法 WAV（PCM s16le，可指定声道数）。 */
function writeS16Wav(samples: Int16Array, channels: number, sampleRate: number): Buffer {
  const bytesPerSample = 2;
  const dataSize = samples.length * bytesPerSample;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0, 'latin1');
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8, 'latin1');
  buffer.write('fmt ', 12, 'latin1');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channels * bytesPerSample, 28);
  buffer.writeUInt16LE(channels * bytesPerSample, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'latin1');
  buffer.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < samples.length; i++) buffer.writeInt16LE(samples[i], 44 + i * 2);
  return buffer;
}

describe('流式 WAV 解码器', () => {
  it('正确解码立体声 s16 WAV，且支持任意块大小读取', async () => {
    const dir = join(tmpdir(), `wav-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    const file = join(dir, 'stereo.wav');
    const frames = 5000;
    const pcm = new Int16Array(frames * 2);
    for (let i = 0; i < pcm.length; i++) pcm[i] = (i * 9973) % 30001 - 15000;
    await writeFile(file, writeS16Wav(pcm, 2, 44_100));

    for (const chunkBytes of [3, 64, 4096, 1 << 20]) {
      const stream = await openWavFile(file, { chunkBytes });
      expect(stream.sampleRate).toBe(44_100);
      expect(stream.channels).toBe(2);
      expect(stream.totalFrames).toBe(frames);

      const rebuilt: number[] = [];
      for await (const chunk of stream) {
        for (const v of chunk) rebuilt.push(v);
      }
      expect(rebuilt).toEqual(Array.from(pcm));
    }

    expect(await isLikelyWav(file)).toBe(true);
    await rm(dir, { recursive: true, force: true });
  });

  it('对非 WAV 文件返回否定识别', async () => {
    const dir = join(tmpdir(), `wav-no-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    const file = join(dir, 'x.mp3');
    await writeFile(file, Buffer.from('ID3notawav'));
    expect(await isLikelyWav(file)).toBe(false);
    await rm(dir, { recursive: true, force: true });
  });

  it('拒绝损坏的 WAV（缺少 data chunk）', async () => {
    const dir = join(tmpdir(), `wav-bad-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    const file = join(dir, 'bad.wav');
    const buffer = Buffer.alloc(44);
    buffer.write('RIFF', 0, 'latin1');
    buffer.writeUInt32LE(36, 4);
    buffer.write('WAVE', 8, 'latin1');
    buffer.write('fmt ', 12, 'latin1');
    buffer.writeUInt32LE(16, 16);
    buffer.writeUInt16LE(1, 20);
    buffer.writeUInt16LE(1, 22);
    buffer.writeUInt32LE(8000, 24);
    buffer.writeUInt32LE(16000, 28);
    buffer.writeUInt16LE(2, 32);
    buffer.writeUInt16LE(16, 34);
    await writeFile(file, buffer);
    await expect(openWavFile(file)).rejects.toBeInstanceOf(WavDecodeError);
    await rm(dir, { recursive: true, force: true });
  });
});
