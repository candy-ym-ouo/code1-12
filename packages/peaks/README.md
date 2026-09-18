# @history/peaks

波形峰值（waveform peaks）缓存服务：流式消费大型音频，构建 min/max 金字塔，支持任意
多分辨率读取；**缓存重建与读取并发时绝不返回半成品**。

零运行时依赖（仅 Node.js ≥ 18 内置能力；压缩格式可选依赖系统 `ffmpeg`）。

## 解决什么问题

在时间轴上绘制音频波形时，需要把一条可能长达数小时的音频压缩成与屏幕像素列数相当的
峰值序列。直接对每次缩放/平移都解码整段音频不可接受，因此：

- **流式消费大音频**：解码与构建按块进行，内存占用只与峰值固有体量有关（与音频文件
  大小解耦）。30 分钟、302MB 的立体声 WAV 实测构建堆内存约 5MB。
- **多分辨率读取**：一次构建产出 min/max 金字塔（mipmap）。读取时按「帧范围 + 期望
  桶数（像素列）」自动选择最接近的层级并二次聚合，任意缩放都是 O(桶数)。
- **重建不返回半成品**：同一音频的并发请求只解码一次；构建结果是不可变快照，只有完整
  构建并持久化成功后才通过引用替换对外可见；重建期间读取返回旧快照（stale）或等待，
  绝不会返回构建到一半的金字塔。

## 架构

```
解码层 decoder/
  wav.ts    内置流式 WAV 解析（PCM u8/s16/s24/s32、IEEE f32/f64、Extensible）
  ffmpeg.ts 压缩/容器格式（mp3/m4a/flac/ogg/opus/…）走 ffmpeg → s16le 管道
  audio.ts  自动选择 + WAV 不支持时回退 ffmpeg
构建 builder.ts       分块交错 PCM → 第 0 层极值桶 → finish 确定性两两合并成金字塔
读取 select.ts        按帧范围/桶数选层并聚合为窗口
持久化 store.ts       版本化二进制格式 + CRC32；tmp + fsync + rename 原子落盘
服务 service.ts       每 key 合并构建、RCU 快照、generation 防旧值覆盖、并发闸/失败冷却
HTTP  http.ts         原生 node:http 路由（可独立部署或嵌入现有服务）
```

### 金字塔格式（内存与磁盘一致）

- 第 0 层每个桶覆盖 `baseBlockFrames`（默认 256）个 PCM 帧，记录区间内所有声道样本的
  最小值 / 最大值（Int16）。
- 第 L>0 层由第 L-1 层连续两个桶合并而来，桶数减半、覆盖帧数翻倍；奇数尾桶原样上提，
  保证每层都完整覆盖整条时间轴。

### 磁盘文件（`.pwpk`）

`头(52B, 含载荷 CRC) + 载荷(每层 count + min/max 序列) + 尾(8B, 重复 CRC)`。
写入走「同目录临时文件 → fsync → 原子 rename」，崩溃后正式路径上要么是旧完整文件、
要么是新完整文件，不会出现半成品；读取校验头尾与 CRC，损坏文件自动隔离。

## 用法

### 作为库

```ts
import { PeakCacheService, FilePeakStore } from '@history/peaks';

const service = new PeakCacheService({
  store: { directory: './storage/peaks' }, // 或 new MemoryPeakStore()
  baseBlockFrames: 256,
  buildConcurrency: 2,
});

// 首次：流式解码并构建；并发调用同一文件只解码一次
const { snapshot, status } = await service.getSnapshot(
  { type: 'file', path: '/data/long.wav' },
  { timeoutMs: 30_000 }, // 超时且无旧快照时抛 PeakBuildTimeoutError
);

// 多分辨率窗口读取（同一不可变快照，纯同步）
const win = snapshot.readWindow({
  startFrame: 60 * snapshot.sampleRate,
  endFrame: 120 * snapshot.sampleRate,
  buckets: 1000,
});
// win.mins / win.maxs：Int16Array，长度 <= buckets；win.level 为实际选用层

// 上传管道等非文件来源
await service.getSnapshot({
  type: 'stream',
  meta: { key: recordingId, mtimeMs, sizeBytes },
  open: (signal) => decodeUploadStream(signal),
});

service.invalidate(recordingId); // 失效：中止旧构建、旧构建完成也不覆盖
service.close();
```

返回状态：

- `hit`：命中新鲜的完整快照。
- `stale`：后台重建/失败期间返回的旧完整快照（`snapshot.readWindow({stale:true})`
  会在窗口上标记）。
- `building`：仅 `noWait` 且不存在任何快照时出现，`snapshot` 为 `null`。

### 作为 HTTP 服务

```bash
PEAKS_PORT=4100 PEAKS_CACHE_DIR=./storage/peaks node dist/server.js
```

- `GET /v1/peaks/:key?start=&end=&buckets=&timeoutMs=&noWait=1`
  - 正常返回 `200`，`data.mins/maxs` 为归一化到 -1..1 的数组；
  - 构建中且 `noWait=1` 且无旧快照时返回 `202 {data:{status:'building'}}`；
  - 超时且无旧快照时返回 `503 PEAKS_PENDING`；重建期间有旧快照则返回
    `200` 且 `data.stale === true`。
- `POST /v1/peaks/:key/rebuild` 强制重建（重建期间读旧快照，不出半成品）。
- `GET  /v1/peaks/:key/status`、`GET /health`。

嵌入现有 Fastify/Express 时，用 `createPeakHttpServer` 拿到 `node:http` server，
或直接调用 `PeakCacheService` 并自行实现鉴权与 `key → AudioSource` 解析。

## 脚本

```bash
pnpm --filter @history/peaks build
pnpm --filter @history/peaks typecheck
pnpm --filter @history/peaks test
# 真实大文件端到端（参数为分钟数，默认 30）
node packages/peaks/scripts/e2e-large-wav.mjs 30
```

## 设计要点：为什么并发下不会出现半成品

1. **单一事实来源 + 不可变快照**：对外可读的永远是 `PeakSnapshot` 不可变对象；
   构建器在 `finish()` 前只持有内部可变状态，外部拿不到引用。
2. **先持久化后发布**：构建成功后先 `store.save`（原子 rename），再在每 key 临界区内
   做 generation 校验并用新引用原子替换 `Map` 中的旧引用（RCU）。
3. **同 key 构建合并**：决策在每 key 互斥区完成，进行中的构建只有一个 Promise，
   其余读请求等待它或读取旧快照，绝不触发第二次解码。
4. **generation 防旧值覆盖**：`invalidate` / 强制重建会抬升代号并中止旧构建；旧构建
   即使晚完成，也会因代号不匹配而放弃提交；等待方自动衔接到新一轮构建。
5. **磁盘原子性**：临时文件 + fsync + rename + 目录 fsync；读时校验头尾与 CRC。
