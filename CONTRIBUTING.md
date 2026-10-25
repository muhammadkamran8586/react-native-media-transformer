# Contributing

Open an [issue](https://github.com/muhammadkamran8586/react-native-media-transformer/issues) to discuss API changes or report a reproducible bug. Include the library version, React Native version, device and OS, input format, options, and error message. Follow the [code of conduct](CODE_OF_CONDUCT.md).

## Setup

Use the Node.js version in [`.nvmrc`](.nvmrc) and Yarn 4.11.0. Run commands from the repository root unless noted otherwise. Native development requires the React Native Android toolchain or macOS with Xcode and CocoaPods.

```sh
yarn install
yarn nitrogen
```

The root contains the library; `example/` is a Yarn workspace that uses its local source. Regenerate Nitro bindings after changing `src/MediaTransformer.nitro.ts`. Generated files are included in the npm package by `yarn prepare`.

## Example app

Start Metro in one terminal:

```sh
yarn example start
```

Run Android in another:

```sh
yarn example android
```

For iOS, install pods before the first build:

```sh
cd example/ios
pod install
cd ../..
yarn example ios
```

JavaScript changes reload through Metro. Native changes require a rebuild. Use Android Studio with `example/android`, or Xcode with `example/ios/MediaTransformerExample.xcworkspace`.

`yarn example web` previews the interface; video processing requires a native build. See the [example guide](example/README.md) for bridge checks.

## Checks

```sh
yarn typecheck
yarn lint
yarn test --runInBand
yarn prepare
yarn verify:package
```

`verify:package` inspects the npm tarball for required native files and generated bindings, checks exclusions, and typechecks the public API in an isolated consumer. It does not build a consumer's native app.

On macOS with Xcode, also run:

```sh
yarn test:ios
```

This typechecks the implementation for an iOS 15.1 deployment target and runs AVFoundation conversions on macOS using Nitro's Promise implementation and a bridge shim. It covers codecs, audio, trimming, frame rates, orientation, thumbnails, progress, validation, overwrites, cancellation, and cleanup. Run the example on Android and iOS for changes that affect native behavior.

## Pull requests

Keep changes focused, update documentation for public behavior, and include relevant tests. Describe the change and the checks performed, including the device and OS for native testing.

Use conventional commit messages, such as `fix(android): preserve output on cancellation` or `docs: clarify cache lifetime`. Git hooks check the message format.

## Releases

Before publishing, build a clean consumer app from the packed tarball on both platforms. Check physical devices across supported OS versions, picker permissions and gallery saving, long and variable-frame-rate recordings, orientation, audio synchronization, and codec-dependent inputs such as HEVC and HDR. Review output quality as well as successful completion.

Update [CHANGELOG.md](CHANGELOG.md), run the checks above, then use `yarn release`. The release command creates the version commit, tag, npm publication, and GitHub release; it requires maintainer credentials.
