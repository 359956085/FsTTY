import { useEffect, useMemo, useState } from "react";
import { Minus, Square, X } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useTranslation } from "react-i18next";
import { SessionsPage } from "./features/sessions/SessionsPage";
import { SettingsPage } from "./features/settings/SettingsPage";
import { UpdateDialog } from "./features/settings/UpdateDialog";
import { useAppUpdater } from "./features/settings/useAppUpdater";
import { api } from "./shared/api/client";
import { resolveApiError } from "./shared/api/errors";
import type { AppSettings } from "./shared/api/types";
import { DEFAULT_SHORTCUTS } from "./shared/shortcuts";
import { readCachedThemePreference } from "./shared/theme";
import { useAppTheme } from "./shared/useAppTheme";
import {
  enterLightweightMode,
  getInitialLightweightModeState,
} from "./features/lightweight/lightweightMode";
import { Button } from "./shared/ui/Button";

import appIcon from "./assets/brand-icon.png";

type AppView = "sessions" | "settings";

export function App() {
  const { t, i18n } = useTranslation();
  const [view, setView] = useState<AppView>("sessions");
  const [settings, setSettings] = useState<AppSettings>({
    language: "zh-CN",
    theme: readCachedThemePreference(),
    autoUpdate: true,
    updateSource: "auto",
    updateProxy: "",
    allowRemoteClipboardWrite: true,
    ignoredUpdateVersion: null,
    mcpEnabled: false,
    mcpHttpEnabled: false,
    mcpHttpPort: 37653,
    mcpGroupPermissions: [],
    recordMcpToolInputs: false,
    shortcuts: DEFAULT_SHORTCUTS,
  });
  const [loadError, setLoadError] = useState<string | null>(null);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [lightweightDialogOpen, setLightweightDialogOpen] = useState(false);
  const [lightweightBusy, setLightweightBusy] = useState(false);
  const [suppressLightweightConfirmation, setSuppressLightweightConfirmation] =
    useState(() => getInitialLightweightModeState().suppressConfirmation);
  const [doNotAskAgain, setDoNotAskAgain] = useState(false);
  const resolvedTheme = useAppTheme(settings.theme);
  const updater = useAppUpdater({
    autoUpdate: settings.autoUpdate,
    ignoredUpdateVersion: settings.ignoredUpdateVersion,
    onSettingsChange: setSettings,
    proxy: settings.updateProxy,
    updateSource: settings.updateSource,
    startupReady: settingsLoaded,
  });

  useEffect(() => {
    let active = true;
    api
      .getAppSettings()
      .then((nextSettings) => {
        if (!active) {
          return;
        }
        setSettings(nextSettings);
        setSettingsLoaded(true);
        void i18n.changeLanguage(nextSettings.language);
      })
      .catch((error: unknown) => {
        if (active) {
          setLoadError(resolveApiError(error, i18n.t("errors.unknown")));
        }
      });
    return () => {
      active = false;
    };
  }, [i18n]);

  const navItems = useMemo(
    () => [
      { id: "sessions" as const, label: t("nav.sessions") },
      { id: "settings" as const, label: t("nav.settings") },
    ],
    [t],
  );

  const windowLabels = {
    minimize: t("nav.minimize"),
    maximize: t("nav.maximize"),
    close: t("nav.closeWindow"),
  };

  async function handleWindowAction(action: "minimize" | "maximize" | "close") {
    try {
      const currentWindow = getCurrentWindow();
      if (action === "minimize") {
        await currentWindow.minimize();
        // 保持窗口为可见状态，避免窗口状态插件把托盘最小化误记为启动隐藏。
        await currentWindow.setSkipTaskbar(true);
      } else if (action === "maximize") {
        await currentWindow.toggleMaximize();
      } else {
        await currentWindow.close();
      }
    } catch (error) {
      setLoadError(resolveApiError(error, t("errors.unknown")));
    }
  }

  async function handleEnterLightweightMode() {
    if (lightweightBusy) {
      return;
    }
    if (updater.phase === "downloading" || updater.phase === "installing") {
      setLoadError(t("lightweight.updateBusy"));
      return;
    }
    if (!suppressLightweightConfirmation) {
      setDoNotAskAgain(false);
      setLightweightDialogOpen(true);
      return;
    }
    await enterConfirmedLightweightMode(true);
  }

  async function enterConfirmedLightweightMode(suppressConfirmation: boolean) {
    setLightweightBusy(true);
    setLightweightDialogOpen(false);
    setLoadError(null);
    try {
      await enterLightweightMode(suppressConfirmation);
      setSuppressLightweightConfirmation(suppressConfirmation);
    } catch (error) {
      setLoadError(resolveApiError(error, t("errors.unknown")));
      setLightweightBusy(false);
    }
  }

  return (
    <div
      className="app-shell"
      onContextMenu={(event) => event.preventDefault()}
    >
      <header className="app-titlebar" data-tauri-drag-region>
        <div className="brand" data-tauri-drag-region>
          <img
            aria-hidden="true"
            className="brand-mark"
            data-tauri-drag-region
            src={appIcon}
            alt=""
          />
          <span data-tauri-drag-region>FsTTY</span>
        </div>
        <nav className="titlebar-nav" aria-label={t("nav.main")}>
          {navItems.map((item) => {
            return (
              <button
                aria-current={view === item.id ? "page" : undefined}
                className={
                  view === item.id
                    ? "titlebar-nav-item titlebar-nav-item-active"
                    : "titlebar-nav-item"
                }
                key={item.id}
                onClick={() => setView(item.id)}
                type="button"
              >
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>
        <div aria-hidden="true" className="titlebar-drag-region" data-tauri-drag-region />
        <div className="window-controls">
          <button
            aria-label={t("lightweight.enter")}
            className="lightweight-control"
            disabled={lightweightBusy}
            onClick={() => void handleEnterLightweightMode()}
            title={t("lightweight.enter")}
            type="button"
          >
            <svg
              aria-hidden="true"
              fill="none"
              height="22"
              viewBox="0 0 24 24"
              width="22"
            >
              <path
                d="M19.7 3.3C12.8 3.9 7.1 7.2 5.2 12.1c-.8 2-.7 4 .1 5.6m14.4-14.4c.1 6.4-2.7 12.1-7.6 13.8-2.4.8-4.8.4-6.8.6m0 0L3 20m2.3-2.3c2.4-3.2 5.3-6 8.8-8.2"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="1.7"
              />
            </svg>
          </button>
          <button
            aria-label={windowLabels.minimize}
            className="window-control"
            onClick={() => void handleWindowAction("minimize")}
            type="button"
          >
            <Minus aria-hidden="true" size={17} />
          </button>
          <button
            aria-label={windowLabels.maximize}
            className="window-control"
            onClick={() => void handleWindowAction("maximize")}
            type="button"
          >
            <Square aria-hidden="true" size={14} />
          </button>
          <button
            aria-label={windowLabels.close}
            className="window-control window-control-close"
            onClick={() => void handleWindowAction("close")}
            type="button"
          >
            <X aria-hidden="true" size={17} />
          </button>
        </div>
      </header>

      <main className="app-main">
        {loadError ? <div className="error-banner">{loadError}</div> : null}
        <div
          className={view === "sessions" ? "app-view" : "app-view app-view-hidden"}
        >
          <SessionsPage
            allowRemoteClipboardWrite={settings.allowRemoteClipboardWrite}
            theme={resolvedTheme}
            shortcuts={settings.shortcuts}
            visible={view === "sessions"}
          />
        </div>
        {view === "settings" ? (
          <SettingsPage
            settings={settings}
            updater={updater}
            onChange={(nextSettings) => {
              setSettings(nextSettings);
              void i18n.changeLanguage(nextSettings.language);
            }}
          />
        ) : null}
      </main>
      <UpdateDialog updater={updater} />
      {lightweightDialogOpen ? (
        <div className="dialog-backdrop lightweight-dialog-backdrop">
          <form
            aria-modal="true"
            aria-label={t("lightweight.title")}
            className="dialog lightweight-dialog"
            onKeyDown={(event) => {
              if (event.key === "Escape" && !lightweightBusy) {
                event.preventDefault();
                setDoNotAskAgain(false);
                setLightweightDialogOpen(false);
              }
            }}
            onSubmit={(event) => {
              event.preventDefault();
              void enterConfirmedLightweightMode(doNotAskAgain);
            }}
            role="dialog"
          >
            <header className="dialog-header">
              <h2>{t("lightweight.title")}</h2>
            </header>
            <div className="lightweight-dialog-body">
              <p>{t("lightweight.description")}</p>
              <p>{t("lightweight.backgroundHint")}</p>
              <p>{t("lightweight.restoreHint")}</p>
              <label className="lightweight-confirmation-row">
                <input
                  checked={doNotAskAgain}
                  onChange={(event) => setDoNotAskAgain(event.target.checked)}
                  type="checkbox"
                />
                <span>{t("lightweight.doNotAskAgain")}</span>
              </label>
            </div>
            <footer className="dialog-actions">
              <Button
                disabled={lightweightBusy}
                onClick={() => {
                  setDoNotAskAgain(false);
                  setLightweightDialogOpen(false);
                }}
                type="button"
                variant="ghost"
              >
                {t("sessions.cancel")}
              </Button>
              <Button autoFocus disabled={lightweightBusy} type="submit">
                {t("lightweight.confirm")}
              </Button>
            </footer>
          </form>
        </div>
      ) : null}
    </div>
  );
}
