import type { MediaTransformer } from './MediaTransformer.nitro';

export function createNativeTransformer(): MediaTransformer {
  throw new Error(
    'Media Transformer requires an Android or iOS native build. Video processing is not supported on web.'
  );
}
