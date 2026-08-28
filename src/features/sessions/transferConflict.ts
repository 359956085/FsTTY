export type TransferAttemptResult<T> =
  | { status: "completed"; value: T }
  | { status: "cancelled" };

export type TransferRetryOutcome<T> =
  | { kind: "completed"; value: T }
  | { kind: "skipped" }
  | { kind: "cancelled" }
  | { kind: "failed"; error: unknown };

interface TransferRetryOptions {
  isCurrent: () => boolean;
  isConflict: (error: unknown) => boolean;
  confirmOverwrite: () => Promise<boolean>;
  onConflict?: () => void;
}

export async function runTransferWithConflictRetry<T>(
  attempt: (overwrite: boolean) => Promise<TransferAttemptResult<T>>,
  options: TransferRetryOptions,
): Promise<TransferRetryOutcome<T>> {
  try {
    const result = await attempt(false);
    return result.status === "completed" && options.isCurrent()
      ? { kind: "completed", value: result.value }
      : { kind: "cancelled" };
  } catch (error) {
    if (!options.isCurrent()) return { kind: "cancelled" };
    if (!options.isConflict(error)) return { kind: "failed", error };

    options.onConflict?.();
    let overwrite = false;
    try {
      overwrite = await options.confirmOverwrite();
    } catch (confirmError) {
      return { kind: "failed", error: confirmError };
    }
    if (!options.isCurrent()) return { kind: "cancelled" };
    if (!overwrite) return { kind: "skipped" };

    try {
      const result = await attempt(true);
      return result.status === "completed" && options.isCurrent()
        ? { kind: "completed", value: result.value }
        : { kind: "cancelled" };
    } catch (retryError) {
      return options.isCurrent()
        ? { kind: "failed", error: retryError }
        : { kind: "cancelled" };
    }
  }
}
