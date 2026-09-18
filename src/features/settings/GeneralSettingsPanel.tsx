import { FolderOpen } from "lucide-react";
import { useTranslation } from "react-i18next";
import type {
  AppSettings,
  Language,
  ThemePreference,
  TerminalColorScheme,
} from "../../shared/api/types";
import { Select } from "../../shared/ui/Select";
import { Button } from "../../shared/ui/Button";
import { TextInput } from "../../shared/ui/TextInput";
import { useAutostartSettings } from "./useAutostartSettings";
import { SettingsIconAction } from "./SettingsIconAction";
import { CommandHistorySettingsSection } from "./CommandHistorySettingsSection";
import { ShortcutSettingsSection } from "./ShortcutSettingsSection";
import { CredentialSecuritySection } from "./CredentialSecuritySection";

interface GeneralSettingsPanelProps {
  activeTooltipKey: string | null;
  logDirectoryError: string | null;
  logSettingsError: string | null;
  onClipboardChange: (enabled: boolean) => void;
  onProxyChange: (value: string) => void;
  onProxyCommit: () => void;
  onProxyEnabledChange: (enabled: boolean) => void;
  proxy: string;
  proxyError: string | null;
  savingProxy: boolean;
  onHideTooltip: () => void;
  onLanguageChange: (language: Language) => void;
  onThemeChange: (theme: ThemePreference) => void;
  onTerminalColorSchemeChange: (colorScheme: TerminalColorScheme) => void;
  onOpenLogDirectory: () => void;
  onRecordMcpToolInputsChange: (enabled: boolean) => void;
  onShowTooltip: (key: string, text: string, element: HTMLElement) => void;
  onSettingsChange: (settings: AppSettings) => void;
  openingLogDirectory: boolean;
  savingLanguage: boolean;
  savingTheme: boolean;
  savingTerminalColorScheme: boolean;
  savingLogSettings: boolean;
  savingUpdateSettings: boolean;
  settings: AppSettings;
}

