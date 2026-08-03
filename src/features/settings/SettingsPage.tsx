import {
  Copy,
  Plug,
  RotateCcw,
  Settings2,
} from "lucide-react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../shared/api/client";
import { resolveApiError } from "../../shared/api/errors";
import type {
  AppSettings,
  Language,
  LocalAgentCapability,
  LocalAgentConfigureResult,
  LocalAgentTarget,
  McpClientTarget,
  McpGroupPermission,
  McpPermissionCatalogEntry,
  SessionGroup,
} from "../../shared/api/types";
import { TextInput } from "../../shared/ui/TextInput";
import type { AppUpdaterController } from "./useAppUpdater";
import { GeneralSettingsPanel } from "./GeneralSettingsPanel";
import { LocalAgentSetupDialog } from "./LocalAgentSetupDialog";
import {
  McpConfigDialog,
  type McpConfigDialogState,
  type McpTransport,
} from "./McpConfigDialog";
import {
  McpPermissionTooltip,
  type McpPermissionTooltipState,
} from "./McpPermissionTooltip";
import {
  permissionFrom,
  permissionsChanged,
  validateMcpPort,
} from "./mcpPermissions";
import { McpPermissionsPanel } from "./McpPermissionsPanel";
import { SettingsIconAction } from "./SettingsIconAction";

interface SettingsPageProps {
  onChange: (settings: AppSettings) => void;
  settings: AppSettings;
  updater: AppUpdaterController;
}

type SettingsSection = "general" | "mcp";
type McpSaveScope = "http" | "httpPort" | "permissions" | "stdio";
type McpPromptState<T> = Record<McpTransport, T>;

