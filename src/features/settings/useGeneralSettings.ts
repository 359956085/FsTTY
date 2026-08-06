import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../shared/api/client";
import { resolveApiError } from "../../shared/api/errors";
import type { AppSettings, Language } from "../../shared/api/types";
import type { AppUpdaterController } from "./useAppUpdater";

interface UseGeneralSettingsOptions {
  onChange: (settings: AppSettings) => void;
  settings: AppSettings;
  translate: (key: string) => string;
  updater: AppUpdaterController;
}

export function useGeneralSettings({
  onChange,
  settings,
  translate,
  updater,
}: UseGeneralSettingsOptions) {
  const [error, setError] = useState<string | null>(null);
  const [logDirectoryError, setLogDirectoryError] = useState<string | null>(null);
  const [logSettingsError, setLogSettingsError] = useState<string | null>(null);
  const [openingLogDirectory, setOpeningLogDirectory] = useState(false);
  const [proxy, setProxy] = useState(settings.updateProxy);
  const [savingLanguage, setSavingLanguage] = useState(false);
  const [savingLogSettings, setSavingLogSettings] = useState(false);
  const [savingUpdateSettings, setSavingUpdateSettings] = useState(false);
  const mountedRef = useRef(true);
  const openingLogDirectoryRef = useRef(false);
  const savingLanguageRef = useRef(false);
  const savingLogSettingsRef = useRef(false);
  const updateSettingsSaveRef = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => setProxy(settings.updateProxy), [settings.updateProxy]);
  useEffect(() => {
    // StrictMode 会重放 Effect；每次建立生命周期都必须恢复挂载状态。
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const changeLanguage = useCallback(
    async (language: Language) => {
      if (savingLanguageRef.current) {
        return;
      }
      savingLanguageRef.current = true;
      setSavingLanguage(true);
      setError(null);
      try {
        const nextSettings = await api.setLanguage(language);
        if (mountedRef.current) {
          onChange(nextSettings);
        }
      } catch (nextError) {
        if (mountedRef.current) {
          setError(resolveApiError(nextError, translate("errors.unknown")));
        }
      } finally {
        savingLanguageRef.current = false;
        if (mountedRef.current) {
          setSavingLanguage(false);
        }
      }
    },
    [onChange, translate],
  );

  const openLogDirectory = useCallback(async () => {
    if (openingLogDirectoryRef.current) {
      return;
    }
    openingLogDirectoryRef.current = true;
    setOpeningLogDirectory(true);
    setLogDirectoryError(null);
    try {
      await api.openLogDirectory();
    } catch (nextError) {
      if (mountedRef.current) {
        setLogDirectoryError(
          resolveApiError(nextError, translate("settings.openLogDirectoryFailed")),
        );
      }
    } finally {
      openingLogDirectoryRef.current = false;
      if (mountedRef.current) {
        setOpeningLogDirectory(false);
      }
    }
  }, [translate]);

  const saveLogSettings = useCallback(
    async (recordMcpToolInputs: boolean) => {
      if (savingLogSettingsRef.current) {
        return;
      }
      savingLogSettingsRef.current = true;
      setSavingLogSettings(true);
      setLogSettingsError(null);
      try {
        const nextSettings = await api.updateLogSettings(recordMcpToolInputs);
        if (mountedRef.current) {
          onChange(nextSettings);
        }
      } catch (nextError) {
        if (mountedRef.current) {
          setLogSettingsError(
            resolveApiError(nextError, translate("settings.logSettingsSaveFailed")),
          );
        }
      } finally {
        savingLogSettingsRef.current = false;
        if (mountedRef.current) {
          setSavingLogSettings(false);
        }
      }
    },
    [onChange, translate],
  );

  const saveUpdateSettings = useCallback(
    async (
      autoUpdate: boolean,
      updateProxy = proxy,
      allowRemoteClipboardWrite = settings.allowRemoteClipboardWrite,
    ) => {
      if (mountedRef.current) {
        setSavingUpdateSettings(true);
      }
      const save = updateSettingsSaveRef.current.then(async () => {
        if (mountedRef.current) {
          setError(null);
        }
        try {
          const nextSettings = await api.updateAppSettings(
            autoUpdate,
            updateProxy.trim(),
            allowRemoteClipboardWrite,
          );
          if (mountedRef.current) {
            setProxy(nextSettings.updateProxy);
            onChange(nextSettings);
          }
          return nextSettings;
        } catch (nextError) {
          if (mountedRef.current) {
            setError(resolveApiError(nextError, translate("errors.unknown")));
          }
          return null;
        }
      });
      // 多个控件可能连续保存；串行队列保证最后一次用户操作最终落盘。
      const queueTail = save.then(
        () => undefined,
        () => undefined,
      );
      updateSettingsSaveRef.current = queueTail;
      try {
        return await save;
      } finally {
        if (mountedRef.current && updateSettingsSaveRef.current === queueTail) {
          setSavingUpdateSettings(false);
        }
      }
    },
    [onChange, proxy, settings.allowRemoteClipboardWrite, translate],
  );

  const checkForUpdates = useCallback(async () => {
    const saved = await saveUpdateSettings(settings.autoUpdate);
    if (mountedRef.current && saved) {
      await updater.checkForUpdates("manual", saved.updateProxy);
    }
  }, [saveUpdateSettings, settings.autoUpdate, updater]);

  return {
    changeLanguage,
    checkForUpdates,
    error,
    logDirectoryError,
    logSettingsError,
    openLogDirectory,
    openingLogDirectory,
    proxy,
    saveLogSettings,
    saveUpdateSettings,
    savingLanguage,
    savingLogSettings,
    savingUpdateSettings,
    setProxy,
  };
}
