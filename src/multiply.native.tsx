import { NitroModules } from 'react-native-nitro-modules';
import type { MediaTransformer } from './MediaTransformer.nitro';

const MediaTransformerHybridObject =
  NitroModules.createHybridObject<MediaTransformer>('MediaTransformer');

export function multiply(a: number, b: number): number {
  return MediaTransformerHybridObject.multiply(a, b);
}
