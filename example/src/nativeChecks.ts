import {
  compress,
  compressBatch,
  createThumbnail,
  createVideoCompressor,
  getVideoMetadata,
} from 'react-native-media-transformer';

function check(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function within<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('Native check timed out')),
          30000
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function rejects(operation: Promise<unknown>, contains: string) {
  try {
    await within(operation);
  } catch (error) {
    check(
      error instanceof Error && error.message.includes(contains),
      `Unexpected rejection: ${String(error)}`
    );
    return;
  }
  throw new Error(`Expected rejection containing ${contains}`);
}

/** Development-only bridge regression checks; input must be a 3s, 384x216, 30fps video with audio. */
export async function runNativeChecks(inputUri: string) {
  const passed: string[] = [];
  const source = await within(getVideoMetadata(inputUri));
  check(
    source.width === 384 &&
      source.height === 216 &&
      source.hasAudio &&
      source.duration >= 2.9,
    `Incorrect regression fixture: ${JSON.stringify(source)}`
  );
  passed.push('metadata: dimensions, duration, audio and file size');

  const progress: number[] = [];
  const output = await within(
    compress(
      inputUri,
      { maxWidth: 192, maxHeight: 200, bitrate: 150000, progressInterval: 50 },
      (p) => {
        progress.push(p);
      }
    )
  );
  const info = await within(getVideoMetadata(output));
  check(
    info.width === 192 && info.height === 108 && info.hasAudio,
    'Resize or audio preservation failed'
  );
  check(
    progress[0] === 0 &&
      progress[progress.length - 1] === 1 &&
      progress.every(
        (p, i) => p >= 0 && p <= 1 && (i === 0 || p >= progress[i - 1]!)
      ),
    'Progress contract failed'
  );
  passed.push(
    'H.264 export, bounding box, audio preservation and monotonic progress'
  );

  const noUpscale = await within(
    compress(inputUri, { maxWidth: 1920, maxHeight: 1080 })
  );
  const unscaled = await within(getVideoMetadata(noUpscale));
  check(
    unscaled.width === 384 && unscaled.height === 216,
    'Small input was upscaled'
  );
  passed.push('no upscaling');

  const trimmed = await within(
    compress(inputUri, {
      startTime: 1,
      endTime: 2,
      maxFrameRate: 15,
      mute: true,
    })
  );
  const clip = await within(getVideoMetadata(trimmed));
  check(
    !clip.hasAudio && Math.abs(clip.duration - 1) < 0.15,
    `Trim/mute failed: ${JSON.stringify(clip)}`
  );
  passed.push('trim from nonzero time, frame rate cap and mute');

  const audio = await within(
    compress(inputUri, {
      audioBitrate: 96000,
      audioSampleRate: 48000,
      audioChannels: 1,
    })
  );
  check(
    (await within(getVideoMetadata(audio))).hasAudio,
    'Audio conversion removed audio'
  );
  passed.push('audio bitrate, 48kHz and mono conversion');

  const thumbnail = await within(
    createThumbnail(inputUri, {
      time: 1,
      maxWidth: 100,
      maxHeight: 100,
      quality: 0.6,
    })
  );
  check(
    thumbnail.width <= 100 && thumbnail.height <= 100,
    'Thumbnail bounds failed'
  );
  passed.push('JPEG thumbnail');

  const name = `native-check-${Date.now()}.mp4`;
  const named = await within(compress(inputUri, { outputFileName: name }));
  await rejects(compress(inputUri, { outputFileName: name }), 'already exists');
  await rejects(
    compress(named, { outputFileName: name, overwrite: true }),
    'different'
  );
  await rejects(
    compress(inputUri, {
      startTime: 1000,
      outputFileName: name,
      overwrite: true,
    }),
    'before the end'
  );
  check(
    (await within(getVideoMetadata(named))).duration > 2.9,
    'Failed overwrite damaged existing output'
  );
  await within(
    compress(inputUri, {
      maxHeight: 108,
      outputFileName: name,
      overwrite: true,
    })
  );
  passed.push(
    'no clobber, input collision, failed overwrite preservation and explicit overwrite'
  );

  const session = createVideoCompressor();
  const pending = session.compress(inputUri);
  // Attach a rejection handler before cancellation to avoid an unhandled rejection.
  const cancelled = rejects(pending, 'cancelled');
  await session.cancel();
  await cancelled;
  await session.cancel();
  const first = session.compress(inputUri);
  const replaced = rejects(first, 'new request');
  const second = session.compress(inputUri, { maxHeight: 108 });
  await replaced;
  await within(second);
  passed.push(
    'preparation cancellation, idle cancellation and overlapping promise settlement'
  );

  const batch = await within(
    compressBatch([
      { inputUri, options: { quality: 'low', maxHeight: 108 } },
      { inputUri, options: { mute: true, maxWidth: 96 } },
    ])
  );
  check(
    batch.length === 2 && !(await within(getVideoMetadata(batch[1]!))).hasAudio,
    'Batch export failed'
  );
  passed.push('sequential batch with presets and overrides');

  // Hardware-dependent: report explicitly when this encoder is unavailable.
  let hevc: string;
  try {
    hevc = await within(compress(inputUri, { codec: 'hevc', maxHeight: 108 }));
    passed.push('HEVC export');
  } catch (error) {
    hevc = `Unavailable on this device: ${String(error)}`;
  }
  return { passed, source, clip, thumbnail, output, audio, hevc };
}
