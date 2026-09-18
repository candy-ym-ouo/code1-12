import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Crc32 } from './crc.js';
import type { WaveformSnapshot } from './peaks.js';

// WVPK（Waveform PeaKs）二进制缓存格式，小端：
//
//   偏移  长度  字段
//   0     4    magic 'WVPK'
//   4     2    version（uint16，当前 1）
//   6     2    flags（uint16，保留，必须为 0）
//   8     4    samplesPerPeak（uint32）
//   12    4    sampleRate（uint32）
//   16    2    channels（uint16）
//   18    2    levelCount（uint16）
//   20    8    totalFrames（uint64，BigInt）
//   28    8    sourceSize（uint64，源音频字节数）
//   36    8    sourceMtimeMs（uint64 double，源文件 mtime）
//   44    4    payloadCrc32（uint32，覆盖其后全部 payload 字节）
//   48    N*4  每层：bins(uint32) + minPeaks(int16 x bins) + maxPeaks(int16 x bins)
//
// 写入策略：先写同目录临时文件再 rename，发布瞬间要么是旧文件要么是完整新文件，
// 读者永远不会读到写了一半的缓存。加载时 magic/版本/长度/CRC/源指纹任一不符即视为
// 缓存过期或损坏，删除并重建。

export const CACHE_VERSION = 1;
const MAGIC = 0x5756504b; // 'WVPK'
const HEADER_SIZE = 48;

export class CacheCorruptError extends Error {
  constructor(
    message: string,
    readonly path: string,
  ) {
    super(message);
    this.name = 'CacheCorruptError';
  }
}

export interface SourceFingerprint {
  size: number;
  mtimeMs: number;
}

interface HeaderView {
  version: number;
  samplesPerPeak: number;
  sampleRate: number;
  channels: number;
  totalFrames: number;
  source: SourceFingerprint;
  levelBins: number[];
  payloadOffset: number;
}

function parseHeader(buffer: Buffer, filePath: string): HeaderView {
  if (buffer.length < HEADER_SIZE) throw new CacheCorruptError('缓存文件小于文件头', filePath);
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  if (view.getUint32(0, false) !== MAGIC) throw new CacheCorruptError('magic 不匹配', filePath);
  const version = view.getUint16(4, true);
  if (version !== CACHE_VERSION) throw new CacheCorruptError(`不支持的缓存版本: ${version}`, filePath);
  if (view.getUint16(6, true) !== 0) throw new CacheCorruptError('flags 非零', filePath);

  const samplesPerPeak = view.getUint32(8, true);
  const sampleRate = view.getUint32(12, true);
  const channels = view.getUint16(16, true);
  const levelCount = view.getUint16(18, true);
  const totalFrames = Number(view.getBigUint64(20, true));
  const source = {
    size: Number(view.getBigUint64(28, true)),
    mtimeMs: view.getFloat64(36, true),
  };
  if (samplesPerPeak === 0 || levelCount === 0 || channels === 0) {
    throw new CacheCorruptError('文件头字段非法', filePath);
  }

  let offset = HEADER_SIZE;
  const levelBins: number[] = [];
  for (let i = 0; i < levelCount; i += 1) {
    if (offset + 4 > buffer.length) throw new CacheCorruptError('层级长度被截断', filePath);
    const bins = view.getUint32(offset, true);
    if (bins === 0) throw new CacheCorruptError('层级桶数为 0', filePath);
    levelBins.push(bins);
    offset += 4 + bins * 4;
  }

  return {
    version,
    samplesPerPeak,
    sampleRate,
    channels,
    totalFrames,
    source,
    levelBins,
    payloadOffset: HEADER_SIZE,
  };
}

export interface LoadedCache {
  snapshot: WaveformSnapshot;
  source: SourceFingerprint;
}