export function SettingsPage({ settings, onChange, updater }: SettingsPageProps) {
  const { t } = useTranslation();
  const [activeSection, setActiveSection] = useState<SettingsSection>("general");
  const [error, setError] = useState<string | null>(null);
  const [logDirectoryError, setLogDirectoryError] = useState<string | null>(null);
  const [openingLogDirectory, setOpeningLogDirectory] = useState(false);
  const [proxy, setProxy] = useState(settings.updateProxy);
  const [savingLanguage, setSavingLanguage] = useState(false);
  const [savingUpdateSettings, setSavingUpdateSettings] = useState(false);
  const updateSettingsSaveRef = useRef<Promise<void>>(Promise.resolve());
  const [groups, setGroups] = useState<SessionGroup[]>([]);
  const [mcpPermissionCatalog, setMcpPermissionCatalog] = useState<
    McpPermissionCatalogEntry[]
  >([]);
  const [mcpPermissionCatalogFailed, setMcpPermissionCatalogFailed] = useState(false);
  const [mcpPermissions, setMcpPermissions] = useState(settings.mcpGroupPermissions);
  const [savedMcpPermissions, setSavedMcpPermissions] = useState(settings.mcpGroupPermissions);
  const savedMcpPermissionsRef = useRef(settings.mcpGroupPermissions);
  const [mcpPort, setMcpPort] = useState(String(settings.mcpHttpPort));
  const [savingMcp, setSavingMcp] = useState(false);
  const [mcpStdioError, setMcpStdioError] = useState<string | null>(null);
  const [mcpHttpError, setMcpHttpError] = useState<string | null>(null);
  const [mcpPermissionError, setMcpPermissionError] = useState<string | null>(null);
  const [mcpPermissionSaveSucceeded, setMcpPermissionSaveSucceeded] = useState(false);
  const [mcpPermissionTooltip, setMcpPermissionTooltip] =
    useState<McpPermissionTooltipState | null>(null);
  const [mcpConfigDialog, setMcpConfigDialog] = useState<McpConfigDialogState | null>(null);
  const mcpConfigRequestRef = useRef(0);
  const [localAgentDialogOpen, setLocalAgentDialogOpen] = useState(false);
  const [localAgentCapabilities, setLocalAgentCapabilities] = useState<
    LocalAgentCapability[]
  >([]);
  const [localAgentResults, setLocalAgentResults] = useState<LocalAgentConfigureResult[]>([]);
  const [loadingLocalAgents, setLoadingLocalAgents] = useState(false);
  const [configuringLocalAgents, setConfiguringLocalAgents] = useState(false);
  const [localAgentError, setLocalAgentError] = useState<string | null>(null);
  const [copyingMcpPrompt, setCopyingMcpPrompt] = useState<McpPromptState<boolean>>({
    http: false,
    stdio: false,
  });
  const [mcpPromptCopied, setMcpPromptCopied] = useState<McpPromptState<boolean>>({
    http: false,
    stdio: false,
  });
  const [mcpPromptError, setMcpPromptError] = useState<McpPromptState<string | null>>({
    http: null,
    stdio: null,
  });
  const mcpPromptCopyInFlightRef = useRef<McpPromptState<boolean>>({
    http: false,
    stdio: false,
  });
  const mcpPromptCopiedTimerRef = useRef<Partial<McpPromptState<number>>>({});

  useEffect(() => setProxy(settings.updateProxy), [settings.updateProxy]);
  useEffect(() => {
    const previousSaved = savedMcpPermissionsRef.current;
    setMcpPermissions((current) =>
      permissionsChanged(groups, current, previousSaved)
        ? current
        : settings.mcpGroupPermissions,
    );
    savedMcpPermissionsRef.current = settings.mcpGroupPermissions;
    setSavedMcpPermissions(settings.mcpGroupPermissions);
  }, [groups, settings.mcpGroupPermissions]);
  useEffect(() => setMcpPort(String(settings.mcpHttpPort)), [settings.mcpHttpPort]);
  useEffect(() => {
    let active = true;
    void api
      .listSessions()
      .then((nextGroups) => {
        if (active) {
          setGroups(nextGroups);
        }
      })
      .catch(() => {
        if (active) {
          setGroups([]);
        }
      });
    void api
      .getMcpPermissionCatalog()
      .then((catalog) => {
        if (active) {
          setMcpPermissionCatalog(catalog);
          setMcpPermissionCatalogFailed(false);
        }
      })
      .catch(() => {
        if (active) {
          setMcpPermissionCatalog([]);
          setMcpPermissionCatalogFailed(true);
        }
      });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => setMcpPermissionTooltip(null), [settings.language]);
  useEffect(
    () => () => {
      for (const timer of Object.values(mcpPromptCopiedTimerRef.current)) {
        window.clearTimeout(timer);
      }
    },
    [],
  );
  function showMcpPermissionTooltip(
    key: string,
    text: string,
    target: HTMLElement,
  ) {
    const bounds = target.getBoundingClientRect();
    setMcpPermissionTooltip({
      key,
      text,
      anchor: {
        bottom: bounds.bottom,
        left: bounds.left,
        top: bounds.top,
        width: bounds.width,
      },
    });
  }

  function permissionFor(groupName: string): McpGroupPermission {
    return permissionFrom(mcpPermissions, groupName);
  }

  function updatePermission(groupName: string, patch: Partial<McpGroupPermission>) {
    const next = { ...permissionFor(groupName), ...patch };
    setMcpPermissionError(null);
    setMcpPermissionSaveSucceeded(false);
    setMcpPermissions((current) => [
      ...current.filter((permission) => permission.groupName !== groupName),
      next,
    ]);
  }

  async function saveMcpSettings(
    scope: McpSaveScope,
    enabled = settings.mcpEnabled,
    httpEnabled = settings.mcpHttpEnabled,
    httpPort = settings.mcpHttpPort,
  ) {
    setSavingMcp(true);
    if (scope === "stdio") {
      setMcpStdioError(null);
    } else if (scope === "http" || scope === "httpPort") {
      setMcpHttpError(null);
    } else {
      setMcpPermissionError(null);
      setMcpPermissionSaveSucceeded(false);
    }
    try {
      const permissions =
        scope === "permissions" ? mcpPermissions : savedMcpPermissionsRef.current;
      const next = await api.updateMcpSettings(
        enabled,
        httpEnabled,
        httpPort,
        permissions,
      );
      onChange(next);
      if (scope === "permissions") {
        savedMcpPermissionsRef.current = next.mcpGroupPermissions;
        setSavedMcpPermissions(next.mcpGroupPermissions);
        setMcpPermissions(next.mcpGroupPermissions);
        setMcpPermissionSaveSucceeded(true);
      } else if (scope === "httpPort") {
        setMcpPort(String(next.mcpHttpPort));
      }
    } catch (nextError) {
      const message = resolveApiError(nextError, t("settings.mcpSaveFailed"));
      if (scope === "stdio") {
        setMcpStdioError(message);
      } else if (scope === "http" || scope === "httpPort") {
        setMcpHttpError(message);
      } else {
        setMcpPermissionError(message);
      }
    } finally {
      setSavingMcp(false);
    }
  }

  async function loadMcpConfig(transport: McpTransport, target: McpClientTarget) {
    const requestId = ++mcpConfigRequestRef.current;
    setMcpConfigDialog((current) =>
      current
        ? { ...current, config: "", error: null, loading: true, target }
        : null,
    );
    try {
      const config =
        transport === "http"
          ? await api.getMcpHttpClientConfig(target)
          : await api.getMcpStdioClientConfig(target);
      if (requestId !== mcpConfigRequestRef.current) {
        return;
      }
      setMcpConfigDialog((current) =>
        current ? { ...current, config, loading: false } : null,
      );
    } catch (nextError) {
      if (requestId !== mcpConfigRequestRef.current) {
        return;
      }
      setMcpConfigDialog((current) =>
        current
          ? {
              ...current,
              error: resolveApiError(nextError, t("settings.mcpConfigLoadFailed")),
              loading: false,
            }
          : null,
      );
    }
  }

  function openMcpConfigDialog(transport: McpTransport) {
    const target: McpClientTarget = "codex";
    setMcpConfigDialog({
      config: "",
      error: null,
      loading: true,
      target,
      transport,
    });
    void loadMcpConfig(transport, target);
  }

  const closeMcpConfigDialog = useCallback(() => {
    mcpConfigRequestRef.current += 1;
    setMcpConfigDialog(null);
  }, []);

  const closeLocalAgentDialog = useCallback(() => {
    setLocalAgentDialogOpen(false);
  }, []);

  async function openLocalAgentDialog() {
    setLocalAgentDialogOpen(true);
    setLoadingLocalAgents(true);
    setLocalAgentResults([]);
    setLocalAgentError(null);
    try {
      setLocalAgentCapabilities(await api.inspectLocalAgentSetup());
    } catch (nextError) {
      setLocalAgentCapabilities([]);
      setLocalAgentError(
        resolveApiError(nextError, t("settings.localAgentDetectFailed")),
      );
    } finally {
      setLoadingLocalAgents(false);
    }
  }

  async function configureSelectedLocalAgents(targets: LocalAgentTarget[]) {
    if (configuringLocalAgents || targets.length === 0) {
      return;
    }
    setConfiguringLocalAgents(true);
    setLocalAgentError(null);
    setLocalAgentResults([]);
    try {
      if (!settings.mcpEnabled) {
        const nextSettings = await api.updateMcpSettings(
          true,
          settings.mcpHttpEnabled,
          settings.mcpHttpPort,
          savedMcpPermissionsRef.current,
        );
        onChange(nextSettings);
      }
      let results = await api.configureLocalAgents(targets);
      const cursor = results.find(
        (result) =>
          result.target === "cursor" &&
          result.mcpStatus !== "failed" &&
          result.promptStatus === "manualRequired",
      );
      if (cursor) {
        try {
          await writeText(await api.getMcpAgentPrompt());
          results = results.map((result) =>
            result.target === "cursor"
              ? { ...result, message: t("settings.localAgentCursorPromptCopied") }
              : result,
          );
        } catch (nextError) {
          results = results.map((result) =>
            result.target === "cursor"
              ? {
                  ...result,
                  message: resolveApiError(
                    nextError,
                    t("settings.localAgentCursorPromptCopyFailed"),
                  ),
                  promptStatus: "failed" as const,
                }
              : result,
          );
        }
      }
      setLocalAgentResults(results);
    } catch (nextError) {
      setLocalAgentError(
        resolveApiError(nextError, t("settings.localAgentConfigureFailed")),
      );
    } finally {
      setConfiguringLocalAgents(false);
    }
  }

  async function copyMcpConfig() {
    if (!mcpConfigDialog?.config) {
      return;
    }
    try {
      await writeText(mcpConfigDialog.config);
      closeMcpConfigDialog();
    } catch (nextError) {
      setMcpConfigDialog((current) =>
        current
          ? {
              ...current,
              error: resolveApiError(nextError, t("settings.mcpConfigCopyFailed")),
            }
          : null,
      );
    }
  }

  async function copyMcpAgentPrompt(transport: McpTransport, target: HTMLButtonElement) {
    if (mcpPromptCopyInFlightRef.current[transport]) {
      return;
    }
    mcpPromptCopyInFlightRef.current[transport] = true;
    setCopyingMcpPrompt((current) => ({ ...current, [transport]: true }));
    setMcpPromptCopied((current) => ({ ...current, [transport]: false }));
    setMcpPromptError((current) => ({ ...current, [transport]: null }));
    const previousTimer = mcpPromptCopiedTimerRef.current[transport];
    if (previousTimer !== undefined) {
      window.clearTimeout(previousTimer);
      delete mcpPromptCopiedTimerRef.current[transport];
    }
    try {
      const prompt = await api.getMcpAgentPrompt();
      await writeText(prompt);
      setMcpPromptCopied((current) => ({ ...current, [transport]: true }));
      const tooltipKey = `${transport}-agent-prompt-copy`;
      showMcpPermissionTooltip(
        tooltipKey,
        t("settings.mcpPromptCopied"),
        target,
      );
      mcpPromptCopiedTimerRef.current[transport] = window.setTimeout(() => {
        setMcpPromptCopied((current) => ({ ...current, [transport]: false }));
        setMcpPermissionTooltip((current) =>
          current?.key === tooltipKey ? null : current,
        );
        delete mcpPromptCopiedTimerRef.current[transport];
      }, 2_000);
    } catch (nextError) {
      setMcpPromptError((current) => ({
        ...current,
        [transport]: resolveApiError(nextError, t("settings.mcpPromptCopyFailed")),
      }));
    } finally {
      mcpPromptCopyInFlightRef.current[transport] = false;
      setCopyingMcpPrompt((current) => ({ ...current, [transport]: false }));
    }
  }

  async function rotateMcpToken() {
    setSavingMcp(true);
    setMcpHttpError(null);
    try {
      await api.rotateMcpHttpToken();
    } catch (nextError) {
      setMcpHttpError(resolveApiError(nextError, t("errors.unknown")));
    } finally {
      setSavingMcp(false);
    }
  }

  async function saveHttpPort() {
    const parsedPort = validateMcpPort(mcpPort);
    if (parsedPort === null) {
      setMcpHttpError(t("settings.mcpInvalidPort"));
      return;
    }
    if (parsedPort === settings.mcpHttpPort) {
      setMcpHttpError(null);
      return;
    }
    await saveMcpSettings(
      "httpPort",
      settings.mcpEnabled,
      settings.mcpHttpEnabled,
      parsedPort,
    );
  }

  async function handleLanguageChange(language: Language) {
    if (savingLanguage) {
      return;
    }
    setSavingLanguage(true);
    setError(null);
    try {
      const nextSettings = await api.setLanguage(language);
      onChange(nextSettings);
    } catch (nextError) {
      setError(resolveApiError(nextError, t("errors.unknown")));
    } finally {
      setSavingLanguage(false);
    }
  }

  async function openLogDirectory() {
    if (openingLogDirectory) {
      return;
    }
    setOpeningLogDirectory(true);
    setLogDirectoryError(null);
    try {
      await api.openLogDirectory();
    } catch (nextError) {
      setLogDirectoryError(
        resolveApiError(nextError, t("settings.openLogDirectoryFailed")),
      );
    } finally {
      setOpeningLogDirectory(false);
    }
  }

  async function saveUpdateSettings(
    autoUpdate: boolean,
    updateProxy = proxy,
    allowRemoteClipboardWrite = settings.allowRemoteClipboardWrite,
  ) {
    setSavingUpdateSettings(true);
    const save = updateSettingsSaveRef.current.then(async () => {
      setSavingUpdateSettings(true);
      setError(null);
      try {
        const nextSettings = await api.updateAppSettings(
          autoUpdate,
          updateProxy.trim(),
          allowRemoteClipboardWrite,
        );
        setProxy(nextSettings.updateProxy);
        onChange(nextSettings);
        return nextSettings;
      } catch (nextError) {
        setError(resolveApiError(nextError, t("errors.unknown")));
        return null;
      }
    });
    // 失焦、开关和检查按钮可能连续触发保存，串行写入才能保证最后一次操作生效。
    const queueTail = save.then(
      () => undefined,
      () => undefined,
    );
    updateSettingsSaveRef.current = queueTail;
    try {
      return await save;
    } finally {
      if (updateSettingsSaveRef.current === queueTail) {
        setSavingUpdateSettings(false);
      }
    }
  }

  async function handleCheckForUpdates() {
    const saved = await saveUpdateSettings(settings.autoUpdate);
    if (saved) {
      await updater.checkForUpdates("manual", saved.updateProxy);
    }
  }

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
  ] satisfies ReadonlyArray<{ value: McpClientTarget; label: string }>;
  const mcpPermissionsDirty = permissionsChanged(
    groups,
    mcpPermissions,
    savedMcpPermissions,
  );

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
      </nav>

      <div className="settings-content">
        <header className="settings-section-heading">
          <h2>{activeSection === "general" ? t("settings.general") : t("settings.mcpTitle")}</h2>
        </header>

        {activeSection === "general" ? (
          <GeneralSettingsPanel
            activeTooltipKey={mcpPermissionTooltip?.key ?? null}
            error={visibleError}
            logDirectoryError={logDirectoryError}
            onAutoUpdateChange={(enabled) => void saveUpdateSettings(enabled)}
            onCheckUpdates={() => void handleCheckForUpdates()}
            onClipboardChange={(enabled) =>
              void saveUpdateSettings(settings.autoUpdate, proxy, enabled)
            }
            onHideTooltip={() => setMcpPermissionTooltip(null)}
            onLanguageChange={(language) => void handleLanguageChange(language)}
            onOpenLogDirectory={() => void openLogDirectory()}
            onProxyChange={setProxy}
            onProxyCommit={() => void saveUpdateSettings(settings.autoUpdate)}
            onShowTooltip={showMcpPermissionTooltip}
            openingLogDirectory={openingLogDirectory}
            proxy={proxy}
            savingLanguage={savingLanguage}
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
                    setMcpHttpError(null);
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
