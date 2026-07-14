import { useEffect, useMemo, useState } from "react";
import { Minus, Square, X } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useTranslation } from "react-i18next";
import { SessionsPage } from "./features/sessions/SessionsPage";
import { SettingsPage } from "./features/settings/SettingsPage";
import { api } from "./shared/api/client";
import { resolveApiError } from "./shared/api/errors";
import type { AppSettings } from "./shared/api/types";

import appIcon from "./assets/brand-icon.png";

type AppView = "sessions" | "settings";

export function App() {
  const { t, i18n } = useTranslation();
  const [view, setView] = useState<AppView>("sessions");
  const [settings, setSettings] = useState<AppSettings>({ language: "zh-CN" });
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    api
      .getAppSettings()
      .then((nextSettings) => {
        setSettings(nextSettings);
        void i18n.changeLanguage(nextSettings.language);
      })
      .catch((error: unknown) => {
        setLoadError(resolveApiError(error, t("errors.unknown")));
      });
  }, [i18n, t]);

  const navItems = useMemo(
    () => [
      { id: "sessions" as const, label: t("nav.sessions") },
      { id: "settings" as const, label: t("nav.settings") },
    ],
    [t],
  );

  const windowLabels =
    settings.language === "zh-CN"
      ? { minimize: "最小化", maximize: "最大化或还原", close: "关闭" }
      : { minimize: "Minimize", maximize: "Maximize or restore", close: "Close" };

  async function handleWindowAction(action: "minimize" | "maximize" | "close") {
    try {
      const currentWindow = getCurrentWindow();
      if (action === "minimize") {
        await currentWindow.minimize();
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
    <div className="app-shell">
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
        {view === "sessions" ? (
          <SessionsPage />
        ) : (
          <SettingsPage
            settings={settings}
            onChange={(nextSettings) => {
              setSettings(nextSettings);
              void i18n.changeLanguage(nextSettings.language);
            }}
          />
        )}
      </main>
    </div>
  );
}
