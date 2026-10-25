import { NitroModules } from 'react-native-nitro-modules';
import type { MediaTransformer } from './MediaTransformer.nitro';

export function createNativeTransformer(): MediaTransformer {
  return NitroModules.createHybridObject<MediaTransformer>('MediaTransformer');
}
