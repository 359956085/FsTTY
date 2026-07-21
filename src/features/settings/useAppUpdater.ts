import { getVersion } from "@tauri-apps/api/app";
import { check, type DownloadEvent, type Update } from "@tauri-apps/plugin-updater";
import { useCallback, useEffect, useRef, useState } from "react";

export type UpdatePhase =
  | "idle"
  | "checking"
  | "upToDate"
  | "available"
  | "downloading"
  | "installing"
  | "completed"
  | "error";

export interface AvailableUpdate {
  body?: string;
  date?: string;
  version: string;
}

interface AppUpdaterState {
  availableUpdate: AvailableUpdate | null;
  currentVersion: string | null;
  dialogOpen: boolean;
  downloadedBytes: number;
  error: string | null;
  phase: UpdatePhase;
  totalBytes: number | null;
  versionError: string | null;
}

export interface AppUpdaterController extends AppUpdaterState {
  busy: boolean;
  checkForUpdates: (source?: "manual" | "automatic", proxyOverride?: string) => Promise<void>;
  dismissUpdate: () => Promise<void>;
  installUpdate: () => Promise<void>;
}

interface UseAppUpdaterOptions {
  autoUpdate: boolean;
  proxy: string;
  startupReady: boolean;
}

const INITIAL_STATE: AppUpdaterState = {
  availableUpdate: null,
  currentVersion: null,
  dialogOpen: false,
  downloadedBytes: 0,
  error: null,
  phase: "idle",
  totalBytes: null,
  versionError: null,
};

function updaterError(error: unknown) {
  if (typeof error === "string") {
    return error;
  }
  if (error instanceof Error && error.message) {
    return error.message;
  }
  if (error && typeof error === "object") {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === "string") {
      return message;
    }
  }
  return null;
}

function normalizeVersion(version: string) {
  return version.replace(/^v/i, "");
}

export function useAppUpdater({
  autoUpdate,
  proxy,
  startupReady,
}: UseAppUpdaterOptions): AppUpdaterController {
  const [state, setState] = useState(INITIAL_STATE);
  const updateRef = useRef<Update | null>(null);
  const checkingRef = useRef(false);
  const installingRef = useRef(false);
  const mountedRef = useRef(true);
  const startupCheckStartedRef = useRef(false);

  const releaseUpdate = useCallback(async () => {
    const update = updateRef.current;
    updateRef.current = null;
    if (update) {
      await update.close().catch(() => undefined);
    }
  }, []);

  const checkForUpdates = useCallback(
    async (source: "manual" | "automatic" = "manual", proxyOverride = proxy) => {
      if (checkingRef.current || installingRef.current) {
        return;
      }
      checkingRef.current = true;
      await releaseUpdate();
      if (mountedRef.current) {
        setState((current) => ({
          ...current,
          availableUpdate: null,
          dialogOpen: false,
          downloadedBytes: 0,
          error: null,
          phase: "checking",
          totalBytes: null,
        }));
      }

      try {
        const normalizedProxy = proxyOverride.trim();
        const update = await check({
          ...(normalizedProxy ? { proxy: normalizedProxy } : {}),
          timeout: 30_000,
        });
        if (!mountedRef.current) {
          await update?.close().catch(() => undefined);
          return;
        }
        if (!update) {
          setState((current) => ({
            ...current,
            phase: source === "manual" ? "upToDate" : "idle",
          }));
          return;
        }
        updateRef.current = update;
        setState((current) => ({
          ...current,
          availableUpdate: {
            body: update.body,
            date: update.date,
            version: normalizeVersion(update.version),
          },
          dialogOpen: true,
          phase: "available",
        }));
      } catch (error) {
        if (mountedRef.current) {
          setState((current) => ({
            ...current,
            error: updaterError(error),
            phase: "error",
          }));
        }
      } finally {
        checkingRef.current = false;
      }
    },
    [proxy, releaseUpdate],
  );

  const dismissUpdate = useCallback(async () => {
    if (installingRef.current) {
      return;
    }
    await releaseUpdate();
    if (mountedRef.current) {
      setState((current) => ({
        ...current,
        availableUpdate: null,
        dialogOpen: false,
        downloadedBytes: 0,
        error: null,
        phase: "idle",
        totalBytes: null,
      }));
    }
  }, [releaseUpdate]);

  const installUpdate = useCallback(async () => {
    const update = updateRef.current;
    if (!update || installingRef.current || checkingRef.current) {
      return;
    }
    installingRef.current = true;
    let downloadedBytes = 0;
    if (mountedRef.current) {
      setState((current) => ({
        ...current,
        downloadedBytes: 0,
        error: null,
        phase: "downloading",
        totalBytes: null,
      }));
    }

    try {
      await update.downloadAndInstall((event: DownloadEvent) => {
        if (!mountedRef.current) {
          return;
        }
        if (event.event === "Started") {
          setState((current) => ({
            ...current,
            downloadedBytes: 0,
            phase: "downloading",
            totalBytes: event.data.contentLength ?? null,
          }));
        } else if (event.event === "Progress") {
          downloadedBytes += event.data.chunkLength;
          setState((current) => ({
            ...current,
            downloadedBytes,
          }));
        } else {
          setState((current) => ({ ...current, phase: "installing" }));
        }
      });
      await releaseUpdate();
      if (mountedRef.current) {
        setState((current) => ({ ...current, phase: "completed" }));
      }
    } catch (error) {
      if (mountedRef.current) {
        setState((current) => ({
          ...current,
          error: updaterError(error),
          phase: "error",
        }));
      }
    } finally {
      installingRef.current = false;
    }
  }, [releaseUpdate]);

  useEffect(() => {
    let active = true;
    void getVersion()
      .then((version) => {
        if (active) {
          setState((current) => ({
            ...current,
            currentVersion: normalizeVersion(version),
          }));
        }
      })
      .catch((error: unknown) => {
        if (active) {
          setState((current) => ({
            ...current,
            versionError: updaterError(error),
          }));
        }
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!startupReady || startupCheckStartedRef.current) {
      return;
    }
    startupCheckStartedRef.current = true;
    if (autoUpdate) {
      void checkForUpdates("automatic", proxy);
    }
  }, [autoUpdate, checkForUpdates, proxy, startupReady]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const update = updateRef.current;
      updateRef.current = null;
      void update?.close().catch(() => undefined);
    };
  }, []);

  return {
    ...state,
    busy: state.phase === "checking" || state.phase === "downloading" || state.phase === "installing",
    checkForUpdates,
    dismissUpdate,
    installUpdate,
  };
}
