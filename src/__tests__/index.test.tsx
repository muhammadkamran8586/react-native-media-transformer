import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { MediaTransformer } from '../MediaTransformer.nitro';
import { resolveCompressOptions } from '../options';

jest.mock('react-native-nitro-modules', () => ({
  NitroModules: { createHybridObject: jest.fn() },
}));

function setup() {
  const api: typeof import('../index') = require('../index');
  const { NitroModules } = require('react-native-nitro-modules');
  const instances: ReturnType<typeof mockNative>[] = [];
  NitroModules.createHybridObject.mockImplementation(() => {
    const native = mockNative();
    instances.push(native);
    return native;
  });
  return { api, instances, create: NitroModules.createHybridObject };
}

function mockNative() {
  return {
    compress: jest
      .fn<MediaTransformer['compress']>()
      .mockImplementation(async (_uri, _options, progress) => {
        progress?.(0);
        progress?.(1);
        return '/cache/output.mp4';
      }),
    cancelCompress: jest
      .fn<MediaTransformer['cancelCompress']>()
      .mockResolvedValue(undefined),
    getVideoMetadata: jest
      .fn<MediaTransformer['getVideoMetadata']>()
      .mockResolvedValue({
        width: 640,
        height: 360,
        duration: 3,
        size: 1000,
        bitrate: 100000,
        frameRate: 30,
        hasAudio: true,
        rotation: 0,
      }),
    createThumbnail: jest
      .fn<MediaTransformer['createThumbnail']>()
      .mockResolvedValue({
        path: '/cache/thumbnail.jpg',
        width: 100,
        height: 56,
      }),
  };
}

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
});

describe('compression API', () => {
  it('loads native sessions lazily and allows omitted options', async () => {
    const { api, instances, create } = setup();
    expect(create).not.toHaveBeenCalled();
    await api.cancelCompress();
    expect(create).not.toHaveBeenCalled();
    await expect(api.compress('/video.mp4')).resolves.toBe('/cache/output.mp4');
    expect(instances[0]!.compress).toHaveBeenCalledWith(
      '/video.mp4',
      {},
      undefined
    );
    await api.cancelCompress();
    expect(instances[0]!.cancelCompress).toHaveBeenCalledTimes(1);
    expect(typeof api.useVideoCompressor).toBe('function');
  });

  it('keeps independent sessions separate', async () => {
    const { api, instances } = setup();
    const first = api.createVideoCompressor();
    const second = api.createVideoCompressor();
    await first.compress('/first.mp4');
    await second.compress('/second.mp4');
    await first.cancel();
    expect(instances).toHaveLength(2);
    expect(instances[0]!.cancelCompress).toHaveBeenCalledTimes(1);
    expect(instances[1]!.cancelCompress).not.toHaveBeenCalled();
  });

  it('reports progress and tolerates a throwing observer', async () => {
    const { api } = setup();
    const progress: number[] = [];
    await api.compress('/video.mp4', {}, (p) => {
      progress.push(p);
      throw new Error('observer');
    });
    expect(progress).toEqual([0, 1]);
  });

  it('rejects bad input/options before calling native code', async () => {
    const { api, create } = setup();
    await expect(api.compress('')).rejects.toThrow('inputUri');
    await expect(api.compress('/video', { bitrate: NaN })).rejects.toThrow(
      'bitrate'
    );
    expect(create).not.toHaveBeenCalled();
  });
});

