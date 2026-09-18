# @history/waveform

波形峰值缓存服务：流式消费大音频，构建多分辨率 min/max 峰值金字塔；重建与读取并发时，任何读者都只能拿到"完整快照"或显式标记为 `stale` 的上一份完整快照，绝不返回构建到一半的数据。

## 模块组成

| 文件 | 职责 |
| --- | --- |
| `src/peaks.ts` | `PeakAccumulator`（流式 min/max 累积，Int16 分块存储）、金字塔聚合 `buildPyramid`、多分辨率读取 `readPeaks` |
| `src/wav.ts` | 流式 RIFF/WAVE 解析器（PCM16 / IEEE float32、多声道下混、跳过 LIST 等杂项 chunk） |
| `src/byte-stream.ts` | 带背压的 Readable 小块读取器（`readExact` / `takeMax` / `skip`） |
| `src/decode.ts` | 解码入口：内置 WAV 解析器，非 WAV 或不支持的容器编码走 ffmpeg（`-f f32le -ac 1`）流式管道 |
| `src/cache-file.ts` | WVPK 二进制格式：固定头（含源文件 size/mtime 指纹）+ 各层 Int16 payload + CRC32；临时文件 + `rename` 原子发布 |
| `src/crc.ts` | CRC32（IEEE 802.3） |
| `src/service.ts` | `PeakCacheService`：每 key 状态机 + 互斥决策 + 构建 gate，并发安全门面 |

## 并发模型

每个 key 一个 entry，状态：`empty → building → ready / failed`（重建失败且有旧快照时留在 `ready`）。

- **短临界区 + 锁外等待**：是否启动/附加构建的决策在互斥锁内完成；对构建 promise 的等待在锁外，因此重建不会阻塞同 key 的其他读取，N 个并发冷请求只触发一次解码。
- **单次引用赋值发布**：解码、金字塔构建、磁盘原子 rename 全部完成后，新快照才赋值到 entry；快照本身不可变（`Int16Array` 内容不再被修改）。
- **stale 语义**：源文件指纹（size + mtime）变化触发自动重建，默认等待新结果（旧文件的峰值是错误数据，不能冒充当前文件）；显式 `staleWhileRebuild: true` 时立即返回上一份完整快照并标记 `stale`。
- **失败语义**：构建失败时旧快照保留；无快照时等待者收到错误、entry 进入 `failed`，下次请求重试。

## 多分辨率读取

`readPeaks(snapshot, { width, startMs, endMs, level })`：

- 自动选层：选择范围内桶数 ≥ `width` 的最粗金字塔层（每级时间分辨率 ×2）；
- 输出严格等于 `width` 个桶，每个输出桶由其覆盖的全部源桶的 min/max 聚合（无损）；
- 峰值归一化到 `[-1, 1]`，同时返回实际层级、实际时间边界与总时长。

## 基本用法

```ts
import { PeakCacheService } from '@history/waveform';

const service = new PeakCacheService({
  cacheDir: '/data/storage/waveform',
  samplesPerPeak: 256, // level 0 每桶 256 个单声道采样
});

// 冷启动流式构建并读取；并发调用共享同一次构建
const { buckets, level, durationMs, stale } = await service.read(
  recordingId,
  filePath,
  { width: 1600, startMs: 0, endMs: 30_000 },
);

// 显式强制重建（文件被原地替换等场景）
await service.rebuild(recordingId, filePath);

// 只读窥探，不触发构建
service.peek(recordingId); // { state, snapshot, stale }
```

## 缓存文件格式（WVPK v1，小端）

```
偏移  长度  字段
0     4    magic 'WVPK'
4     2    version（当前 1）
6     2    flags（保留，0）
8     4    samplesPerPeak
12    4    sampleRate
16    2    channels
18    2    levelCount
20    8    totalFrames (u64)
28    8    sourceSize (u64)
36    8    sourceMtimeMs (f64)
44    4    payloadCrc32
48    …    每层：bins(u32) + minPeaks(i16×bins) + maxPeaks(i16×bins)
```

写入为同目录随机临时名 + fsync + `rename`，发布瞬间要么是旧文件要么是完整新文件；magic、长度、CRC、源指纹任一不符即删除重建。
