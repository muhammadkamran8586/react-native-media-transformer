import { NitroModules } from 'react-native-nitro-modules';
import type {
  CompressOptions,
  MediaTransformer,
} from './MediaTransformer.nitro';

const MediaTransformerHybridObject =
  NitroModules.createHybridObject<MediaTransformer>('MediaTransformer');

export function compress(
  inputUri: string,
  options: CompressOptions,
  onProgress?: (progress: number) => void
): Promise<string> {
  return MediaTransformerHybridObject.compress(inputUri, options, onProgress);
}

export function cancelCompress(): Promise<void> {
  return MediaTransformerHybridObject.cancelCompress();
}
