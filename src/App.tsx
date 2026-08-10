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
    </div>
  );
}
