import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { api } from "../../shared/api/client";
import { resolveApiError } from "../../shared/api/errors";
import {
  getInitialLightweightModeState,
  getLightweightRestoreRevision,
  getPreservedRuntimeIds,
  getValidRestoredRuntimeIds,
  subscribeLightweightRestore,
} from "./lightweightMode";

export function useLightweightRestore(
  validRuntimeIds: ReadonlySet<string>,
  sessionsReady: boolean,
  errorFallback: string,
) {
  const [error, setError] = useState<string | null>(null);
  const [retryGeneration, setRetryGeneration] = useState(0);
  const finishedRef = useRef(false);
  const requestRef = useRef<{ generation: number; promise: Promise<void> } | null>(null);
  const restoreRevision = useSyncExternalStore(
    subscribeLightweightRestore,
    getLightweightRestoreRevision,
  );

  useEffect(() => {
    if (
      finishedRef.current || !sessionsReady || !getInitialLightweightModeState().active ||
      [...getPreservedRuntimeIds()].some((id) => validRuntimeIds.has(id))
    ) return;
    let active = true;
    // 全部有效标签重放结束后再清理孤立连接；StrictMode 重放复用同一请求。
    if (requestRef.current?.generation !== retryGeneration) {
      requestRef.current = {
        generation: retryGeneration,
        promise: api.finishLightweightRestore(getValidRestoredRuntimeIds(validRuntimeIds)),
      };
    }
    void requestRef.current.promise.then(
      () => {
        if (!active) return;
        finishedRef.current = true;
        setError(null);
      },
      (cause: unknown) => {
        if (active) setError(resolveApiError(cause, errorFallback));
      },
    );
    return () => { active = false; };
  }, [restoreRevision, validRuntimeIds, sessionsReady, errorFallback, retryGeneration]);

  const retry = useCallback(() => {
    if (!error || finishedRef.current) return;
    setError(null);
    setRetryGeneration((generation) => generation + 1);
  }, [error]);

  return { error, retry };
}
