import type {
  NativeCompressOptions,
  ThumbnailOptions,
} from './MediaTransformer.nitro';

export type QualityPreset = 'low' | 'medium' | 'high';
export interface CompressOptions extends NativeCompressOptions {
  /** Preset defaults; explicit options take precedence. Omit for adaptive source-based defaults. */
  quality?: QualityPreset;
}

export const COMPRESSION_PRESETS = Object.freeze({
  low: Object.freeze({
    maxWidth: 640,
    maxHeight: 640,
    bitrate: 700_000,
    audioBitrate: 64_000,
  }),
  medium: Object.freeze({
    maxWidth: 1280,
    maxHeight: 1280,
    bitrate: 2_000_000,
    audioBitrate: 128_000,
  }),
  high: Object.freeze({
    maxWidth: 1920,
    maxHeight: 1920,
    bitrate: 5_000_000,
    audioBitrate: 192_000,
  }),
});

function numberInRange(
  name: string,
  value: unknown,
  min: number,
  max: number,
  integer = false
) {
  if (
    value !== undefined &&
    (typeof value !== 'number' ||
      !Number.isFinite(value) ||
      value < min ||
      value > max ||
      (integer && !Number.isInteger(value)))
  ) {
    throw new TypeError(
      `${name} must be ${integer ? 'an integer' : 'a finite number'} between ${min} and ${max}`
    );
  }
}

function outputName(name: unknown, extension: string) {
  if (
    name !== undefined &&
    (typeof name !== 'string' ||
      !name.trim() ||
      name.includes('/') ||
      name.includes('\\') ||
      [...name].some((character) => character.charCodeAt(0) < 32) ||
      name === '.' ||
      name === '..' ||
      !name.toLowerCase().endsWith(extension))
  ) {
    throw new TypeError(
      `outputFileName must be a filename ending in ${extension}, without directory components`
    );
  }
}

export function validateInput(inputUri: string) {
  if (typeof inputUri !== 'string' || !inputUri.trim()) {
    throw new TypeError('inputUri must be a non-empty string');
  }
}

export function resolveCompressOptions(
  options: CompressOptions = {}
): NativeCompressOptions {
  const { quality, ...overrides } = options;
  if (quality !== undefined && !Object.hasOwn(COMPRESSION_PRESETS, quality)) {
    throw new TypeError('quality must be low, medium, or high');
  }
  // Preserve the original uncapped API when no preset is explicitly requested.
  const result: NativeCompressOptions = {
    ...(quality ? COMPRESSION_PRESETS[quality] : {}),
    ...Object.fromEntries(
      Object.entries(overrides).filter(([, value]) => value !== undefined)
    ),
  };
  for (const key of ['maxWidth', 'maxHeight'] as const)
    numberInRange(key, result[key], 2, 16384, true);
  numberInRange('bitrate', result.bitrate, 1, 2_147_483_647, true);
  numberInRange('maxFrameRate', result.maxFrameRate, 1, 240);
  numberInRange('startTime', result.startTime, 0, 2_147_483);
  numberInRange('endTime', result.endTime, 0, 2_147_483);
  if (result.endTime !== undefined && result.endTime <= (result.startTime ?? 0))
    throw new TypeError('endTime must be greater than startTime');
  numberInRange('audioBitrate', result.audioBitrate, 8000, 320000, true);
  numberInRange('audioChannels', result.audioChannels, 1, 2, true);
  if (
    result.audioSampleRate !== undefined &&
    ![8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000].includes(
      result.audioSampleRate
    )
  )
    throw new TypeError('audioSampleRate must be a supported AAC sample rate');
  numberInRange('progressInterval', result.progressInterval, 50, 10000, true);
  if (result.codec !== undefined && !['h264', 'hevc'].includes(result.codec))
    throw new TypeError('codec must be h264 or hevc');
  for (const key of ['mute', 'overwrite', 'optimizeForNetworkUse'] as const) {
    if (result[key] !== undefined && typeof result[key] !== 'boolean')
      throw new TypeError(`${key} must be a boolean`);
  }
  outputName(result.outputFileName, '.mp4');
  return result;
}

export function validateThumbnailOptions(options: ThumbnailOptions) {
  numberInRange('time', options.time, 0, 2_147_483);
  for (const key of ['maxWidth', 'maxHeight'] as const)
    numberInRange(key, options[key], 2, 16384, true);
  numberInRange('quality', options.quality, 0, 1);
  if (options.overwrite !== undefined && typeof options.overwrite !== 'boolean')
    throw new TypeError('overwrite must be a boolean');
  outputName(options.outputFileName, '.jpg');
}
