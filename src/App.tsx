import { useEffect, useMemo, useState } from "react";
import { Monitor, Settings } from "lucide-react";
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
      { id: "sessions" as const, label: t("nav.sessions"), icon: Monitor },
      { id: "settings" as const, label: t("nav.settings"), icon: Settings },
    ],
    [t],
  );

  return (
    <div className="app-shell">
      <aside className="app-nav">
        <div className="brand">
          <img aria-hidden="true" className="brand-mark" src={appIcon} alt="" />
          <span>FsTTY</span>
        </div>
        <nav className="nav-list" aria-label={t("nav.main")}>
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <button
                className={view === item.id ? "nav-item nav-item-active" : "nav-item"}
                key={item.id}
                onClick={() => setView(item.id)}
                type="button"
              >
                <Icon size={18} />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>
      </aside>

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