export function GeneralSettingsPanel({
  activeTooltipKey,
  logDirectoryError,
  logSettingsError,
  onClipboardChange,
  onProxyChange,
  onProxyCommit,
  onProxyEnabledChange,
  proxy,
  proxyError,
  savingProxy,
  onHideTooltip,
  onLanguageChange,
  onThemeChange,
  onTerminalColorSchemeChange,
  onOpenLogDirectory,
  onRecordMcpToolInputsChange,
  onShowTooltip,
  onSettingsChange,
  openingLogDirectory,
  savingLanguage,
  savingTheme,
  savingTerminalColorScheme,
  savingLogSettings,
  savingUpdateSettings,
  settings,
}: GeneralSettingsPanelProps) {
  const { t } = useTranslation();
  const autostart = useAutostartSettings(t);

  return (
    <>
      <section aria-labelledby="general-settings-title" className="settings-panel">
        <header className="settings-panel-header">
          <h3 id="general-settings-title">{t("settings.generalSettings")}</h3>
        </header>
        <div className="settings-row settings-language-row">
          <span className="settings-row-label">{t("settings.language")}</span>
          <Select<Language>
            ariaLabel={t("settings.language")}
            className="settings-language-select"
            disabled={savingLanguage}
            onChange={onLanguageChange}
            options={[
              { value: "zh-CN", label: t("settings.chinese") },
              { value: "en-US", label: t("settings.english") },
            ]}
            value={settings.language}
          />
        </div>
        <div className="settings-row settings-language-row">
          <span className="settings-row-label">{t("settings.theme")}</span>
          <Select<ThemePreference>
            ariaLabel={t("settings.theme")}
            className="settings-language-select"
            disabled={savingTheme || savingTerminalColorScheme}
            onChange={onThemeChange}
            options={[
              { value: "system", label: t("settings.themeSystem") },
              { value: "light", label: t("settings.themeLight") },
              { value: "dark", label: t("settings.themeDark") },
            ]}
            value={settings.theme}
          />
        </div>
        <div className="settings-row settings-language-row">
          <div className="settings-row-copy">
            <span className="settings-row-label">{t("settings.terminalColorScheme")}</span>
            <small>{t("settings.terminalColorSchemeHint")}</small>
          </div>
          <Select<TerminalColorScheme>
            ariaLabel={t("settings.terminalColorScheme")}
            className="settings-language-select settings-terminal-color-select"
            disabled={savingTheme || savingTerminalColorScheme}
            onChange={onTerminalColorSchemeChange}
            options={[
              { value: "default", label: t("settings.terminalColorSchemeDefault") },
              { value: "dracula", label: "Dracula" },
              { value: "catppuccin", label: "Catppuccin Mocha" },
              { value: "nord", label: "Nord" },
              { value: "solarized", label: "Solarized" },
            ]}
            value={settings.terminalColorScheme}
          />
        </div>
        <div className="settings-row">
          <div className="settings-row-copy">
            <label className="settings-row-label" htmlFor="autostart-enabled">
              {t("settings.autostart")}
            </label>
            <small>{t("settings.autostartHint")}</small>
            {!autostart.confirmed && !autostart.loading ? <small>{t("settings.autostartUnknown")}</small> : null}
          </div>
          <input
            aria-label={t("settings.autostart")}
            aria-busy={autostart.loading || autostart.saving}
            checked={autostart.enabled}
            className="settings-auto-update-toggle"
            disabled={autostart.loading || autostart.saving || !autostart.confirmed}
            id="autostart-enabled"
            onChange={(event) => void autostart.save(event.target.checked)}
            role="switch"
            type="checkbox"
          />
        </div>
        {autostart.error ? (
          <div className="form-error settings-error" role="alert">
            {autostart.error}
            <Button disabled={autostart.loading || autostart.saving} onClick={() => void autostart.refresh()} variant="ghost">
              {t("settings.autostartRetry")}
            </Button>
          </div>
        ) : null}
        <div className="settings-row settings-clipboard-row">
          <div className="settings-row-copy">
            <label className="settings-row-label" htmlFor="remote-clipboard-write">
              {t("settings.remoteClipboardWrite")}
            </label>
            <small>{t("settings.remoteClipboardWriteHint")}</small>
          </div>
          <input
            aria-label={t("settings.remoteClipboardWrite")}
            checked={settings.allowRemoteClipboardWrite}
            className="settings-auto-update-toggle"
            disabled={savingUpdateSettings}
            id="remote-clipboard-write"
            onChange={(event) => onClipboardChange(event.target.checked)}
            role="switch"
            type="checkbox"
          />
        </div>
      </section>

      <section aria-labelledby="proxy-settings-title" className="settings-panel">
        <header className="settings-panel-header">
          <h3 id="proxy-settings-title">{t("settings.proxyTitle")}</h3>
        </header>
        <div className="settings-row">
          <label className="settings-row-label" htmlFor="proxy-enabled">{t("settings.proxyEnable")}</label>
          <input
            aria-label={t("settings.proxyEnable")}
            aria-busy={savingProxy}
            checked={settings.proxyEnabled}
            className="settings-auto-update-toggle"
            disabled={savingProxy}
            id="proxy-enabled"
            onChange={(event) => onProxyEnabledChange(event.target.checked)}
            role="switch"
            type="checkbox"
          />
        </div>
        <div className="settings-row settings-proxy-row">
          <div className="settings-row-copy">
            <label className="settings-row-label" htmlFor="proxy-address">
              {t("settings.proxyAddress")}
            </label>
            <small>{t("settings.proxyAddressHint")}</small>
            {savingProxy ? <small aria-live="polite">{t("settings.proxySaving")}</small> : null}
          </div>
          <TextInput
            aria-busy={savingProxy}
            className="settings-proxy-input"
            disabled={savingProxy}
            id="proxy-address"
            onBlur={onProxyCommit}
            onChange={(event) => onProxyChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.currentTarget.blur();
              }
            }}
            placeholder="http://127.0.0.1:7890"
            value={proxy}
          />
        </div>
        {proxyError ? <div className="form-error settings-error" role="alert">{proxyError}</div> : null}
      </section>

      <ShortcutSettingsSection onChange={onSettingsChange} settings={settings.shortcuts} />

      <CommandHistorySettingsSection />

      <CredentialSecuritySection />

      <section aria-labelledby="log-settings-title" className="settings-panel">
        <header className="settings-panel-header">
          <h3 id="log-settings-title">{t("settings.logs")}</h3>
        </header>
        <div className="settings-row">
          <div className="settings-row-copy">
            <span className="settings-row-label">{t("settings.logDirectory")}</span>
            <small>{t("settings.logsHint")}</small>
          </div>
          <SettingsIconAction
            activeTooltipKey={activeTooltipKey}
            disabled={openingLogDirectory}
            label={t("settings.openLogDirectory")}
            onActivate={onOpenLogDirectory}
            onHideTooltip={onHideTooltip}
            onShowTooltip={onShowTooltip}
            tooltipKey="open-log-directory"
          >
            <FolderOpen aria-hidden="true" size={16} />
          </SettingsIconAction>
        </div>
        {logDirectoryError ? (
          <div className="form-error settings-error" role="alert">
            {logDirectoryError}
          </div>
        ) : null}
        <div className="settings-row settings-log-row">
          <div className="settings-row-copy">
            <label className="settings-row-label" htmlFor="record-mcp-tool-inputs">
              {t("settings.recordMcpToolInputs")}
            </label>
            <small>{t("settings.recordMcpToolInputsHint")}</small>
          </div>
          <input
            aria-label={t("settings.recordMcpToolInputs")}
            checked={settings.recordMcpToolInputs}
            className="settings-auto-update-toggle"
            disabled={savingLogSettings}
            id="record-mcp-tool-inputs"
            onChange={(event) => onRecordMcpToolInputsChange(event.target.checked)}
            role="switch"
            type="checkbox"
          />
        </div>
        {logSettingsError ? (
          <div className="form-error settings-error" role="alert">
            {logSettingsError}
          </div>
        ) : null}
      </section>
    </>
  );
}
