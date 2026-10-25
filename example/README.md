# Media Transformer example

A local example of video picking, compression, metadata, thumbnails, cancellation, and saving to the photo library. It uses the library source from this workspace.

## Run

Install dependencies and generate native bindings from the repository root:

```sh
yarn install
yarn nitrogen
yarn example start
```

In another terminal, run Android:

```sh
yarn example android
```

Or install pods and run iOS on macOS:

```sh
cd example/ios
pod install
cd ../..
yarn example ios
```

Choose a video, select a quality preset and codec, then compress. Advanced options include dimensions, bitrates, frame rate, trim times, audio settings, progress interval, and output filenames. The result can be inspected, saved to the photo library, or used to create a thumbnail.

HEVC encoding depends on the device. The picker and gallery saver handle photo-library permissions. `yarn example web` previews the interface; processing requires Android or iOS.

## Native bridge checks

Debug builds expose `globalThis.runMediaTransformerChecks(inputUri)` in the Hermes inspector. The checks exercise metadata, compression, audio controls, trimming, thumbnails, progress, cancellation, overlapping requests, batches, and output-file protection through React Native.

Generate the required three-second 384 × 216, 30 fps H.264/AAC fixture on macOS:

```sh
MEDIA_TRANSFORMER_FIXTURE_PATH=/tmp/media-transformer-fixture.mp4 yarn test:ios
```

Copy the fixture to a readable location on the device or simulator, then run this in the debugger console with its local path:

```js
await globalThis.runMediaTransformerChecks(
  '/absolute/path/to/media-transformer-fixture.mp4'
);
```

The checks create cache files and require H.264 and HEVC encoders. Use physical devices to check picker access, gallery saving, and output quality.
