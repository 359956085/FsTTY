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
  onChange: (settings: AppSettings) => void;
  settings: AppSettings;
  translate: (key: string) => string;
}

export function useMcpSettings({ onChange, settings, translate }: UseMcpSettingsOptions) {
  const [groups, setGroups] = useState<SessionGroup[]>([]);
  const [permissionCatalog, setPermissionCatalog] = useState<McpPermissionCatalogEntry[]>([]);
  const [permissionCatalogFailed, setPermissionCatalogFailed] = useState(false);
  const [permissions, setPermissions] = useState(settings.mcpGroupPermissions);
  const [savedPermissions, setSavedPermissions] = useState(settings.mcpGroupPermissions);
  const savedPermissionsRef = useRef(settings.mcpGroupPermissions);
  const [port, setPort] = useState(String(settings.mcpHttpPort));
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
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
  useEffect(() => setPort(String(settings.mcpHttpPort)), [settings.mcpHttpPort]);
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

  const save = useCallback(
    async (
      scope: McpSaveScope,
      enabled = settings.mcpEnabled,
      httpEnabled = settings.mcpHttpEnabled,
      httpPort = settings.mcpHttpPort,
    ) => {
      if (savingRef.current) {
        return;
      }
      savingRef.current = true;
      setSaving(true);
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
        if (!mountedRef.current) return;
        onChange(next);
        if (scope === "permissions") {
          savedPermissionsRef.current = next.mcpGroupPermissions;
          setSavedPermissions(next.mcpGroupPermissions);
          setPermissions(next.mcpGroupPermissions);
          setPermissionSaveSucceeded(true);
        } else if (scope === "httpPort") {
          setPort(String(next.mcpHttpPort));
        }
      } catch (nextError) {
        if (!mountedRef.current) return;
        const message = resolveApiError(nextError, translate("settings.mcpSaveFailed"));
        if (scope === "stdio") setStdioError(message);
        else if (scope === "http" || scope === "httpPort") setHttpError(message);
        else setPermissionError(message);
      } finally {
        savingRef.current = false;
        if (mountedRef.current) setSaving(false);
      }
    },
    [onChange, permissions, settings, translate],
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
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setHttpError(null);
    try {
      await api.rotateMcpHttpToken();
    } catch (nextError) {
      if (mountedRef.current) {
        setHttpError(resolveApiError(nextError, translate("errors.unknown")));
      }
    } finally {
      savingRef.current = false;
      if (mountedRef.current) setSaving(false);
    }
  }, [translate]);

  const savePort = useCallback(async () => {
    const parsedPort = validateMcpPort(port);
    if (parsedPort === null) {
      setHttpError(translate("settings.mcpInvalidPort"));
      return;
    }
    if (parsedPort === settings.mcpHttpPort) {
      setHttpError(null);
      return;
    }
    await save("httpPort", settings.mcpEnabled, settings.mcpHttpEnabled, parsedPort);
  }, [port, save, settings, translate]);

  return {
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
    promptCopied,
    promptError,
    rotateToken,
    save,
    savePort,
    saving,
    setCommandPolicyGroup,
    setPermissionTooltip,
    setPort,
    showPermissionTooltip,
    stdioError,
    updatePermission,
  };
}
