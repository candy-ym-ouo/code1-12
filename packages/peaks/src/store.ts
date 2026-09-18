import {
  mkdir,
  open,
  rename,
  unlink,
  readFile,
  readdir,
} from 'node:fs/promises';
import path from 'node:path';
import { crc32 } from './crc32.js';
import { readWindow, type ReadWindowOptions } from './select.js';
import type { AudioSourceMeta, PeakPyramid, PeakWindow } from './types.js';

/**
 * 峰值文件格式 v1（小端序）：
 *
 *   magic            4B   "PWPK"
 *   version          1B   1
 *   flags            1B   保留，写入为 0
 *   headerLength     2B   头长度（=52），允许未来向前扩展
 *   payloadCrc32     4B   载荷 CRC32
 *   baseBlockFrames  4B
 *   sampleRate       4B
 *   channels         2B
 *   levelCount       2B
 *   totalFrames      8B
 *   sourceMtimeMs    8B   构建时音频文件 mtime（-1 表示未知）
 *   sourceSize       8B   构建时音频文件大小（-1 表示未知）
 *   payload:
 *     per level: count(4B), min1,max1,...（每个 int16）
 *   footer:
 *     magic            4B   "PWPE"
 *     payloadCrc32     4B   尾部分重复一份载荷 CRC
 *
 * 写入采用「临时文件 + fsync + 原子 rename」，任何时刻正式路径上只存在
 * 完整文件；读取时校验头尾、长度与 CRC，拒绝半成品。
 */

const MAGIC = Buffer.from('PWPK', 'latin1');
const FOOTER_MAGIC = Buffer.from('PWPE', 'latin1');
const FORMAT_VERSION = 1;
const HEADER_LENGTH = 52;
const FOOTER_LENGTH = 8;

/** 已经加载到内存、不可变的金字塔；读取操作直接在此对象上进行。 */
export class PeakSnapshot implements PeakPyramid {
  readonly key: string;
  readonly baseBlockFrames: number;
  readonly sampleRate: number;
  readonly channels: number;
  readonly totalFrames: number;
  readonly levels: PeakPyramid['levels'];
  readonly sourceMtimeMs: number;
  readonly sourceSize: number;

  constructor(
    key: string,
    pyramid: PeakPyramid,
    sourceMtimeMs = -1,
    sourceSize = -1,
  ) {
    this.key = key;
    this.baseBlockFrames = pyramid.baseBlockFrames;
    this.sampleRate = pyramid.sampleRate;
    this.channels = pyramid.channels;
    this.totalFrames = pyramid.totalFrames;
    this.levels = pyramid.levels;
    this.sourceMtimeMs = sourceMtimeMs;
    this.sourceSize = sourceSize;
  }

  /** 多分辨率窗口读取，语义见 {@link readWindow}。 */
  readWindow(options: ReadWindowOptions = {}): PeakWindow {
    return readWindow(this, options);
  }

  /** 快照对应的源文件元信息，是否与当前源文件一致由服务层判断。 */
  matches(meta: AudioSourceMeta): boolean {
    if (meta.mtimeMs !== undefined && this.sourceMtimeMs >= 0) {
      return Math.trunc(meta.mtimeMs) === this.sourceMtimeMs;
    }
    if (meta.sizeBytes !== undefined && this.sourceSize >= 0) {
      return meta.sizeBytes === this.sourceSize;
    }
    return true;
  }
}

