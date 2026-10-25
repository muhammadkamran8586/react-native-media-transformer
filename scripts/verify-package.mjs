import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = mkdtempSync(
  path.join(tmpdir(), 'media-transformer-package-')
);
try {
  const [pack] = JSON.parse(
    execFileSync(
      'npm',
      [
        'pack',
        '--ignore-scripts',
        '--json',
        '--pack-destination',
        temporary,
        '--cache',
        path.join(temporary, 'npm-cache'),
      ],
      { cwd: root, encoding: 'utf8' }
    )
  );
  const files = new Set(pack.files.map((file) => file.path));
  for (const required of [
    'lib/module/index.js',
    'lib/module/api.js',
    'lib/module/native.web.js',
    'lib/typescript/src/index.d.ts',
    'src/MediaTransformer.nitro.ts',
    'ios/MediaTransformer.swift',
    'android/build.gradle',
    'android/src/main/java/com/margelo/nitro/mediatransformer/MediaTransformer.kt',
    'nitrogen/generated/ios/swift/HybridMediaTransformerSpec.swift',
    'nitrogen/generated/ios/swift/NativeCompressOptions.swift',
    'nitrogen/generated/shared/c++/HybridMediaTransformerSpec.hpp',
    'nitrogen/generated/android/mediatransformer+autolinking.cmake',
    'MediaTransformer.podspec',
    'nitro.json',
    'README.md',
    'LICENSE',
  ])
    assert(
      files.has(required),
      `Missing published artifact: ${required}. Run yarn prepare first.`
    );
  for (const filename of files)
    assert(
      !/(^|\/)(node_modules|build|\.cxx|Pods|example|__tests__)(\/|$)|\.(apk|aab|mov|mp4|keystore)$/.test(
        filename
      ),
      `Unexpected package file: ${filename}`
    );

  execFileSync('tar', [
    '-xzf',
    path.join(temporary, pack.filename),
    '-C',
    temporary,
  ]);
  const consumer = path.join(temporary, 'consumer');
  const modules = path.join(consumer, 'node_modules');
  mkdirSync(modules, { recursive: true });
  symlinkSync(
    path.join(temporary, 'package'),
    path.join(modules, 'react-native-media-transformer'),
    'dir'
  );
  for (const peer of ['react', 'react-native', 'react-native-nitro-modules'])
    symlinkSync(
      path.join(root, 'node_modules', peer),
      path.join(modules, peer),
      'dir'
    );
  // Supply only peer dependencies and type declarations; library source is from the tarball.
  symlinkSync(
    path.join(root, 'node_modules', '@types'),
    path.join(modules, '@types'),
    'dir'
  );
  writeFileSync(
    path.join(consumer, 'package.json'),
    JSON.stringify({ private: true, type: 'module' })
  );
  writeFileSync(
    path.join(consumer, 'index.ts'),
    `
import { compress, cancelCompress, createVideoCompressor, compressBatch, createThumbnail, getVideoMetadata, useVideoCompressor, COMPRESSION_PRESETS } from 'react-native-media-transformer';
import type { CompressOptions, VideoMetadata, ThumbnailResult, BatchProgress } from 'react-native-media-transformer';
const options: CompressOptions = { quality: 'medium', codec: 'hevc', maxWidth: 720, maxFrameRate: 24, startTime: 1, endTime: 2, audioSampleRate: 48000, audioChannels: 1, overwrite: true };
const output: Promise<string> = compress('/video.mp4', options);
const metadata: Promise<VideoMetadata> = getVideoMetadata('/video.mp4');
const thumbnail: Promise<ThumbnailResult> = createThumbnail('/video.mp4', { time: 1 });
const batch: Promise<string[]> = compressBatch([{ inputUri: '/video.mp4', options }], { onProgress: (event: BatchProgress) => event.progress });
const session = createVideoCompressor();
void [output, metadata, thumbnail, batch, session, cancelCompress, useVideoCompressor, COMPRESSION_PRESETS.low];
`
  );
  writeFileSync(
    path.join(consumer, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        target: 'ES2022',
        skipLibCheck: true,
        types: ['react-native'],
      },
      include: ['index.ts'],
    })
  );
  execFileSync(
    process.execPath,
    [
      path.join(root, 'node_modules/typescript/bin/tsc'),
      '-p',
      path.join(consumer, 'tsconfig.json'),
    ],
    { cwd: consumer, stdio: 'pipe' }
  );
  const published = JSON.parse(
    readFileSync(path.join(temporary, 'package/package.json'), 'utf8')
  );
  assert.equal(published.name, 'react-native-media-transformer');
  console.log(
    `PASS: ${files.size} packed files, native bindings, package exclusions, and isolated consumer TypeScript API (${(pack.size / 1024).toFixed(1)} KiB compressed)`
  );
} catch (error) {
  if (error.stdout) process.stderr.write(error.stdout);
  if (error.stderr) process.stderr.write(error.stderr);
  throw error;
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
