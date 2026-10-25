# react-native-media-transformer

[![npm version](https://img.shields.io/npm/v/react-native-media-transformer.svg)](https://www.npmjs.com/package/react-native-media-transformer)

Native video compression and editing for React Native, powered by Android Media3 and iOS AVFoundation. Resize and trim videos, choose H.264 or HEVC, control audio, inspect metadata, and generate JPEG thumbnails without uploading media.

[Documentation](https://mkamran.dev/react-native-media-transformer) · [npm package](https://www.npmjs.com/package/react-native-media-transformer)

## Installation

```sh
npm install react-native-media-transformer react-native-nitro-modules@^0.37.1
cd ios && pod install
```

Rebuild your native app after installation.

- Android API 24+; iOS 15.1+ or the higher minimum required by your React Native version.
- [Nitro Modules](https://nitro.margelo.com/) 0.37.x. The example app uses React Native 0.86.2 with Nitro 0.37.1; compatibility with other React Native versions is not verified.
- Expo requires a development build. Video processing is available on Android and iOS only; Expo Go and web are unsupported.

## Quick start

```ts
import {
  compress,
  getVideoMetadata,
  createThumbnail,
} from 'react-native-media-transformer';

const inputUri = '/absolute/path/to/video.mp4'; // Or a URI from your video picker.
const outputPath = await compress(
  inputUri,
  { quality: 'medium', maxHeight: 720 },
  (progress) => console.log(`${Math.round(progress * 100)}%`)
);

const info = await getVideoMetadata(outputPath);
const thumbnail = await createThumbnail(outputPath, {
  maxWidth: 480,
  maxHeight: 320,
});
const thumbnailUri = `file://${thumbnail.path}`;
```

All time values are **seconds**, sizes are **bytes**, dimensions are **displayed pixels**, and bitrates are **bits per second**. Outputs are absolute local paths. Use `file://${path}` when a React Native component needs a file URI. Outputs are cached; copy them to permanent storage if you need to keep them.

## Compression options

`compress(inputUri, options?, onProgress?): Promise<string>` creates an MP4 with H.264 video by default and AAC audio when present. With no options, dimensions are preserved (rounded to even pixels) and the target video bitrate is chosen from the source bitrate and dimensions. Video is re-encoded.

| Option                  | Default                       | Behavior                                                                                                     |
| ----------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `quality`               | Adaptive                      | `'low'`, `'medium'`, or `'high'` preset. Explicit options override preset fields.                            |
| `maxWidth`              | Source width                  | Maximum displayed width, 2–16384, integer pixels.                                                            |
| `maxHeight`             | Source height                 | Maximum displayed height, 2–16384, integer pixels.                                                           |
| `bitrate`               | Adaptive                      | Target video bitrate, positive 32-bit integer. Encoder output may vary.                                      |
| `codec`                 | `'h264'`                      | `'h264'` or `'hevc'`. Unsupported device encoders reject the operation.                                      |
| `maxFrameRate`          | Source rate                   | Frame-rate target, 1–240. Drops frames without duplicating them; actual rate can vary with input timestamps. |
| `startTime`             | `0`                           | Start of the retained clip, in seconds. Must precede the source's end.                                       |
| `endTime`               | Source end                    | End of the retained clip. Must exceed `startTime`; values beyond the source end are clamped.                 |
| `mute`                  | `false`                       | Remove all audio. Audio options have no effect for muted or silent sources.                                  |
| `audioBitrate`          | `128000`                      | AAC target bitrate, 8000–320000.                                                                             |
| `audioSampleRate`       | iOS: `44100`; Android: source | AAC sample rate: 8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, or 48000 Hz.                         |
| `audioChannels`         | iOS: `2`; Android: source     | `1` for mono or `2` for stereo. Android downmix supports input layouts up to 5.1.                            |
| `outputFileName`        | Unique name                   | A filename ending in `.mp4`, without directory components.                                                   |
| `overwrite`             | `false`                       | Replace an existing cache output only after successful export.                                               |
| `progressInterval`      | `300`                         | Progress notification interval in milliseconds, integer 50–10000.                                            |
| `optimizeForNetworkUse` | `true`                        | iOS optimizes file layout; Android attempts a streamable MP4 layout.                                         |

The two size limits form a bounding box. Aspect ratio and orientation are preserved without upscaling; encoded dimensions are rounded down to even pixels. Bitrate, frame rate, and audio settings are subject to device encoder capabilities. Invalid options reject the promise.

### Quality presets

| Preset   | Maximum width and height | Video bitrate | Audio bitrate |
| -------- | ------------------------ | ------------- | ------------- |
| `low`    | 640 × 640                | 700000        | 64000         |
| `medium` | 1280 × 1280              | 2000000       | 128000        |
| `high`   | 1920 × 1920              | 5000000       | 192000        |

`COMPRESSION_PRESETS` exposes these immutable defaults. Both limits apply, so portrait and landscape videos have the same maximum long edge. Omit `quality` for source-based defaults and no preset size cap.

```ts
const clip = await compress(inputUri, {
  quality: 'medium',
  codec: 'hevc',
  startTime: 2,
  endTime: 12,
});
```

## Progress and cancellation

Progress starts at `0` and reaches `1` after the output file is complete. Progress callback exceptions are ignored. Native errors and cancellation reject the compression promise; handle rejections with `try`/`catch` or `.catch()`.

```ts
import { compress, cancelCompress } from 'react-native-media-transformer';

async function startCompression(inputUri: string) {
  try {
    return await compress(inputUri, { maxHeight: 720 });
  } catch (error) {
    console.error(error); // Includes cancellation.
    return null;
  }
}

async function onCancelPress() {
  await cancelCompress();
}
```

The top-level functions share one session. A new compression request cancels and rejects the previous request once it reaches native code, including when the new input cannot be opened. JavaScript validation errors leave the active export running. `cancelCompress()` while idle succeeds.

### Independent sessions

Use `createVideoCompressor()` to run exports independently:

```ts
import { createVideoCompressor } from 'react-native-media-transformer';

const editor = createVideoCompressor();
const uploader = createVideoCompressor();
const [preview, upload] = await Promise.all([
  editor.compress(firstVideo, { quality: 'low' }),
  uploader.compress(secondVideo, { quality: 'high' }),
]);
```

Each session's `cancel()` affects only its own export. Concurrent exports require enough device codec resources; use batches to process files sequentially. Metadata and thumbnail operations are not cancelled by `cancelCompress()`.

## React hook

```tsx
import { useVideoCompressor } from 'react-native-media-transformer';
import { Button, Text, View } from 'react-native';

export function VideoCompressor({ inputUri }: { inputUri: string }) {
  const {
    compressVideo,
    cancel,
    isCompressing,
    progressPercent,
    error,
    outputPath,
  } = useVideoCompressor();

  const start = async () => {
    try {
      await compressVideo(inputUri, { quality: 'medium' });
    } catch {
      // The hook exposes failures and cancellation through `error`.
    }
  };

  return (
    <View>
      <Button title="Compress" onPress={start} disabled={isCompressing} />
      {isCompressing && (
        <Button title="Cancel" onPress={() => cancel().catch(console.error)} />
      )}
      <Text>{progressPercent}%</Text>
      {error && <Text>{error.message}</Text>}
      {outputPath && <Text>{outputPath}</Text>}
    </View>
  );
}
```

The hook also returns fractional `progress` (0–1) and an async `reset()` that cancels the export and clears its state. Each hook owns a session and cancels it on unmount. Resetting does not delete completed files.

## Batch processing

`compressBatch(inputs, options?): Promise<string[]>` validates all options first, then processes files sequentially in an isolated session. Results retain input order. Progress includes the zero-based `index`, `total`, `itemProgress`, and aggregate `progress` (both 0–1).

```ts
import { compressBatch } from 'react-native-media-transformer';

const controller = new AbortController();
const outputs = await compressBatch(
  [
    { inputUri: firstVideo, options: { quality: 'low' } },
    { inputUri: secondVideo, options: { maxHeight: 720, mute: true } },
  ],
  {
    signal: controller.signal,
    onProgress: ({ index, progress }) => console.log(index, progress),
  }
);
// Call controller.abort() from your cancel action while the batch is running.
```

A batch stops at the first failure. Aborting cancels its active export and rejects with `name: 'AbortError'`. Already completed files remain in cache; failed and cancelled temporary files are removed. Use unique output filenames per item. An empty batch returns `[]`.

## Metadata

`getVideoMetadata(inputUri): Promise<VideoMetadata>` returns:

| Field             | Meaning                                                                      |
| ----------------- | ---------------------------------------------------------------------------- |
| `width`, `height` | Displayed dimensions after source rotation.                                  |
| `duration`        | Duration in seconds.                                                         |
| `size`            | File size in bytes; `0` if an Android content provider cannot report it.     |
| `bitrate`         | Estimated bitrate; video-track bitrate on iOS, container bitrate on Android. |
| `frameRate`       | Nominal frame rate when available, otherwise `0`.                            |
| `hasAudio`        | Whether the input contains audio.                                            |
| `rotation`        | Source rotation in degrees, normalized to 0–360.                             |

## Thumbnails

`createThumbnail(inputUri, options?): Promise<ThumbnailResult>` returns the JPEG's `path`, `width`, and `height` with source orientation applied. The decoder chooses a frame at or near the requested timestamp.

| Option                  | Default           | Behavior                                                                |
| ----------------------- | ----------------- | ----------------------------------------------------------------------- |
| `time`                  | `0`               | Seconds from source start; must be before source end.                   |
| `maxWidth`, `maxHeight` | Source dimensions | Integer bounding limits, 2–16384. Keeps aspect ratio without upscaling. |
| `quality`               | `0.8`             | JPEG quality from 0 to 1.                                               |
| `outputFileName`        | Unique name       | Filename ending in `.jpg`.                                              |
| `overwrite`             | `false`           | Replace an existing thumbnail only after successful creation.           |

## Files and supported inputs

- Android accepts readable absolute paths, `file://` URLs, and `content://` URIs with an active read grant. Keep that grant for the entire operation.
- iOS accepts readable absolute local paths and `file://` URLs. Copy Photos assets (`ph://`) to a local file first. A picker configured to return local files works directly.
- Download remote media to a local file before processing; HTTP URLs are not accepted.
- Outputs live in the app cache under `media-transformer`. The OS may remove them. Copy or save outputs to permanent storage before relying on them long term.
- Output names cannot escape the cache directory. Input/output collisions, symbolic links, directories, and existing outputs without `overwrite: true` are rejected. Exports use temporary files and atomic publishing, so failure or cancellation preserves previous completed files.
- The library does not request photo-library or storage permissions. The example demonstrates gallery saving with CameraRoll; your app controls permissions and permanent storage.

## Platform behavior

- HEVC encoding and accepted input formats depend on the device's codecs. Unsupported inputs or encoder settings reject the operation.
- HDR preservation, Dolby Vision, and consistent tone mapping across devices are not guaranteed.
- One video track is exported. iOS mixes source audio tracks; Android Media3 selects the source audio track. Subtitles, chapters, location, and other source metadata are not preserved.
- Compression can increase the size of an already efficient video. Compare the result with the source before replacing an original.

## Example

The [example app](https://github.com/muhammadkamran8586/react-native-media-transformer/tree/main/example) includes video picking, compression controls, metadata, thumbnails, cancellation, and gallery saving.

## Contributing

See the [contributor guide](https://github.com/muhammadkamran8586/react-native-media-transformer/blob/main/CONTRIBUTING.md) and [code of conduct](https://github.com/muhammadkamran8586/react-native-media-transformer/blob/main/CODE_OF_CONDUCT.md).

## License

[MIT](LICENSE).