/** 把金字塔序列化为「头 + 载荷 + 尾」的完整缓冲（峰值缓存通常仅数 MB，可直接放内存）。 */
function serialize(snapshot: PeakSnapshot): Buffer {
  const payloadParts: Buffer[] = [];
  for (const level of snapshot.levels) {
    const header = Buffer.alloc(4);
    header.writeUInt32LE(level.mins.length, 0);
    const body = Buffer.alloc(level.mins.length * 4);
    for (let i = 0; i < level.mins.length; i++) {
      body.writeInt16LE(level.mins[i], i * 4);
      body.writeInt16LE(level.maxs[i], i * 4 + 2);
    }
    payloadParts.push(header, body);
  }
  const payload = Buffer.concat(payloadParts);
  const checksum = crc32(payload);

  const header = Buffer.alloc(HEADER_LENGTH);
  let offset = 0;
  MAGIC.copy(header, offset); offset += 4;
  header[offset++] = FORMAT_VERSION;
  header[offset++] = 0; // flags
  header.writeUInt16LE(HEADER_LENGTH, offset); offset += 2;
  header.writeUInt32LE(checksum, offset); offset += 4;
  header.writeUInt32LE(snapshot.baseBlockFrames, offset); offset += 4;
  header.writeUInt32LE(snapshot.sampleRate, offset); offset += 4;
  header.writeUInt16LE(snapshot.channels, offset); offset += 2;
  header.writeUInt16LE(snapshot.levels.length, offset); offset += 2;
  header.writeBigInt64LE(BigInt(snapshot.totalFrames), offset); offset += 8;
  header.writeBigInt64LE(BigInt(snapshot.sourceMtimeMs), offset); offset += 8;
  header.writeBigInt64LE(BigInt(snapshot.sourceSize), offset); offset += 8;

  const footer = Buffer.alloc(FOOTER_LENGTH);
  FOOTER_MAGIC.copy(footer, 0);
  footer.writeUInt32LE(checksum, 4);

  return Buffer.concat([header, payload, footer]);
}

function deserialize(key: string, file: Buffer): PeakSnapshot {
  if (file.length < HEADER_LENGTH + FOOTER_LENGTH) {
    throw new Error('峰值文件长度不足');
  }
  if (!file.subarray(0, 4).equals(MAGIC)) {
    throw new Error('峰值文件 magic 不匹配');
  }
  if (file[4] !== FORMAT_VERSION) {
    throw new Error(`不支持的峰值文件版本: ${file[4]}`);
  }
  const declaredHeaderLength = file.readUInt16LE(6);
  if (declaredHeaderLength !== HEADER_LENGTH) {
    throw new Error(`峰值文件头长度异常: ${declaredHeaderLength}`);
  }
  if (!file.subarray(file.length - 8, file.length - 4).equals(FOOTER_MAGIC)) {
    throw new Error('峰值文件缺少完整尾部（疑似写入中途崩溃）');
  }

  const headerCrc = file.readUInt32LE(8);
  const baseBlockFrames = file.readUInt32LE(12);
  const sampleRate = file.readUInt32LE(16);
  const channels = file.readUInt16LE(20);
  const levelCount = file.readUInt16LE(22);
  const totalFrames = Number(file.readBigInt64LE(24));
  const sourceMtimeMs = Number(file.readBigInt64LE(32));
  const sourceSize = Number(file.readBigInt64LE(40));
  const footerCrc = file.readUInt32LE(file.length - 4);
  if (headerCrc !== footerCrc) {
    throw new Error('峰值文件头尾 CRC 不一致');
  }

  const payloadEnd = file.length - FOOTER_LENGTH;
  if (crc32(file, HEADER_LENGTH, payloadEnd) !== headerCrc) {
    throw new Error('峰值文件载荷 CRC 校验失败');
  }

  let offset = HEADER_LENGTH;
  const levels: PeakPyramid['levels'] = [];
  for (let level = 0; level < levelCount; level++) {
    if (offset + 4 > payloadEnd) throw new Error('峰值文件层级声明超出载荷范围');
    const count = file.readUInt32LE(offset);
    offset += 4;
    const bytesNeeded = count * 4;
    if (offset + bytesNeeded > payloadEnd) {
      throw new Error('峰值文件层级数据不完整');
    }
    const mins = new Int16Array(count);
    const maxs = new Int16Array(count);
    for (let i = 0; i < count; i++) {
      mins[i] = file.readInt16LE(offset + i * 4);
      maxs[i] = file.readInt16LE(offset + i * 4 + 2);
    }
    offset += bytesNeeded;
    levels.push({ mins, maxs });
  }
  if (offset !== payloadEnd) {
    throw new Error('峰值文件载荷存在未声明的尾随数据');
  }

  return new PeakSnapshot(
    key,
    { baseBlockFrames, sampleRate, channels, totalFrames, levels },
    sourceMtimeMs,
    sourceSize,
  );
}

