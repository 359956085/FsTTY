import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../shared/api/client";
import { resolveApiError } from "../../shared/api/errors";
import type {
  AppSettings,
  McpClientTarget,
  McpGroupPermission,
  McpPermissionCatalogEntry,
  SessionGroup,
} from "../../shared/api/types";
import { createLatestRequestGuard } from "../../shared/async/latestRequest";
import type { McpConfigDialogState, McpTransport } from "./McpConfigDialog";
import type { McpPermissionTooltipState } from "./McpPermissionTooltip";
import { permissionFrom, permissionsChanged, validateMcpPort } from "./mcpPermissions";
import { useMcpPromptCopy } from "./useMcpPromptCopy";

type McpSaveScope = "http" | "httpPort" | "permissions" | "stdio";

interface UseMcpSettingsOptions {
  configurationBusyRef?: { current: boolean };
  onChange: (settings: AppSettings) => void;
  settings: AppSettings;
  translate: (key: string) => string;
}

export function useMcpSettings({ configurationBusyRef, onChange, settings, translate }: UseMcpSettingsOptions) {
  const [groups, setGroups] = useState<SessionGroup[]>([]);
  const [permissionCatalog, setPermissionCatalog] = useState<McpPermissionCatalogEntry[]>([]);
  const [permissionCatalogFailed, setPermissionCatalogFailed] = useState(false);
  const [permissions, setPermissions] = useState(settings.mcpGroupPermissions);
  const [savedPermissions, setSavedPermissions] = useState(settings.mcpGroupPermissions);
  const savedPermissionsRef = useRef(settings.mcpGroupPermissions);
  const [port, setPort] = useState(String(settings.mcpHttpPort));
  const portRef = useRef(String(settings.mcpHttpPort));
  const settingsRef = useRef(settings);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const pendingMutationRef = useRef<Promise<boolean> | null>(null);
  const [stdioError, setStdioError] = useState<string | null>(null);
  const [httpError, setHttpError] = useState<string | null>(null);
  const [permissionError, setPermissionError] = useState<string | null>(null);
  const [permissionSaveSucceeded, setPermissionSaveSucceeded] = useState(false);
  const [commandPolicyGroup, setCommandPolicyGroup] = useState<string | null>(null);
  const [permissionTooltip, setPermissionTooltip] =
    useState<McpPermissionTooltipState | null>(null);
  const [configDialog, setConfigDialog] = useState<McpConfigDialogState | null>(null);
  const configRequestRef = useRef(createLatestRequestGuard());
  const mountedRef = useRef(true);
  const {
    copied: promptCopied,
    copying: copyingPrompt,
    copy: copyAgentPrompt,
    error: promptError,
  } = useMcpPromptCopy(setPermissionTooltip);

  useEffect(() => {
    // StrictMode 会重放 Effect；新生命周期必须重新允许异步结果更新界面。
    mountedRef.current = true;
    const configRequest = configRequestRef.current;
    return () => {
      mountedRef.current = false;
      configRequest.invalidate();
    };
  }, []);
  useEffect(() => {
    const previousSaved = savedPermissionsRef.current;
    setPermissions((current) =>
      permissionsChanged(groups, current, previousSaved)
        ? current
        : settings.mcpGroupPermissions,
    );
    savedPermissionsRef.current = settings.mcpGroupPermissions;
    setSavedPermissions(settings.mcpGroupPermissions);
  }, [groups, settings.mcpGroupPermissions]);
  useEffect(() => {
    const previousPort = settingsRef.current.mcpHttpPort;
    settingsRef.current = settings;
    if (portRef.current === String(previousPort)) {
      portRef.current = String(settings.mcpHttpPort);
      setPort(portRef.current);
    }
  }, [settings]);
  useEffect(() => {
    let active = true;
    void api
      .listSessions()
      .then((nextGroups) => {
        if (active) setGroups(nextGroups);
      })
      .catch(() => {
        if (active) setGroups([]);
      });
    void api
      .getMcpPermissionCatalog()
      .then((catalog) => {
        if (active) {
          setPermissionCatalog(catalog);
          setPermissionCatalogFailed(false);
        }
      })
      .catch(() => {
        if (active) {
          setPermissionCatalog([]);
          setPermissionCatalogFailed(true);
        }
      });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => setPermissionTooltip(null), [settings.language]);

  const showPermissionTooltip = useCallback(
    (key: string, text: string, target: HTMLElement) => {
      const bounds = target.getBoundingClientRect();
      setPermissionTooltip({
        key,
        text,
        anchor: {
          bottom: bounds.bottom,
          left: bounds.left,
          top: bounds.top,
          width: bounds.width,
        },
      });
    },
    [],
  );

  const permissionFor = useCallback(
    (groupName: string) => permissionFrom(permissions, groupName),
    [permissions],
  );

  const updatePermission = useCallback(
    (groupName: string, patch: Partial<McpGroupPermission>) => {
      const next = { ...permissionFrom(permissions, groupName), ...patch };
      setPermissionError(null);
      setPermissionSaveSucceeded(false);
      setPermissions((current) => [
        ...current.filter((permission) => permission.groupName !== groupName),
        next,
      ]);
    },
    [permissions],
  );

  const applyBackendSettings = useCallback((next: AppSettings) => {
    if (!mountedRef.current) return;
    // 只同步仍等于旧保存值的草稿，迟到响应不能覆盖用户刚输入的新端口。
    if (portRef.current === String(settingsRef.current.mcpHttpPort)) {
      portRef.current = String(next.mcpHttpPort);
      setPort(portRef.current);
    }
    settingsRef.current = next;
    onChange(next);
  }, [onChange]);

  const changePort = useCallback((next: string) => {
    portRef.current = next;
    setPort(next);
  }, []);

  const beginMutation = useCallback((duringLocalSetup = false) => {
    if (!mountedRef.current || savingRef.current || (configurationBusyRef?.current && !duringLocalSetup)) return null;
    savingRef.current = true;
    setSaving(true);
    let resolveCompletion!: (success: boolean) => void;
    const pending = new Promise<boolean>((resolve) => { resolveCompletion = resolve; });
    pendingMutationRef.current = pending;
    return (success: boolean) => {
      resolveCompletion(success);
      if (pendingMutationRef.current === pending) {
        pendingMutationRef.current = null;
        savingRef.current = false;
        if (mountedRef.current) setSaving(false);
      }
    };
  }, [configurationBusyRef]);

  const save = useCallback(
    async (
      scope: McpSaveScope,
      enabled = settingsRef.current.mcpEnabled,
      httpEnabled = settingsRef.current.mcpHttpEnabled,
      httpPort = settingsRef.current.mcpHttpPort,
      duringLocalSetup = false,
    ) => {
      const finish = beginMutation(duringLocalSetup);
      if (!finish) return false;
      let succeeded = false;
      const requestedPort = portRef.current;
      if (scope === "stdio") setStdioError(null);
      else if (scope === "http" || scope === "httpPort") setHttpError(null);
      else {
        setPermissionError(null);
        setPermissionSaveSucceeded(false);
      }
      try {
        const next = await api.updateMcpSettings(
          enabled,
          httpEnabled,
          httpPort,
          scope === "permissions" ? permissions : savedPermissionsRef.current,
        );
        succeeded = true;
        if (!mountedRef.current) return false;
        applyBackendSettings(next);
        if (scope === "permissions") {
          savedPermissionsRef.current = next.mcpGroupPermissions;
          setSavedPermissions(next.mcpGroupPermissions);
          setPermissions(next.mcpGroupPermissions);
          setPermissionSaveSucceeded(true);
        } else if (scope === "httpPort" && portRef.current === requestedPort) {
          changePort(String(next.mcpHttpPort));
        }
        return true;
      } catch (nextError) {
        if (!mountedRef.current) return false;
        const message = resolveApiError(nextError, translate("settings.mcpSaveFailed"));
        if (scope === "stdio") setStdioError(message);
        else if (scope === "http" || scope === "httpPort") setHttpError(message);
        else setPermissionError(message);
        return false;
      } finally {
        finish(succeeded);
      }
    },
    [applyBackendSettings, beginMutation, changePort, permissions, translate],
  );

  const loadConfig = useCallback(
    async (transport: McpTransport, target: McpClientTarget) => {
      const requestId = configRequestRef.current.begin();
      setConfigDialog((current) =>
        current ? { ...current, config: "", error: null, loading: true, target } : null,
      );
      try {
        const config =
          transport === "http"
            ? await api.getMcpHttpClientConfig(target)
            : await api.getMcpStdioClientConfig(target);
        if (configRequestRef.current.isCurrent(requestId)) {
          setConfigDialog((current) =>
            current ? { ...current, config, loading: false } : null,
          );
        }
      } catch (nextError) {
        if (configRequestRef.current.isCurrent(requestId)) {
          setConfigDialog((current) =>
            current
              ? {
                  ...current,
                  error: resolveApiError(
                    nextError,
                    translate("settings.mcpConfigLoadFailed"),
                  ),
                  loading: false,
                }
              : null,
          );
        }
      }
    },
    [translate],
  );

  const openConfigDialog = useCallback(
    (transport: McpTransport) => {
      const target: McpClientTarget = "codex";
      setConfigDialog({ config: "", error: null, loading: true, target, transport });
      void loadConfig(transport, target);
    },
    [loadConfig],
  );

  const closeConfigDialog = useCallback(() => {
    configRequestRef.current.invalidate();
    setConfigDialog(null);
  }, []);

  const copyConfig = useCallback(async () => {
    if (!configDialog?.config) return;
    try {
      await writeText(configDialog.config);
      if (!mountedRef.current) return;
      closeConfigDialog();
    } catch (nextError) {
      if (!mountedRef.current) return;
      setConfigDialog((current) =>
        current
          ? {
              ...current,
              error: resolveApiError(nextError, translate("settings.mcpConfigCopyFailed")),
            }
          : null,
      );
    }
  }, [closeConfigDialog, configDialog, translate]);

  const rotateToken = useCallback(async () => {
    const finish = beginMutation();
    if (!finish) return;
    let succeeded = false;
    setHttpError(null);
    try {
      await api.rotateMcpHttpToken();
      succeeded = true;
    } catch (nextError) {
      if (mountedRef.current) {
        setHttpError(resolveApiError(nextError, translate("errors.unknown")));
      }
    } finally {
      finish(succeeded);
    }
  }, [beginMutation, translate]);

  const savePort = useCallback(async (duringLocalSetup = false) => {
    const parsedPort = validateMcpPort(portRef.current);
    if (parsedPort === null) {
      setHttpError(translate("settings.mcpInvalidPort"));
      return false;
    }
    const current = settingsRef.current;
    if (parsedPort === current.mcpHttpPort) {
      setHttpError(null);
      return true;
    }
    return save("httpPort", current.mcpEnabled, current.mcpHttpEnabled, parsedPort, duringLocalSetup);
  }, [save, translate]);

  const prepareLocalAgentSetup = useCallback(async (transport: McpTransport) => {
    // 点击按钮时输入框的 blur 保存可能仍在进行；必须等结果，不能使用旧端口。
    const pending = pendingMutationRef.current;
    if (pending && !(await pending)) throw new Error(translate("settings.localAgentSettingsSaveFailed"));
    if (!mountedRef.current) throw new Error(translate("settings.localAgentConfigureCancelled"));
    if (transport === "http" && !(await savePort(true))) {
      throw new Error(translate("settings.localAgentSettingsSaveFailed"));
    }
    return settingsRef.current;
  }, [savePort, translate]);

  return {
    applyBackendSettings,
    clearHttpError: () => setHttpError(null),
    closeConfigDialog,
    commandPolicyGroup,
    configDialog,
    copyAgentPrompt,
    copyConfig,
    copyingPrompt,
    getSavedPermissions: () => savedPermissionsRef.current,
    groups,
    httpError,
    loadConfig,
    openConfigDialog,
    permissionCatalog,
    permissionCatalogFailed,
    permissionError,
    permissionFor,
    permissions,
    permissionsDirty: permissionsChanged(groups, permissions, savedPermissions),
    permissionSaveSucceeded,
    permissionTooltip,
    port,
    prepareLocalAgentSetup,
    promptCopied,
    promptError,
    rotateToken,
    save,
    savePort,
    saving,
    setCommandPolicyGroup,
    setPermissionTooltip,
    setPort: changePort,
    showPermissionTooltip,
    stdioError,
    updatePermission,
  };
}
