// 端到端验证：流式消费大 WAV、内存占用、磁盘缓存往返与多分辨率读取。
// 用法：node scripts/e2e-large-wav.mjs [分钟数]
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, createWriteStream, statSync, mkdirSync } from 'node:fs';
import { once } from 'node:events';
import {
  PeakCacheService,
  FilePeakStore,
  openAudio,
} from '../dist/index.js';

const minutes = Number(process.argv[2] ?? 30);
const sampleRate = 44_100;
const channels = 2;
const dir = join(tmpdir(), `peaks-e2e-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
const wavPath = join(dir, 'long.wav');
const cacheDir = join(dir, 'cache');

function writeWavHeader(fd, dataSize) {
  const b = Buffer.alloc(44);
  b.write('RIFF', 0, 'latin1');
  b.writeUInt32LE(36 + dataSize, 4);
  b.write('WAVE', 8, 'latin1');
  b.write('fmt ', 12, 'latin1');
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(channels, 22);
  b.writeUInt32LE(sampleRate, 24);
  b.writeUInt32LE(sampleRate * channels * 2, 28);
  b.writeUInt16LE(channels * 2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36, 'latin1');
  b.writeUInt32LE(dataSize, 40);
  // 占位 header，长度在最后回填
  return b;
}

async function generateLargeWav() {
  const totalFrames = sampleRate * 60 * minutes;
  const dataSize = totalFrames * channels * 2;
  const out = createWriteStream(wavPath, { flags: 'wx' });
  out.write(writeWavHeader(0, dataSize));

  const framesPerChunk = sampleRate * 5; // 每次写 5 秒
  const buf = Buffer.alloc(framesPerChunk * channels * 2);
  for (let start = 0; start < totalFrames; start += framesPerChunk) {
    const n = Math.min(framesPerChunk, totalFrames - start);
    for (let f = 0; f < n; f++) {
      const t = start + f;
      for (let c = 0; c < channels; c++) {
        // 混合频率，保证不同尺度都有起伏
        const v =
          0.4 * Math.sin((t / sampleRate) * 2 * Math.PI * (220 + c * 110)) +
          0.3 * Math.sin((t / sampleRate) * 2 * Math.PI * 3) +
          0.2 * Math.sin((t / sampleRate) * 2 * Math.PI * 0.2);
        buf.writeInt16LE(Math.round(v * 20000), (f * channels + c) * 2);
      }
    }
    if (!out.write(buf.subarray(0, n * channels * 2))) await once(out, 'drain');
  }
  out.end();
  await once(out, 'close');
  return totalFrames;
}

const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;

async function main() {
  console.log(`生成 ${minutes} 分钟立体声 WAV ...`);
  const t0 = Date.now();
  const totalFrames = await generateLargeWav();
  const fileBytes = statSync(wavPath).size;
  console.log(`文件: ${wavPath} (${mb(fileBytes)}), ${totalFrames} 帧, 生成耗时 ${Date.now() - t0}ms`);

  // 1) 直接流式解码（只消费、不构建），验证不崩、时长正确
  const t1 = Date.now();
  const stream = await openAudio(wavPath, { chunkBytes: 256 * 1024 });
  let seenFrames = 0;
  for await (const chunk of stream) seenFrames += chunk.length / channels;
  console.log(`流式解码: ${seenFrames} 帧（期望 ${stream.totalFrames}），耗时 ${Date.now() - t1}ms`);
  if (seenFrames !== stream.totalFrames) throw new Error('解码帧数不一致');

  // 2) 通过服务构建（含持久化）
  const service = new PeakCacheService({
    store: { directory: cacheDir },
    baseBlockFrames: 256,
  });
  const t2 = Date.now();
  const result = await service.getSnapshot({ type: 'file', path: wavPath });
  const heapAfterBuild = process.memoryUsage().heapUsed;
  console.log(
    `构建: status=${result.status}, 层数=${result.snapshot.levels.length}, ` +
    `L0桶数=${result.snapshot.levels[0].mins.length}, 耗时 ${Date.now() - t2}ms, ` +
    `堆内存 ${mb(heapAfterBuild)}（音频文件 ${mb(fileBytes)}）`,
  );
  // 峰值数据固有体量约为「帧数 / baseBlockFrames * 4 字节」，与音频文件大小解耦。
  // 以文件大小的 20% 作为宽松上限（1 分钟时约 2 MB，足够容纳运行时常驻）。
  const peakFootprint = (totalFrames / 256) * 4;
  const heapLimit = Math.max(fileBytes * 0.2, peakFootprint * 20 + 20 * 1024 * 1024);
  if (heapAfterBuild > heapLimit) {
    throw new Error(
      `构建期内存占用过高（${mb(heapAfterBuild)} > ${mb(heapLimit)}），疑似未做到流式`,
    );
  }

  // 3) 多分辨率读取
  for (const buckets of [2_000_000, 1000, 100]) {
    const win = result.snapshot.readWindow({ buckets });
    console.log(
      `  buckets<=${buckets}: 选用层 L${win.level}, 返回 ${win.bucketCount} 桶, ` +
      `每桶 ${win.framesPerBucket} 帧 (${(win.framesPerBucket / sampleRate).toFixed(3)}s)`,
    );
    if (win.bucketCount > buckets) throw new Error('返回桶数超过请求');
  }

  // 4) 局部窗口
  const win = result.snapshot.readWindow({
    startFrame: 60 * sampleRate,
    endFrame: 120 * sampleRate,
    buckets: 600,
  });
  console.log(`  局部窗口 60s..120s: ${win.bucketCount} 桶, 起点 ${win.startFrame}, 终点 ${win.endFrame}`);

  service.close();

  // 5) 新服务实例从磁盘加载缓存（无需重新解码）
  const service2 = new PeakCacheService({ store: { directory: cacheDir }, baseBlockFrames: 256 });
  const t3 = Date.now();
  const hit = await service2.getSnapshot({
    type: 'file',
    path: wavPath,
  });
  console.log(`磁盘缓存命中: status=${hit.status}, 加载耗时 ${Date.now() - t3}ms`);
  if (hit.status !== 'hit') throw new Error('期望从磁盘缓存命中');
  const cachedWin = hit.snapshot.readWindow({ buckets: 1000 });
  const freshWin = result.snapshot.readWindow({ buckets: 1000 });
  if (JSON.stringify([...cachedWin.mins]) !== JSON.stringify([...freshWin.mins])) {
    throw new Error('磁盘缓存与内存构建结果不一致');
  }
  console.log('磁盘缓存数据与内存构建一致 ✓');
  service2.close();

  console.log('\n全部端到端检查通过 ✓');
}

main()
  .catch((error) => {
    console.error('端到端验证失败:', error);
    process.exitCode = 1;
  })
  .finally(() => rmSync(dir, { recursive: true, force: true }));
