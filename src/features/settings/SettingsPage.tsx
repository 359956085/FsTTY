import { Copy, RefreshCw } from "lucide-react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../shared/api/client";
import { resolveApiError } from "../../shared/api/errors";
import type {
  AppSettings,
  Language,
  McpGroupPermission,
  McpHttpStatus,
  SessionGroup,
} from "../../shared/api/types";
import { Button } from "../../shared/ui/Button";
import { Select } from "../../shared/ui/Select";
import { TextInput } from "../../shared/ui/TextInput";
import type { AppUpdaterController } from "./useAppUpdater";

interface SettingsPageProps {
  onChange: (settings: AppSettings) => void;
  settings: AppSettings;
  updater: AppUpdaterController;
}

export function SettingsPage({ settings, onChange, updater }: SettingsPageProps) {
  const { t } = useTranslation();
  const [error, setError] = useState<string | null>(null);
  const [proxy, setProxy] = useState(settings.updateProxy);
  const [savingLanguage, setSavingLanguage] = useState(false);
  const [savingUpdateSettings, setSavingUpdateSettings] = useState(false);
  const updateSettingsSaveRef = useRef<Promise<void>>(Promise.resolve());
  const [groups, setGroups] = useState<SessionGroup[]>([]);
  const [mcpPermissions, setMcpPermissions] = useState(settings.mcpGroupPermissions);
  const [mcpPort, setMcpPort] = useState(String(settings.mcpHttpPort));
  const [mcpHttpStatus, setMcpHttpStatus] = useState<McpHttpStatus | null>(null);
  const [savingMcp, setSavingMcp] = useState(false);
  const [mcpError, setMcpError] = useState<string | null>(null);
  const [mcpSaveSucceeded, setMcpSaveSucceeded] = useState(false);

  useEffect(() => setProxy(settings.updateProxy), [settings.updateProxy]);
  useEffect(() => setMcpPermissions(settings.mcpGroupPermissions), [settings.mcpGroupPermissions]);
  useEffect(() => setMcpPort(String(settings.mcpHttpPort)), [settings.mcpHttpPort]);
  useEffect(() => {
    void api.listSessions().then(setGroups).catch(() => setGroups([]));
    void api.getMcpHttpStatus().then(setMcpHttpStatus).catch(() => setMcpHttpStatus(null));
  }, []);

  function permissionFor(groupName: string): McpGroupPermission {
    return (
      mcpPermissions.find((permission) => permission.groupName === groupName) ?? {
        groupName,
        enabled: false,
        sessionRead: true,
        fileRead: true,
        commandExecute: false,
        fileWrite: false,
        fileDelete: false,
      }
    );
  }

  function updatePermission(groupName: string, patch: Partial<McpGroupPermission>) {
    const next = { ...permissionFor(groupName), ...patch };
    setMcpError(null);
    setMcpSaveSucceeded(false);
    setMcpPermissions((current) => [
      ...current.filter((permission) => permission.groupName !== groupName),
      next,
    ]);
  }

  async function saveMcpSettings(
    enabled = settings.mcpEnabled,
    httpEnabled = settings.mcpHttpEnabled,
  ) {
    setSavingMcp(true);
    setMcpError(null);
    setMcpSaveSucceeded(false);
    try {
      const parsedPort = Number(mcpPort);
      if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
        setMcpError(t("settings.mcpInvalidPort"));
        return;
      }
      const next = await api.updateMcpSettings(
        enabled,
        httpEnabled,
        parsedPort,
        mcpPermissions,
      );
      setMcpPermissions(next.mcpGroupPermissions);
      setMcpPort(String(next.mcpHttpPort));
      onChange(next);
      setMcpHttpStatus(await api.getMcpHttpStatus().catch(() => null));
      setMcpSaveSucceeded(true);
    } catch (nextError) {
      setMcpError(resolveApiError(nextError, t("settings.mcpSaveFailed")));
    } finally {
      setSavingMcp(false);
    }
  }

  async function copyMcpConfig(transport: "http" | "stdio") {
    setMcpError(null);
    try {
      const config =
        transport === "http"
          ? await api.getMcpHttpClientConfig()
          : await api.getMcpStdioClientConfig();
      await writeText(config);
    } catch (nextError) {
      setMcpError(resolveApiError(nextError, t("errors.unknown")));
    }
  }

  async function rotateMcpToken() {
    setSavingMcp(true);
    setMcpError(null);
    try {
      await api.rotateMcpHttpToken();
      setMcpHttpStatus(await api.getMcpHttpStatus());
    } catch (nextError) {
      setMcpError(resolveApiError(nextError, t("errors.unknown")));
    } finally {
      setSavingMcp(false);
    }
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

  return (
    <section aria-labelledby="settings-title" className="settings-page">
      <h1 className="sr-only" id="settings-title">
        {t("settings.title")}
      </h1>
      <div className="settings-content">
        <section aria-labelledby="general-settings-title" className="settings-panel">
          <header className="settings-panel-header">
            <h2 id="general-settings-title">{t("settings.general")}</h2>
          </header>
          <div className="settings-row settings-language-row">
            <span className="settings-row-label">{t("settings.language")}</span>
            <Select<Language>
              ariaLabel={t("settings.language")}
              className="settings-language-select"
              disabled={savingLanguage}
              onChange={(language) => void handleLanguageChange(language)}
              options={[
                { value: "zh-CN", label: t("settings.chinese") },
                { value: "en-US", label: t("settings.english") },
              ]}
              value={settings.language}
            />
          </div>
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
              onChange={(event) =>
                void saveUpdateSettings(
                  settings.autoUpdate,
                  proxy,
                  event.target.checked,
                )
              }
              role="switch"
              type="checkbox"
            />
          </div>
        </section>

        <section aria-labelledby="mcp-settings-title" className="settings-panel settings-mcp-panel">
          <header className="settings-panel-header">
            <h2 id="mcp-settings-title">{t("settings.mcpTitle")}</h2>
          </header>
          <div className="settings-row">
            <div className="settings-row-copy">
              <label className="settings-row-label" htmlFor="mcp-enabled">
                {t("settings.mcpEnabled")}
              </label>
              <small>{t("settings.mcpEnabledHint")}</small>
            </div>
            <input
              checked={settings.mcpEnabled}
              className="settings-auto-update-toggle"
              disabled={savingMcp}
              id="mcp-enabled"
              onChange={(event) => void saveMcpSettings(event.target.checked)}
              role="switch"
              type="checkbox"
            />
          </div>
          <div className="settings-row">
            <div className="settings-row-copy">
              <label className="settings-row-label" htmlFor="mcp-http-enabled">
                {t("settings.mcpHttp")}
              </label>
              <small>
                {mcpHttpStatus?.running
                  ? t("settings.mcpRunning", { address: mcpHttpStatus.address })
                  : t("settings.mcpStopped")}
              </small>
            </div>
            <input
              checked={settings.mcpHttpEnabled}
              className="settings-auto-update-toggle"
              disabled={savingMcp || !settings.mcpEnabled}
              id="mcp-http-enabled"
              onChange={(event) =>
                void saveMcpSettings(settings.mcpEnabled, event.target.checked)
              }
              role="switch"
              type="checkbox"
            />
          </div>
          <div className="settings-row settings-proxy-row">
            <div className="settings-row-copy">
              <label className="settings-row-label" htmlFor="mcp-http-port">
                {t("settings.mcpHttpPort")}
              </label>
              <small>{`http://<FSTTY_HOST_IP>:${mcpPort || "37653"}/mcp`}</small>
            </div>
            <TextInput
              disabled={savingMcp}
              id="mcp-http-port"
              inputMode="numeric"
              onChange={(event) => {
                setMcpPort(event.target.value);
                setMcpError(null);
                setMcpSaveSucceeded(false);
              }}
              value={mcpPort}
            />
          </div>
          <div className="settings-mcp-warning">{t("settings.mcpHttpWarning")}</div>
          <div className="settings-mcp-warning">{t("settings.mcpCommandWarning")}</div>
          <div className="settings-mcp-grid">
            <span>{t("settings.mcpGroup")}</span>
            <span>{t("settings.mcpAccess")}</span>
            <span>{t("settings.mcpSessionRead")}</span>
            <span>{t("settings.mcpFileRead")}</span>
            <span>{t("settings.mcpCommand")}</span>
            <span>{t("settings.mcpFileWrite")}</span>
            <span>{t("settings.mcpDelete")}</span>
            {groups.flatMap((group) => {
              const permission = permissionFor(group.name);
              const fields: (keyof McpGroupPermission)[] = [
                "enabled",
                "sessionRead",
                "fileRead",
                "commandExecute",
                "fileWrite",
                "fileDelete",
              ];
              return [
                <strong key={`${group.name}-name`}>{group.name}</strong>,
                ...fields.map((field) => (
                  <input
                    aria-label={`${group.name} ${String(field)}`}
                    checked={Boolean(permission[field])}
                    disabled={savingMcp}
                    key={`${group.name}-${String(field)}`}
                    onChange={(event) =>
                      updatePermission(group.name, { [field]: event.target.checked })
                    }
                    type="checkbox"
                  />
                )),
              ];
            })}
          </div>
          {mcpError ? (
            <div className="form-error settings-mcp-feedback" role="alert">
              {mcpError}
            </div>
          ) : mcpSaveSucceeded ? (
            <div className="form-success settings-mcp-feedback" role="status">
              {t("settings.mcpSaved")}
            </div>
          ) : null}
          <div className="settings-mcp-actions">
            <Button
              icon={<Copy aria-hidden="true" size={16} />}
              onClick={() => void copyMcpConfig("stdio")}
              variant="ghost"
            >
              {t("settings.mcpCopyStdioConfig")}
            </Button>
            <Button
              icon={<Copy aria-hidden="true" size={16} />}
              onClick={() => void copyMcpConfig("http")}
              variant="ghost"
            >
              {t("settings.mcpCopyHttpConfig")}
            </Button>
            <Button
              icon={<RefreshCw aria-hidden="true" size={16} />}
              onClick={() => void rotateMcpToken()}
              variant="ghost"
            >
              {t("settings.mcpRotateToken")}
            </Button>
            <Button disabled={savingMcp} onClick={() => void saveMcpSettings()}>
              {t("settings.mcpSave")}
            </Button>
          </div>
        </section>

        <section aria-labelledby="version-settings-title" className="settings-panel">
          <header className="settings-panel-header">
            <h2 id="version-settings-title">{t("settings.version")}</h2>
          </header>
          <div className="settings-row">
            <span className="settings-row-label">{t("settings.currentVersion")}</span>
            <span className="settings-current-version">
              {updater.currentVersion ? `v${updater.currentVersion}` : "—"}
            </span>
          </div>
          <div className="settings-row">
            <span className="settings-row-label">{t("settings.checkUpdate")}</span>
            <div className="settings-update-control">
              {status ? (
                <span aria-live="polite" className="settings-update-status">
                  {status}
                </span>
              ) : null}
              <Button
                disabled={updater.busy || savingUpdateSettings}
                icon={<RefreshCw aria-hidden="true" size={16} />}
                onClick={() => void handleCheckForUpdates()}
              >
                {updater.phase === "checking"
                  ? t("settings.checkingUpdate")
                  : t("settings.checkUpdate")}
              </Button>
            </div>
          </div>
          <div className="settings-row">
            <div className="settings-row-copy">
              <label className="settings-row-label" htmlFor="auto-update">
                {t("settings.autoUpdate")}
              </label>
              <small>{t("settings.autoUpdateHint")}</small>
            </div>
            <input
              aria-label={t("settings.autoUpdate")}
              checked={settings.autoUpdate}
              className="settings-auto-update-toggle"
              disabled={savingUpdateSettings}
              id="auto-update"
              onChange={(event) => void saveUpdateSettings(event.target.checked)}
              role="switch"
              type="checkbox"
            />
          </div>
          <div className="settings-row settings-proxy-row">
            <div className="settings-row-copy">
              <label className="settings-row-label" htmlFor="update-proxy">
                {t("settings.updateProxy")}
              </label>
              <small>{t("settings.updateProxyHint")}</small>
            </div>
            <TextInput
              className="settings-proxy-input"
              disabled={savingUpdateSettings || updater.phase === "downloading"}
              id="update-proxy"
              onBlur={() => void saveUpdateSettings(settings.autoUpdate)}
              onChange={(event) => setProxy(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.currentTarget.blur();
                }
              }}
              placeholder="http://127.0.0.1:7890"
              value={proxy}
            />
          </div>
          {visibleError ? <div className="form-error settings-error">{visibleError}</div> : null}
        </section>
      </div>
    </section>
  );
}
