export type FileOperationKey = "dialog" | "inlineRename" | "move";

interface FileOperationHandlers<T> {
  onError?: (error: unknown) => void;
  onPendingChange?: (pending: boolean) => void;
  onSuccess?: (value: T) => void;
}

export function normalizeRemoteEntryName(value: string) {
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

export function createFileOperationController() {
  const generations = new Map<FileOperationKey, number>();
  const pending = new Set<FileOperationKey>();
  let disposed = false;

  const nextGeneration = (key: FileOperationKey) => {
    const generation = (generations.get(key) ?? 0) + 1;
    generations.set(key, generation);
    return generation;
  };

  const isCurrent = (key: FileOperationKey, generation: number) =>
    !disposed && generations.get(key) === generation;

  return {
    isPending(key: FileOperationKey) {
      return pending.has(key);
    },
    async run<T>(
      key: FileOperationKey,
      task: () => Promise<T>,
      handlers: FileOperationHandlers<T> = {},
    ) {
      if (disposed || pending.has(key)) {
        return false;
      }
      const generation = nextGeneration(key);
      pending.add(key);
      handlers.onPendingChange?.(true);
      try {
        const value = await task();
        if (isCurrent(key, generation)) {
          handlers.onSuccess?.(value);
        }
      } catch (error) {
        if (isCurrent(key, generation)) {
          handlers.onError?.(error);
        }
      } finally {
        if (isCurrent(key, generation)) {
          pending.delete(key);
          handlers.onPendingChange?.(false);
        }
      }
      return true;
    },
    cancel(key: FileOperationKey) {
      if (disposed) {
        return;
      }
      nextGeneration(key);
      pending.delete(key);
    },
    dispose() {
      disposed = true;
      pending.clear();
      generations.clear();
    },
  };
}

