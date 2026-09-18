export type {
  PeakLevel,
  PeakPyramid,
  PeakWindow,
  AudioInfo,
  AudioStream,
  AudioSourceMeta,
} from './types.js';

export { StreamingPeakBuilder, type StreamingPeakBuilderOptions } from './builder.js';
export { readWindow, chooseLevel, type ReadWindowOptions } from './select.js';
export { crc32 } from './crc32.js';
export {
  PeakSnapshot,
  FilePeakStore,
  MemoryPeakStore,
  type PeakStore,
} from './store.js';

export {
  PeakCacheService,
  PeakBuildError,
  PeakBuildTimeoutError,
  PeakServiceClosedError,
  type AudioSource,
  type PeakServiceOptions,
  type GetSnapshotOptions,
  type SnapshotResult,
} from './service.js';

export {
  openAudio,
  probeAudio,
  WavDecodeError,
  DecoderUnavailableError,
  FfmpegDecodeError,
  type OpenAudioOptions,
} from './decoder/audio.js';
export { openWavFile, isLikelyWav } from './decoder/wav.js';
export { openFfmpegStream, type FfmpegOptions } from './decoder/ffmpeg.js';

export {
  createPeakHttpServer,
  listen as listenPeakHttpServer,
  type PeakHttpServer,
  type PeakHttpOptions,
  type PeakHttpSourceResolver,
} from './http.js';