describe('options', () => {
  it('applies presets with explicit overrides and no mutation', () => {
    const options = {
      quality: 'low' as const,
      bitrate: 1000000,
      maxWidth: undefined,
    };
    expect(resolveCompressOptions(options)).toMatchObject({
      maxWidth: 640,
      maxHeight: 640,
      bitrate: 1000000,
      audioBitrate: 64000,
    });
    expect(options.maxWidth).toBeUndefined();
    expect(resolveCompressOptions({})).toEqual({});
  });

  it.each([
    { maxWidth: 1 },
    { maxHeight: Infinity },
    { maxHeight: 12.5 },
    { bitrate: -1 },
    { bitrate: 2 ** 32 },
    { maxFrameRate: 0 },
    { startTime: -1 },
    { startTime: 3, endTime: 2 },
    { endTime: 0 },
    { audioBitrate: 1 },
    { audioSampleRate: 12345 },
    { audioChannels: 3 },
    { progressInterval: 0 },
    { outputFileName: '../video.mp4' },
    { outputFileName: 'folder\\video.mp4' },
    { outputFileName: 'video\0.mp4' },
    { outputFileName: 'video.mov' },
    { quality: 'unknown' },
    { quality: 'toString' },
    { codec: 'vp9' },
    { mute: 'yes' },
    { overwrite: 1 },
  ])('rejects unsupported options %j', (options) => {
    expect(() => resolveCompressOptions(options as never)).toThrow(TypeError);
  });

  it('forwards the full explicit option set', () => {
    const options = {
      maxWidth: 720,
      maxHeight: 1280,
      codec: 'hevc' as const,
      maxFrameRate: 24,
      startTime: 1,
      endTime: 2,
      mute: false,
      audioBitrate: 96000,
      audioSampleRate: 48000,
      audioChannels: 1,
      overwrite: true,
      outputFileName: 'clip.mp4',
      progressInterval: 100,
      optimizeForNetworkUse: false,
    };
    expect(resolveCompressOptions(options)).toEqual(options);
  });
});

describe('video utilities', () => {
  it('returns metadata and thumbnail results through an isolated utility instance', async () => {
    const { api, instances } = setup();
    expect(await api.getVideoMetadata('/video.mp4')).toMatchObject({
      duration: 3,
      hasAudio: true,
    });
    expect(
      await api.createThumbnail('/video.mp4', { time: 1, quality: 0.5 })
    ).toMatchObject({ width: 100 });
    expect(instances).toHaveLength(1);
    expect(instances[0]!.createThumbnail).toHaveBeenCalledWith('/video.mp4', {
      time: 1,
      quality: 0.5,
    });
  });

  it.each([
    { time: -1 },
    { quality: 1.1 },
    { maxWidth: 0 },
    { outputFileName: '../frame.jpg' },
    { outputFileName: 'frame.png' },
  ])('validates thumbnail options %j', async (options) => {
    const { api, create } = setup();
    await expect(api.createThumbnail('/video.mp4', options)).rejects.toThrow(
      TypeError
    );
    expect(create).not.toHaveBeenCalled();
  });
});

describe('batch compression', () => {
  it('uses one isolated session sequentially and aggregates progress', async () => {
    const { api, instances } = setup();
    const progress: number[] = [];
    const outputs = await api.compressBatch(
      [{ inputUri: '/one' }, { inputUri: '/two', options: { mute: true } }],
      {
        onProgress: (event) => {
          progress.push(event.progress);
        },
      }
    );
    expect(outputs).toHaveLength(2);
    expect(instances).toHaveLength(1);
    expect(instances[0]!.compress.mock.calls.map((call) => call[0])).toEqual([
      '/one',
      '/two',
    ]);
    expect(progress).toEqual([0, 0.5, 0.5, 1]);
  });

  it('validates all items before beginning a batch', async () => {
    const { api, create } = setup();
    await expect(
      api.compressBatch([
        { inputUri: '/one' },
        { inputUri: '/two', options: { bitrate: -1 } },
      ])
    ).rejects.toThrow('bitrate');
    expect(create).not.toHaveBeenCalled();
    expect(await api.compressBatch([])).toEqual([]);
  });

  it('rejects an already aborted batch without native work', async () => {
    const { api, create } = setup();
    const controller = new AbortController();
    controller.abort();
    await expect(
      api.compressBatch([{ inputUri: '/one' }], { signal: controller.signal })
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(create).not.toHaveBeenCalled();
  });

  it('cancels the active session and never starts the next item after abort', async () => {
    const { api, instances } = setup();
    const controller = new AbortController();
    await expect(
      api.compressBatch([{ inputUri: '/one' }, { inputUri: '/two' }], {
        signal: controller.signal,
        onProgress: () => {
          controller.abort();
        },
      })
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(instances[0]!.cancelCompress).toHaveBeenCalledTimes(1);
    expect(instances[0]!.compress).toHaveBeenCalledTimes(1);
  });
});
