import type { HybridObject } from 'react-native-nitro-modules';

export type VideoCodec = 'h264' | 'hevc';

/** Native encoder options. All times are seconds; bitrates are bits per second. */
export interface NativeCompressOptions {
  maxWidth?: number;
  maxHeight?: number;
  bitrate?: number;
  codec?: VideoCodec;
  /** Maximum output frame rate; frames are dropped, never duplicated. */
  maxFrameRate?: number;
  startTime?: number;
  endTime?: number;
  mute?: boolean;
  audioBitrate?: number;
  audioSampleRate?: number;
  audioChannels?: number;
  outputFileName?: string;
  overwrite?: boolean;
  /** Progress notification interval in milliseconds. Default: 300. */
  progressInterval?: number;
  optimizeForNetworkUse?: boolean;
}

export interface VideoMetadata {
  /** Displayed dimensions, accounting for rotation. */
  width: number;
  height: number;
  duration: number;
  /** Bytes, or 0 when unavailable for an Android content URI. */
  size: number;
  bitrate: number;
  frameRate: number;
  hasAudio: boolean;
  rotation: number;
}

export interface ThumbnailOptions {
  /** Seconds from the beginning of the input. Default: 0. */
  time?: number;
  maxWidth?: number;
  maxHeight?: number;
  /** JPEG quality from 0 to 1. Default: 0.8. */
  quality?: number;
  outputFileName?: string;
  overwrite?: boolean;
}

export interface ThumbnailResult {
  path: string;
  width: number;
  height: number;
}

export interface MediaTransformer extends HybridObject<{
  ios: 'swift';
  android: 'kotlin';
}> {
  compress(
    inputUri: string,
    options: NativeCompressOptions,
    onProgress?: (progress: number) => void
  ): Promise<string>;
  cancelCompress(): Promise<void>;
  getVideoMetadata(inputUri: string): Promise<VideoMetadata>;
  createThumbnail(
    inputUri: string,
    options: ThumbnailOptions
  ): Promise<ThumbnailResult>;
}
