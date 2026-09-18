// @history/waveform —— 流式波形峰值缓存服务
//
// - PeakCacheService：缓存/重建/多分辨率读取的对外门面
// - PeakAccumulator / buildPyramid / readPeaks：流式峰值与多分辨率金字塔
// - decodeAudioFile：WAV 内置流式解析 + ffmpeg 兜底
// - 缓存文件格式（WVPK）读写与 CRC32 校验

export {
  PeakCacheService,
  type EntryState,
  type GetOptions,
  type GetResult,
  type PeakCacheServiceOptions,
  type ReadResult,
} from './service.js';

export {
  PeakAccumulator,
  buildPyramid,
  aggregateLevel,
  readPeaks,
  quantizePeak,
  QUANT_MAX,
  QUANT_MIN,
  type PeakBucket,
  type ReadPeaksOptions,
  type ReadPeaksResult,
  type WaveformLevel,
  type WaveformSnapshot,
} from './peaks.js';

export {
  decodeAudioFile,
  DecodeUnavailableError,
  type DecodeResult,
  type FrameHandler,
} from './decode.js';

export {
  decodeWavStream,
  UnsupportedWavFormatError,
  type DecodedWavInfo,
  type WavFrameHandler,
} from './wav.js';

export { ByteStream } from './byte-stream.js';

export {
  loadCacheFile,
  saveCacheFile,
  evictCacheFile,
  CacheCorruptError,
  CACHE_VERSION,
} from './cache-file.js';

export { Crc32 } from './crc.js';