/** 峰值快照的持久化抽象：默认实现 {@link FilePeakStore}，测试可用内存实现。 */
export interface PeakStore {
  load(meta: AudioSourceMeta): Promise<PeakSnapshot | undefined>;
  save(snapshot: PeakSnapshot): Promise<void>;
  remove(key: string): Promise<void>;
}

/**
 * 文件系统存储。正式文件只通过原子 rename 出现：
 *   <dir>/<key>.pwpk.tmp.<pid>.<rand>  →  fsync  →  rename → <dir>/<key>.pwpk
 */
export class FilePeakStore implements PeakStore {
  constructor(private readonly directory: string) {}

  private targetPath(key: string): string {
    return path.join(this.directory, `${sanitizeKey(key)}.pwpk`);
  }

  async load(meta: AudioSourceMeta): Promise<PeakSnapshot | undefined> {
    const filePath = this.targetPath(meta.key);
    let file: Buffer;
    try {
      file = await readFile(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }

    try {
      return deserialize(meta.key, file);
    } catch (error) {
      // 绝不使用损坏/半成品缓存；改名隔离，避免每次请求重复解析。
      const quarantine = `${filePath}.corrupt-${Date.now()}`;
      await rename(filePath, quarantine).catch(() => undefined);
      throw new Error(
        `峰值缓存文件已损坏并隔离（${quarantine}）: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  async save(snapshot: PeakSnapshot): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const target = this.targetPath(snapshot.key);
    const temporary = path.join(
      this.directory,
      `.${sanitizeKey(snapshot.key)}.pwpk.tmp.${process.pid}.${Math.random().toString(36).slice(2, 10)}`,
    );

    const buffer = serialize(snapshot);
    let fh: import('node:fs/promises').FileHandle | undefined;
    try {
      fh = await open(temporary, 'wx');
      await fh.write(buffer, 0, buffer.length, 0);
      await fh.sync();
      await fh.close();
      fh = undefined;
      await rename(temporary, target);
      await fsyncDirectory(this.directory);
    } catch (error) {
      if (fh) await fh.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  async remove(key: string): Promise<void> {
    await unlink(this.targetPath(key)).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    });
  }

  /** 启动时清理上一次崩溃可能残留的临时文件。 */
  async cleanupTemporary(): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(this.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    await Promise.all(
      entries
        .filter((name) => name.endsWith('.tmp') || name.includes('.pwpk.tmp.'))
        .map((name) => unlink(path.join(this.directory, name)).catch(() => undefined)),
    );
  }
}

async function fsyncDirectory(directory: string): Promise<void> {
  const fh = await open(directory, 'r');
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
}

/** key 来自外部输入，文件名只保留安全字符。 */
function sanitizeKey(key: string): string {
  const sanitized = key.replace(/[^a-zA-Z0-9._-]/g, '_');
  return sanitized.length > 180 ? sanitized.slice(-180) : sanitized;
}

/** 进程内 map 存储，便于测试和无盘部署。 */
export class MemoryPeakStore implements PeakStore {
  private readonly snapshots = new Map<string, PeakSnapshot>();

  async load(meta: AudioSourceMeta): Promise<PeakSnapshot | undefined> {
    return this.snapshots.get(meta.key);
  }

  async save(snapshot: PeakSnapshot): Promise<void> {
    this.snapshots.set(snapshot.key, snapshot);
  }

  async remove(key: string): Promise<void> {
    this.snapshots.delete(key);
  }
}
