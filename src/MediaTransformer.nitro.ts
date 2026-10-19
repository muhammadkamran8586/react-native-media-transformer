import type { HybridObject } from 'react-native-nitro-modules';

export interface CompressOptions {
  maxHeight?: number;
  bitrate?: number;
  outputFileName?: string;
}

export interface MediaTransformer extends HybridObject<{
  ios: 'swift';
  android: 'kotlin';
}> {
  compress(
    inputUri: string,
    options: CompressOptions,
    onProgress?: (progress: number) => void
  ): Promise<string>;

  cancelCompress(): Promise<void>;
}
