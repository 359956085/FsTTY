export interface ApiErrorInfo {
  kind: string | null;
  message: string;
}

export function readApiError(error: unknown, fallback: string): ApiErrorInfo {
  if (typeof error === "string") {
    return { kind: null, message: error };
  }

  if (error && typeof error === "object") {
    const value = error as Record<string, unknown>;
    return {
      kind: typeof value.kind === "string" ? value.kind : null,
      message: typeof value.message === "string" ? value.message : fallback,
    };
  }

  return { kind: null, message: fallback };
}

export function resolveApiError(error: unknown, fallback: string) {
  return readApiError(error, fallback).message;
}
