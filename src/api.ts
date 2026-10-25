import { createNativeTransformer } from './native';
import type {
  MediaTransformer,
  ThumbnailOptions,
  ThumbnailResult,
  VideoMetadata,
} from './MediaTransformer.nitro';
import {
  resolveCompressOptions,
  validateInput,
  validateThumbnailOptions,
} from './options';
import type { CompressOptions } from './options';

export interface VideoCompressor {
  compress(
    inputUri: string,
    options?: CompressOptions,
    onProgress?: (progress: number) => void
  ): Promise<string>;
  cancel(): Promise<void>;
}

/** An independent encoder session. A new call cancels this session's previous job. */
export function createVideoCompressor(): VideoCompressor {
  let native: MediaTransformer | undefined;
  const getNative = () => (native ??= createNativeTransformer());
  return {
    async compress(inputUri, options = {}, onProgress) {
      validateInput(inputUri);
      const resolved = resolveCompressOptions(options);
      // A throwing progress observer must not strand a native export/promise.
      return getNative().compress(
        inputUri,
        resolved,
        onProgress
          ? (progress) => {
              try {
                onProgress(progress);
              } catch {
                /* Observer errors do not cancel an export. */
              }
            }
          : undefined
      );
    },
    async cancel() {
      await native?.cancelCompress();
    },
  };
}

const defaultCompressor = createVideoCompressor();
export const compress = defaultCompressor.compress;
export const cancelCompress = defaultCompressor.cancel;
let utility: MediaTransformer | undefined;
const getUtility = () => (utility ??= createNativeTransformer());

export async function getVideoMetadata(
  inputUri: string
): Promise<VideoMetadata> {
  validateInput(inputUri);
  return getUtility().getVideoMetadata(inputUri);
}

export async function createThumbnail(
  inputUri: string,
  options: ThumbnailOptions = {}
): Promise<ThumbnailResult> {
  validateInput(inputUri);
  validateThumbnailOptions(options);
  return getUtility().createThumbnail(inputUri, options);
}

export interface BatchInput {
  inputUri: string;
  options?: CompressOptions;
}
export interface BatchProgress {
  index: number;
  total: number;
  itemProgress: number;
  progress: number;
}
export interface BatchOptions {
  signal?: AbortSignal;
  onProgress?: (event: BatchProgress) => void;
}

/** Sequential, isolated exports. Stops on failure; completed files remain available. */
export async function compressBatch(
  inputs: readonly BatchInput[],
  options: BatchOptions = {}
): Promise<string[]> {
  // Validate the entire batch before creating any output.
  for (const input of inputs) {
    validateInput(input.inputUri);
    resolveCompressOptions(input.options);
  }
  const compressor = createVideoCompressor();
  const abortError = () =>
    Object.assign(new Error('Batch compression was cancelled'), {
      name: 'AbortError',
    });
  if (options.signal?.aborted) throw abortError();
  const cancel = () => {
    compressor.cancel().catch(() => {});
  };
  options.signal?.addEventListener('abort', cancel);
  const results: string[] = [];
  try {
    for (const [index, input] of inputs.entries()) {
      if (options.signal?.aborted) throw abortError();
      results.push(
        await compressor.compress(
          input.inputUri,
          input.options,
          (itemProgress) => {
            options.onProgress?.({
              index,
              total: inputs.length,
              itemProgress,
              progress: (index + itemProgress) / inputs.length,
            });
          }
        )
      );
    }
    if (options.signal?.aborted) throw abortError();
    return results;
  } catch (error) {
    if (options.signal?.aborted) throw abortError();
    throw error;
  } finally {
    options.signal?.removeEventListener('abort', cancel);
  }
}
