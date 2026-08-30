import {
  Copy,
  Info,
  Plug,
  RotateCcw,
  Settings2,
} from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { AppSettings, McpClientTarget } from "../../shared/api/types";
import { TextInput } from "../../shared/ui/TextInput";
import type { AppUpdaterController } from "./useAppUpdater";
import { GeneralSettingsPanel } from "./GeneralSettingsPanel";
import { AboutSettingsPanel } from "./AboutSettingsPanel";
import { LocalAgentSetupDialog } from "./LocalAgentSetupDialog";
import { McpCommandPolicyDialog } from "./McpCommandPolicyDialog";
import { McpConfigDialog } from "./McpConfigDialog";
import { McpPermissionTooltip } from "./McpPermissionTooltip";
import { McpPermissionsPanel } from "./McpPermissionsPanel";
import { SettingsIconAction } from "./SettingsIconAction";
import { useLocalAgentSetup } from "./useLocalAgentSetup";
import { useGeneralSettings } from "./useGeneralSettings";
import { useMcpSettings } from "./useMcpSettings";

interface SettingsPageProps {
  onChange: (settings: AppSettings) => void;
  settings: AppSettings;
  updater: AppUpdaterController;
}

type SettingsSection = "about" | "general" | "mcp";

export function SettingsPage({ settings, onChange, updater }: SettingsPageProps) {
  const { t } = useTranslation();
  const [activeSection, setActiveSection] = useState<SettingsSection>("general");
  const {
    changeLanguage: handleLanguageChange,
    changeTheme: handleThemeChange,
    checkForUpdates: handleCheckForUpdates,
    error,
    logDirectoryError,
    logSettingsError,
    openLogDirectory,
    openingLogDirectory,
    proxy,
    saveLogSettings,
    saveUpdateSettings,
    savingLanguage,
    savingTheme,
    savingLogSettings,
    savingUpdateSettings,
    setProxy,
  } = useGeneralSettings({ onChange, settings, translate: t, updater });
  const {
    clearHttpError,
    closeConfigDialog: closeMcpConfigDialog,
    commandPolicyGroup: mcpCommandPolicyGroup,
    configDialog: mcpConfigDialog,
    copyAgentPrompt: copyMcpAgentPrompt,
    copyConfig: copyMcpConfig,
    copyingPrompt: copyingMcpPrompt,
    getSavedPermissions: getSavedMcpPermissions,
    groups,
    httpError: mcpHttpError,
    loadConfig: loadMcpConfig,
    openConfigDialog: openMcpConfigDialog,
    permissionCatalog: mcpPermissionCatalog,
    permissionCatalogFailed: mcpPermissionCatalogFailed,
    permissionError: mcpPermissionError,
    permissionFor,
    permissions: mcpPermissions,
    permissionsDirty: mcpPermissionsDirty,
    permissionSaveSucceeded: mcpPermissionSaveSucceeded,
    permissionTooltip: mcpPermissionTooltip,
    port: mcpPort,
    promptCopied: mcpPromptCopied,
    promptError: mcpPromptError,
    rotateToken: rotateMcpToken,
    save: saveMcpSettings,
    savePort: saveHttpPort,
    saving: savingMcp,
    setCommandPolicyGroup: setMcpCommandPolicyGroup,
    setPermissionTooltip: setMcpPermissionTooltip,
    setPort: setMcpPort,
    showPermissionTooltip: showMcpPermissionTooltip,
    stdioError: mcpStdioError,
    updatePermission,
  } = useMcpSettings({ onChange, settings, translate: t });
  const {
    capabilities: localAgentCapabilities,
    cancel: closeLocalAgentDialog,
    configure: configureSelectedLocalAgents,
    configuring: configuringLocalAgents,
    dialogOpen: localAgentDialogOpen,
    error: localAgentError,
    loading: loadingLocalAgents,
    open: openLocalAgentDialog,
    results: localAgentResults,
  } = useLocalAgentSetup({
    getSavedPermissions: getSavedMcpPermissions,
    onChange,
    settings,
    translate: t,
  });
  const status = (() => {
    if (updater.phase === "checking") {
      return t("settings.checkingUpdate");
    }
    if (updater.phase === "upToDate") {
      return t("settings.upToDate");
    }
    if (updater.phase === "available" && updater.availableUpdate) {
      return t("settings.updateAvailable", { version: updater.availableUpdate.version });
    }
    if (updater.phase === "downloading") {
      return t("settings.downloadingUpdate");
    }
    if (updater.phase === "installing") {
      return t("settings.installingUpdate");
    }
    if (updater.phase === "completed") {
      return t("settings.updateInstalled");
    }
    return null;
  })();
  const visibleError =
    error ||
    updater.versionError ||
    (updater.phase === "error" && !updater.dialogOpen
      ? updater.error || t("settings.updateUnknownError")
      : null);
  const mcpClientOptions = [
    { value: "genericJson", label: t("settings.mcpClientGenericJson") },
    { value: "codex", label: "Codex" },
    { value: "claude", label: "Claude" },
    { value: "cursor", label: "Cursor" },
    { value: "vsCode", label: "VS Code / GitHub Copilot" },
    { value: "geminiCli", label: "Gemini CLI" },
    { value: "dsh", label: "dsh (DeepSeek Harness)" },
  ] satisfies ReadonlyArray<{ value: McpClientTarget; label: string }>;
  const sectionTitle = {
    about: t("settings.about"),
    general: t("settings.general"),
    mcp: t("settings.mcpTitle"),
  }[activeSection];

  return (
    <section aria-labelledby="settings-title" className="settings-page">
      <h1 className="sr-only" id="settings-title">
        {t("settings.title")}
      </h1>
      <nav aria-label={t("settings.navigationLabel")} className="settings-sidebar">
        <button
          aria-current={activeSection === "general" ? "page" : undefined}
          className="settings-sidebar-item"
          onClick={() => setActiveSection("general")}
          type="button"
        >
          <Settings2 aria-hidden="true" size={16} />
          <span>{t("settings.general")}</span>
        </button>
        <button
          aria-current={activeSection === "mcp" ? "page" : undefined}
          className="settings-sidebar-item"
          onClick={() => setActiveSection("mcp")}
          type="button"
        >
          <Plug aria-hidden="true" size={16} />
          <span>{t("settings.mcpTitle")}</span>
        </button>
        <button
          aria-current={activeSection === "about" ? "page" : undefined}
          className="settings-sidebar-item"
          onClick={() => setActiveSection("about")}
          type="button"
        >
          <Info aria-hidden="true" size={16} />
          <span>{t("settings.about")}</span>
        </button>
      </nav>

      <div className="settings-content">
        <header className="settings-section-heading">
          <h2>{sectionTitle}</h2>
        </header>

        {activeSection === "general" ? (
          <GeneralSettingsPanel
            activeTooltipKey={mcpPermissionTooltip?.key ?? null}
            logDirectoryError={logDirectoryError}
            logSettingsError={logSettingsError}
            onClipboardChange={(enabled) =>
              void saveUpdateSettings(settings.autoUpdate, proxy, enabled)
            }
            onHideTooltip={() => setMcpPermissionTooltip(null)}
            onLanguageChange={(language) => void handleLanguageChange(language)}
            onThemeChange={(theme) => void handleThemeChange(theme)}
            onOpenLogDirectory={() => void openLogDirectory()}
            onRecordMcpToolInputsChange={(enabled) => void saveLogSettings(enabled)}
            onShowTooltip={showMcpPermissionTooltip}
            onSettingsChange={onChange}
            openingLogDirectory={openingLogDirectory}
            savingLanguage={savingLanguage}
            savingTheme={savingTheme}
            savingLogSettings={savingLogSettings}
            savingUpdateSettings={savingUpdateSettings}
            settings={settings}
          />
        ) : activeSection === "about" ? (
          <AboutSettingsPanel
            error={visibleError}
            onAutoUpdateChange={(enabled) => void saveUpdateSettings(enabled)}
            onCheckUpdates={() => void handleCheckForUpdates()}
            onProxyChange={setProxy}
            onProxyCommit={() => void saveUpdateSettings(settings.autoUpdate)}
            onUpdateSourceChange={(source) =>
              void saveUpdateSettings(
                settings.autoUpdate,
                proxy,
                settings.allowRemoteClipboardWrite,
                source,
              )
            }
            proxy={proxy}
            savingUpdateSettings={savingUpdateSettings}
            settings={settings}
            status={status}
            updater={updater}
          />
        ) : (
          <>
            <section aria-labelledby="mcp-stdio-title" className="settings-panel settings-mcp-panel">
              <header className="settings-panel-header">
                <h3 id="mcp-stdio-title">{t("settings.mcpEnabled")}</h3>
              </header>
              <div className="settings-row">
                <div className="settings-row-copy">
                  <label className="settings-row-label" htmlFor="mcp-enabled">
                    {t("settings.mcpEnable")}
                  </label>
                  <small>{t("settings.mcpEnabledHint")}</small>
                </div>
                <input
                  checked={settings.mcpEnabled}
                  className="settings-auto-update-toggle"
                  disabled={savingMcp || configuringLocalAgents}
                  id="mcp-enabled"
                  onChange={(event) =>
                    void saveMcpSettings(
                      "stdio",
                      event.target.checked,
                      settings.mcpHttpEnabled,
                    )
                  }
                  role="switch"
                  type="checkbox"
                />
              </div>
              <div className="settings-row">
                <div className="settings-row-copy">
                  <span className="settings-row-label">{t("settings.mcpConfiguration")}</span>
                  <small>{t("settings.mcpStdioConfigHint")}</small>
                </div>
                <SettingsIconAction
                  activeTooltipKey={mcpPermissionTooltip?.key ?? null}
                  label={t("settings.mcpCopyConfig")}
                  onActivate={() => openMcpConfigDialog("stdio")}
                  onHideTooltip={() => setMcpPermissionTooltip(null)}
                  onShowTooltip={showMcpPermissionTooltip}
                  tooltipKey="stdio-copy"
                >
                  <Copy aria-hidden="true" size={16} />
                </SettingsIconAction>
              </div>
              <div className="settings-row">
                <div className="settings-row-copy">
                  <span className="settings-row-label">{t("settings.mcpAgentPrompt")}</span>
                  <small
                    className={mcpPromptError.stdio ? "settings-mcp-inline-error" : undefined}
                  >
                    {mcpPromptError.stdio ?? t("settings.mcpAgentPromptHint")}
                  </small>
                </div>
                <SettingsIconAction
                  activeTooltipKey={mcpPermissionTooltip?.key ?? null}
                  disabled={copyingMcpPrompt.stdio}
                  label={t(
                    mcpPromptCopied.stdio
                      ? "settings.mcpPromptCopied"
                      : "settings.mcpCopyPrompt",
                  )}
                  onActivate={(target) => void copyMcpAgentPrompt("stdio", target)}
                  onHideTooltip={() => setMcpPermissionTooltip(null)}
                  onShowTooltip={showMcpPermissionTooltip}
                  tooltipKey="stdio-agent-prompt-copy"
                >
                  <Copy aria-hidden="true" size={16} />
                </SettingsIconAction>
              </div>
              <div className="settings-row settings-mcp-last-row">
                <div className="settings-row-copy">
                  <span className="settings-row-label">{t("settings.localAgentSetup")}</span>
                  <small>{t("settings.localAgentSetupHint")}</small>
                </div>
                <SettingsIconAction
                  activeTooltipKey={mcpPermissionTooltip?.key ?? null}
                  label={t("settings.localAgentOpen")}
                  onActivate={() => void openLocalAgentDialog()}
                  onHideTooltip={() => setMcpPermissionTooltip(null)}
                  onShowTooltip={showMcpPermissionTooltip}
                  tooltipKey="local-agent-setup"
                >
                  <Settings2 aria-hidden="true" size={16} />
                </SettingsIconAction>
              </div>
              {mcpStdioError ? (
                <div className="form-error settings-mcp-feedback" role="alert">
                  {mcpStdioError}
                </div>
              ) : null}
            </section>

            <section aria-labelledby="mcp-http-title" className="settings-panel settings-mcp-panel">
              <header className="settings-panel-header">
                <h3 id="mcp-http-title">{t("settings.mcpHttp")}</h3>
              </header>
              <div className="settings-row">
                <div className="settings-row-copy">
                  <label className="settings-row-label" htmlFor="mcp-http-enabled">
                    {t("settings.mcpEnable")}
                  </label>
                  <small className="settings-mcp-risk-hint">
                    {t("settings.mcpHttpHint")}
                  </small>
                </div>
                <input
                  checked={settings.mcpHttpEnabled}
                  className="settings-auto-update-toggle"
                  disabled={savingMcp || !settings.mcpEnabled}
                  id="mcp-http-enabled"
                  onChange={(event) =>
                    void saveMcpSettings(
                      "http",
                      settings.mcpEnabled,
                      event.target.checked,
                    )
                  }
                  role="switch"
                  type="checkbox"
                />
              </div>
              <div className="settings-row">
                <div className="settings-row-copy">
                  <label className="settings-row-label" htmlFor="mcp-http-port">
                    {t("settings.mcpHttpPort")}
                  </label>
                  <small>{t("settings.mcpHttpPortHint")}</small>
                </div>
                <TextInput
                  className="settings-mcp-port-input"
                  disabled={savingMcp}
                  id="mcp-http-port"
                  inputMode="numeric"
                  onBlur={() => void saveHttpPort()}
                  onChange={(event) => {
                    setMcpPort(event.target.value);
                    clearHttpError();
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      event.currentTarget.blur();
                    }
                  }}
                  value={mcpPort}
                />
              </div>
              <div className="settings-row">
                <div className="settings-row-copy">
                  <span className="settings-row-label">{t("settings.mcpResetToken")}</span>
                  <small>{t("settings.mcpResetTokenHint")}</small>
                </div>
                <SettingsIconAction
                  activeTooltipKey={mcpPermissionTooltip?.key ?? null}
                  disabled={savingMcp}
                  label={t("settings.mcpResetToken")}
                  onActivate={() => void rotateMcpToken()}
                  onHideTooltip={() => setMcpPermissionTooltip(null)}
                  onShowTooltip={showMcpPermissionTooltip}
                  tooltipKey="http-reset-token"
                >
                  <RotateCcw aria-hidden="true" size={16} />
                </SettingsIconAction>
              </div>
              <div className="settings-row">
                <div className="settings-row-copy">
                  <span className="settings-row-label">{t("settings.mcpConfiguration")}</span>
                  <small className="settings-mcp-risk-hint">
                    {t("settings.mcpHttpConfigHint")}
                  </small>
                </div>
                <SettingsIconAction
                  activeTooltipKey={mcpPermissionTooltip?.key ?? null}
                  label={t("settings.mcpCopyConfig")}
                  onActivate={() => openMcpConfigDialog("http")}
                  onHideTooltip={() => setMcpPermissionTooltip(null)}
                  onShowTooltip={showMcpPermissionTooltip}
                  tooltipKey="http-copy"
                >
                  <Copy aria-hidden="true" size={16} />
                </SettingsIconAction>
              </div>
              <div className="settings-row settings-mcp-last-row">
                <div className="settings-row-copy">
                  <span className="settings-row-label">{t("settings.mcpAgentPrompt")}</span>
                  <small
                    className={mcpPromptError.http ? "settings-mcp-inline-error" : undefined}
                  >
                    {mcpPromptError.http ?? t("settings.mcpAgentPromptHint")}
                  </small>
                </div>
                <SettingsIconAction
                  activeTooltipKey={mcpPermissionTooltip?.key ?? null}
                  disabled={copyingMcpPrompt.http}
                  label={t(
                    mcpPromptCopied.http
                      ? "settings.mcpPromptCopied"
                      : "settings.mcpCopyPrompt",
                  )}
                  onActivate={(target) => void copyMcpAgentPrompt("http", target)}
                  onHideTooltip={() => setMcpPermissionTooltip(null)}
                  onShowTooltip={showMcpPermissionTooltip}
                  tooltipKey="http-agent-prompt-copy"
                >
                  <Copy aria-hidden="true" size={16} />
                </SettingsIconAction>
              </div>
              {mcpHttpError ? (
                <div className="form-error settings-mcp-feedback" role="alert">
                  {mcpHttpError}
                </div>
              ) : null}
            </section>

            <McpPermissionsPanel
              catalog={mcpPermissionCatalog}
              catalogFailed={mcpPermissionCatalogFailed}
              dirty={mcpPermissionsDirty}
              error={mcpPermissionError}
              groups={groups}
              onHideTooltip={() => setMcpPermissionTooltip(null)}
              onManageCommandPolicy={setMcpCommandPolicyGroup}
              onSave={() => void saveMcpSettings("permissions")}
              onShowTooltip={showMcpPermissionTooltip}
              onUpdate={updatePermission}
              permissions={mcpPermissions}
              saveSucceeded={mcpPermissionSaveSucceeded}
              saving={savingMcp}
              tooltipKey={mcpPermissionTooltip?.key ?? null}
            />
          </>
        )}
      </div>

      <McpPermissionTooltip
        onClose={() => setMcpPermissionTooltip(null)}
        tooltip={mcpPermissionTooltip}
      />
      <McpCommandPolicyDialog
        groupName={mcpCommandPolicyGroup}
        onClose={() => setMcpCommandPolicyGroup(null)}
        onConfirm={(commandPolicy) => {
          if (mcpCommandPolicyGroup) {
            updatePermission(mcpCommandPolicyGroup, { commandPolicy });
          }
          setMcpCommandPolicyGroup(null);
        }}
        permission={mcpCommandPolicyGroup ? permissionFor(mcpCommandPolicyGroup) : null}
      />
      <McpConfigDialog
        dialog={mcpConfigDialog}
        onClose={closeMcpConfigDialog}
        onCopy={() => void copyMcpConfig()}
        onTargetChange={(transport, target) => void loadMcpConfig(transport, target)}
        options={mcpClientOptions}
      />
      <LocalAgentSetupDialog
        capabilities={localAgentCapabilities}
        configuring={configuringLocalAgents}
        error={localAgentError}
        loading={loadingLocalAgents}
        onClose={closeLocalAgentDialog}
        onConfigure={(targets) => void configureSelectedLocalAgents(targets)}
        open={localAgentDialogOpen}
        results={localAgentResults}
      />
    </section>
  );
}
