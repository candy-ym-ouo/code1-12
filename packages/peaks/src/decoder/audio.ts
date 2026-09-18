import type { AudioStream } from '../types.js';
import { isLikelyWav, openWavFile, WavDecodeError } from './wav.js';
import { openFfmpegStream, type FfmpegOptions } from './ffmpeg.js';

export { WavDecodeError } from './wav.js';
export { DecoderUnavailableError, FfmpegDecodeError, probeAudio } from './ffmpeg.js';

export interface OpenAudioOptions extends FfmpegOptions {
  chunkBytes?: number;
}

/**
 * 打开音频并流式解码为交错 s16 PCM。
 *
 * - WAV（PCM / IEEE float，8/16/24/32 位）走内置零依赖流式解析器；
 * - 其它容器/编码（mp3、m4a、flac、ogg、opus、压缩 WAV 等）走 ffmpeg 管道；
 * - WAV 解析中途发现不支持（如压缩格式），自动回退 ffmpeg。
 */
export async function openAudio(filePath: string, options: OpenAudioOptions = {}): Promise<AudioStream> {
  if (await isLikelyWav(filePath)) {
    try {
      return await openWavFile(filePath, { chunkBytes: options.chunkBytes });
    } catch (error) {
      // 压缩 WAV / 非标准 WAV：交给 ffmpeg 再试一次。
      if (error instanceof WavDecodeError && error.message.includes('ffmpeg')) {
        return openFfmpegStream(filePath, options);
      }
      throw error;
    }
  }
  return openFfmpegStream(filePath, options);
}