/** 读取并校验缓存文件。校验失败抛 CacheCorruptError（调用方负责删除/重建）。 */
export async function loadCacheFile(filePath: string): Promise<LoadedCache> {
  // Node 20 没有 fs.readFile 的范围读，直接整文件读入；缓存本身很小
  //（一小时音频、256 samples/peak 约数百 KB 量级）。
  const buffer = await readWholeFile(filePath);
  const header = parseHeader(buffer, filePath);

  const crcExpected = new DataView(
    buffer.buffer,
    buffer.byteOffset,
    buffer.byteLength,
  ).getUint32(44, true);
  const crcActual = new Crc32().update(buffer.subarray(header.payloadOffset)).digest();
  if (crcActual !== crcExpected) {
    throw new CacheCorruptError('payload CRC32 校验失败', filePath);
  }

  const levels = [];
  let offset = header.payloadOffset;
  for (const bins of header.levelBins) {
    const min = new Int16Array(bins);
    const max = new Int16Array(bins);
    offset += 4;
    for (let i = 0; i < bins; i += 1) {
      min[i] = buffer.readInt16LE(offset + i * 2);
      max[i] = buffer.readInt16LE(offset + bins * 2 + i * 2);
    }
    levels.push({ min, max });
    offset += bins * 4;
  }
  if (offset !== buffer.length) throw new CacheCorruptError('payload 长度与文件不一致', filePath);

  return {
    snapshot: {
      version: header.version,
      samplesPerPeak: header.samplesPerPeak,
      sampleRate: header.sampleRate,
      channels: header.channels,
      totalFrames: header.totalFrames,
      levels,
    },
    source: header.source,
  };
}

async function readWholeFile(filePath: string): Promise<Buffer> {
  const file = await open(filePath, 'r');
  try {
    const stat = await file.stat();
    const buffer = Buffer.allocUnsafe(stat.size);
    if (stat.size > 0) {
      const { bytesRead } = await file.read({ buffer, offset: 0, length: stat.size, position: 0 });
      if (bytesRead !== stat.size) throw new CacheCorruptError('读取长度不足', filePath);
    }
    return buffer;
  } finally {
    await file.close();
  }
}

/**
 * 原子写入：临时文件（含随机后缀，避免两个重建互相踩）→ fsync → rename。
 * rename 在同目录内是原子的；fsync 目录非 POSIX 强制要求，这里先 fsync 文件。
 */
export async function saveCacheFile(
  filePath: string,
  snapshot: WaveformSnapshot,
  source: SourceFingerprint,
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });

  const levelCount = snapshot.levels.length;
  let payloadSize = 0;
  for (const level of snapshot.levels) payloadSize += 4 + level.min.length * 4;

  const totalSize = HEADER_SIZE + payloadSize;
  const buffer = Buffer.allocUnsafe(totalSize);
  const view = new DataView(buffer.buffer, buffer.byteOffset, totalSize);

  view.setUint32(0, MAGIC, false);
  view.setUint16(4, CACHE_VERSION, true);
  view.setUint16(6, 0, true);
  view.setUint32(8, snapshot.samplesPerPeak, true);
  view.setUint32(12, snapshot.sampleRate, true);
  view.setUint16(16, snapshot.channels, true);
  view.setUint16(18, levelCount, true);
  view.setBigUint64(20, BigInt(snapshot.totalFrames), true);
  view.setBigUint64(28, BigInt(source.size), true);
  view.setFloat64(36, source.mtimeMs, true);
  // CRC 字段位于 44，先留空，payload 从 48 开始写。

  let offset = HEADER_SIZE;
  for (const level of snapshot.levels) {
    const bins = level.min.length;
    view.setUint32(offset, bins, true);
    offset += 4;
    for (let i = 0; i < bins; i += 1) {
      buffer.writeInt16LE(level.min[i]!, offset + i * 2);
      buffer.writeInt16LE(level.max[i]!, offset + bins * 2 + i * 2);
    }
    offset += bins * 4;
  }

  const crc = new Crc32().update(buffer.subarray(HEADER_SIZE)).digest();
  view.setUint32(44, crc, true);

  const tmpPath = `${filePath}.tmp-${process.pid.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const file = await open(tmpPath, 'wx');
  try {
    await file.writeFile(buffer);
    await file.sync();
  } catch (error) {
    await file.close().catch(() => undefined);
    await unlink(tmpPath).catch(() => undefined);
    throw error;
  }
  await file.close();
  await rename(tmpPath, filePath);
}

/** best-effort 删除损坏缓存，删除失败不影响重建流程。 */
export async function evictCacheFile(filePath: string): Promise<void> {
  await unlink(filePath).catch(() => undefined);
}
