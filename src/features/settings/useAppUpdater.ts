import { getVersion } from "@tauri-apps/api/app";
import { Channel } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../shared/api/client";
import type {
  AppSettings,
  AppUpdateProgress,
  UpdateSourcePreference,
} from "../../shared/api/types";
import { normalizeReleaseVersion, shouldSuppressUpdate } from "./updateVersion";

export type UpdatePhase =
  | "idle"
  | "checking"
  | "upToDate"
  | "available"
  | "ignoring"
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
  ignoreError: boolean;
  phase: UpdatePhase;
  totalBytes: number | null;
  versionError: string | null;
}

export interface AppUpdaterController extends AppUpdaterState {
  busy: boolean;
  checkForUpdates: (
    trigger?: "manual" | "automatic",
    proxyOverride?: string,
    updateSourceOverride?: UpdateSourcePreference,
  ) => Promise<void>;
  dismissUpdate: () => Promise<void>;
  ignoreUpdate: () => Promise<void>;
  installUpdate: () => Promise<void>;
}

interface UseAppUpdaterOptions {
  autoUpdate: boolean;
  ignoredUpdateVersion: string | null;
  onSettingsChange: (settings: AppSettings) => void;
  proxy: string;
  updateSource: UpdateSourcePreference;
  startupReady: boolean;
}

const INITIAL_STATE: AppUpdaterState = {
  availableUpdate: null,
  currentVersion: null,
  dialogOpen: false,
  downloadedBytes: 0,
  error: null,
  ignoreError: false,
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

export function useAppUpdater({
  autoUpdate,
  ignoredUpdateVersion,
  onSettingsChange,
  proxy,
  updateSource,
  startupReady,
}: UseAppUpdaterOptions): AppUpdaterController {
  const [state, setState] = useState(INITIAL_STATE);
  const updatePendingRef = useRef(false);
  const checkingRef = useRef(false);
  const ignoringRef = useRef(false);
  const installingRef = useRef(false);
  const mountedRef = useRef(true);
  const startupCheckStartedRef = useRef(false);

  const releaseUpdate = useCallback(async () => {
    if (updatePendingRef.current) {
      updatePendingRef.current = false;
      await api.closeAppUpdate().catch(() => undefined);
    }
  }, []);

  const checkForUpdates = useCallback(
    async (
      trigger: "manual" | "automatic" = "manual",
      proxyOverride = proxy,
      updateSourceOverride = updateSource,
    ) => {
      if (checkingRef.current || ignoringRef.current || installingRef.current) {
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
          ignoreError: false,
          phase: "checking",
          totalBytes: null,
        }));
      }

      try {
        const normalizedProxy = proxyOverride.trim();
        const update = await api.checkAppUpdate(normalizedProxy, updateSourceOverride);
        if (!mountedRef.current) {
          if (update) {
            await api.closeAppUpdate().catch(() => undefined);
          }
          return;
        }
        if (!update) {
          setState((current) => ({
            ...current,
            phase: trigger === "manual" ? "upToDate" : "idle",
          }));
          return;
        }
        const version = normalizeReleaseVersion(update.version);
        if (shouldSuppressUpdate(trigger, version, ignoredUpdateVersion)) {
          await api.closeAppUpdate().catch(() => undefined);
          setState((current) => ({ ...current, phase: "idle" }));
          return;
        }
        updatePendingRef.current = true;
        setState((current) => ({
          ...current,
          availableUpdate: {
            body: update.body,
            date: update.date,
            version,
          },
          dialogOpen: true,
          phase: "available",
        }));
      } catch (error) {
        if (mountedRef.current) {
          setState((current) => ({
            ...current,
            error: updaterError(error),
            ignoreError: false,
            phase: "error",
          }));
        }
      } finally {
        checkingRef.current = false;
      }
    },
    [ignoredUpdateVersion, proxy, releaseUpdate, updateSource],
  );

  const dismissUpdate = useCallback(async () => {
    if (ignoringRef.current || installingRef.current) {
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
        ignoreError: false,
        phase: "idle",
        totalBytes: null,
      }));
    }
  }, [releaseUpdate]);

  const ignoreUpdate = useCallback(async () => {
    const update = state.availableUpdate;
    if (
      !updatePendingRef.current ||
      !update ||
      checkingRef.current ||
      ignoringRef.current ||
      installingRef.current
    ) {
      return;
    }
    ignoringRef.current = true;
    if (mountedRef.current) {
      setState((current) => ({
        ...current,
        error: null,
        ignoreError: false,
        phase: "ignoring",
      }));
    }
    try {
      const nextSettings = await api.setIgnoredUpdateVersion(
        normalizeReleaseVersion(update.version),
      );
      await releaseUpdate();
      if (mountedRef.current) {
        onSettingsChange(nextSettings);
        setState((current) => ({
          ...current,
          availableUpdate: null,
          dialogOpen: false,
          downloadedBytes: 0,
          error: null,
          ignoreError: false,
          phase: "idle",
          totalBytes: null,
        }));
      }
    } catch (error) {
      if (mountedRef.current) {
        setState((current) => ({
          ...current,
          error: updaterError(error),
          ignoreError: true,
          phase: "available",
        }));
      }
    } finally {
      ignoringRef.current = false;
    }
  }, [onSettingsChange, releaseUpdate, state.availableUpdate]);

  const installUpdate = useCallback(async () => {
    if (
      !updatePendingRef.current ||
      installingRef.current ||
      checkingRef.current ||
      ignoringRef.current
    ) {
      return;
    }
    installingRef.current = true;
    let downloadedBytes = 0;
    if (mountedRef.current) {
      setState((current) => ({
        ...current,
        downloadedBytes: 0,
        error: null,
        ignoreError: false,
        phase: "downloading",
        totalBytes: null,
      }));
    }

    try {
      const channel = new Channel<AppUpdateProgress>();
      channel.onmessage = (event) => {
        if (!mountedRef.current) {
          return;
        }
        if (event.kind === "started") {
          setState((current) => ({
            ...current,
            downloadedBytes: 0,
            phase: "downloading",
            totalBytes: event.totalBytes ?? null,
          }));
        } else if (event.kind === "progress") {
          downloadedBytes += event.chunkBytes;
          setState((current) => ({
            ...current,
            downloadedBytes,
          }));
        } else {
          setState((current) => ({ ...current, phase: "installing" }));
        }
      };
      await api.installAppUpdate(channel);
      updatePendingRef.current = false;
      if (mountedRef.current) {
        setState((current) => ({ ...current, phase: "completed" }));
      }
    } catch (error) {
      if (mountedRef.current) {
        setState((current) => ({
          ...current,
          error: updaterError(error),
          ignoreError: false,
          phase: "error",
        }));
      }
    } finally {
      installingRef.current = false;
    }
  }, []);

  useEffect(() => {
    let active = true;
    void getVersion()
      .then((version) => {
        if (active) {
          setState((current) => ({
            ...current,
            currentVersion: normalizeReleaseVersion(version),
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
      void checkForUpdates("automatic", proxy, updateSource);
    }
  }, [autoUpdate, checkForUpdates, proxy, startupReady, updateSource]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (updatePendingRef.current) {
        updatePendingRef.current = false;
        void api.closeAppUpdate().catch(() => undefined);
      }
    };
  }, []);

  return {
    ...state,
    busy:
      state.phase === "checking" ||
      state.phase === "ignoring" ||
      state.phase === "downloading" ||
      state.phase === "installing",
    checkForUpdates,
    dismissUpdate,
    ignoreUpdate,
    installUpdate,
  };
}
