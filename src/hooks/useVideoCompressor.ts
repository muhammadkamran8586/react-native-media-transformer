import { useState, useCallback, useEffect, useRef } from 'react';
import { createVideoCompressor } from '../api';
import { resolveCompressOptions, validateInput } from '../options';
import type { CompressOptions } from '../options';

/** Owns an independent native session, including cancellation on unmount. */
export const useVideoCompressor = () => {
  const [progress, setProgress] = useState(0);
  const [isCompressing, setIsCompressing] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [outputPath, setOutputPath] = useState<string | null>(null);
  const [compressor] = useState(createVideoCompressor);
  const lifecycle = useRef({ mounted: true, generation: 0 }).current;
  const cancel = useCallback(async () => {
    await compressor.cancel();
  }, [compressor]);

  const compressVideo = useCallback(
    async (inputUri: string, options: CompressOptions = {}) => {
      validateInput(inputUri);
      resolveCompressOptions(options);
      const id = ++lifecycle.generation;
      if (lifecycle.mounted) {
        setIsCompressing(true);
        setProgress(0);
        setError(null);
        setOutputPath(null);
      }
      try {
        const path = await compressor.compress(inputUri, options, (p) => {
          if (lifecycle.mounted && id === lifecycle.generation) setProgress(p);
        });
        if (lifecycle.mounted && id === lifecycle.generation)
          setOutputPath(path);
        return path;
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        if (lifecycle.mounted && id === lifecycle.generation) setError(e);
        throw e;
      } finally {
        if (lifecycle.mounted && id === lifecycle.generation)
          setIsCompressing(false);
      }
    },
    [compressor, lifecycle]
  );

  const reset = useCallback(async () => {
    const id = ++lifecycle.generation;
    await compressor.cancel();
    if (lifecycle.mounted && id === lifecycle.generation) {
      setProgress(0);
      setError(null);
      setOutputPath(null);
      setIsCompressing(false);
    }
  }, [compressor, lifecycle]);

  useEffect(() => {
    lifecycle.mounted = true;
    return () => {
      lifecycle.mounted = false;
      ++lifecycle.generation;
      compressor.cancel().catch(() => {});
    };
  }, [compressor, lifecycle]);

  return {
    compressVideo,
    cancel,
    isCompressing,
    progress,
    progressPercent: Math.round(progress * 100),
    error,
    outputPath,
    reset,
  };
};
