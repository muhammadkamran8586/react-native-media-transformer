import { useState, useCallback, useEffect, useRef } from 'react';
import { compress, cancelCompress } from '../compress';

export const useVideoCompressor = () => {
  const [progress, setProgress] = useState<number>(0);
  const [isCompressing, setIsCompressing] = useState<boolean>(false);
  const [error, setError] = useState<Error | null>(null);

  const isCancelledRef = useRef<boolean>(false);

  const cancel = useCallback(async () => {
    isCancelledRef.current = true;
    try {
      await cancelCompress();
    } catch {
    } finally {
      setIsCompressing(false);
      setProgress(0);
    }
  }, []);

  const compressVideo = useCallback(async (inputUri: string, options: any) => {
    isCancelledRef.current = false;
    setIsCompressing(true);
    setProgress(0);
    setError(null);

    try {
      const result = await compress(inputUri, options, (p: number) => {
        setProgress(p);
      });
      return result;
    } catch (err) {
      if (isCancelledRef.current) {
        return null;
      }
      const e = err instanceof Error ? err : new Error(String(err));
      setError(e);
      throw e;
    } finally {
      setIsCompressing(false);
    }
  }, []);

  const reset = useCallback(() => {
    setProgress(0);
    setError(null);
    setIsCompressing(false);
  }, []);

  useEffect(() => {
    return () => {
      cancelCompress().catch(() => {});
    };
  }, []);

  return {
    compressVideo,
    cancel,
    isCompressing,
    progress,
    progressPercent: Math.round(progress * 100),
    error,
    reset,
  };
};
