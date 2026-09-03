import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../shared/api/client";
import { resolveApiError } from "../../shared/api/errors";
import type {
  AppSettings,
  LocalAgentCapability,
  LocalAgentConfigureResult,
  LocalAgentTarget,
  McpGroupPermission,
  McpTransport,
} from "../../shared/api/types";
import { createLatestRequestGuard } from "../../shared/async/latestRequest";

const manualPromptCopiedKeys: Partial<Record<LocalAgentTarget, string>> = {
  cursor: "settings.localAgentCursorPromptCopied",
  trae: "settings.localAgentTraePromptCopied",
  traeCn: "settings.localAgentTraeCnPromptCopied",
};

const manualPromptCopyFailedKeys: Partial<Record<LocalAgentTarget, string>> = {
  cursor: "settings.localAgentCursorPromptCopyFailed",
  trae: "settings.localAgentTraePromptCopyFailed",
  traeCn: "settings.localAgentTraeCnPromptCopyFailed",
};

interface UseLocalAgentSetupOptions {
  configurationBusyRef: { current: boolean };
  getSavedPermissions: () => McpGroupPermission[];
  onChange: (settings: AppSettings) => void;
  prepareConfiguration: (transport: McpTransport) => Promise<AppSettings>;
  translate: (key: string) => string;
}

export function useLocalAgentSetup({
  configurationBusyRef,
  getSavedPermissions,
  onChange,
  prepareConfiguration,
  translate,
}: UseLocalAgentSetupOptions) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [transport, setTransport] = useState<McpTransport>("stdio");
  const transportRef = useRef<McpTransport>("stdio");
  const [capabilities, setCapabilities] = useState<LocalAgentCapability[]>([]);
  const [results, setResults] = useState<LocalAgentConfigureResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [configuring, setConfiguring] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inspectRequestRef = useRef(createLatestRequestGuard());
  const configureRequestRef = useRef(createLatestRequestGuard());
  const configuringRef = useRef(false);
  const mountedRef = useRef(false);

  const cancel = useCallback(() => {
    if (!mountedRef.current || configuringRef.current) return;
    inspectRequestRef.current.invalidate();
    configureRequestRef.current.invalidate();
    configuringRef.current = false;
    setDialogOpen(false);
    setLoading(false);
    setConfiguring(false);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    const inspections = inspectRequestRef.current;
    const configurations = configureRequestRef.current;
    return () => {
      mountedRef.current = false;
      inspections.invalidate();
      configurations.invalidate();
      configuringRef.current = false;
      configurationBusyRef.current = false;
    };
  }, [configurationBusyRef]);

  const open = useCallback(async (nextTransport: McpTransport = "stdio") => {
    if (!mountedRef.current || configuringRef.current) return;
    const requestId = inspectRequestRef.current.begin();
    transportRef.current = nextTransport;
    setTransport(nextTransport);
    setDialogOpen(true);
    setLoading(true);
    setCapabilities([]);
    setResults([]);
    setError(null);
    try {
      const nextCapabilities = nextTransport === "http"
        ? await api.inspectLocalAgentSetup("http")
        : await api.inspectLocalAgentSetup();
      if (inspectRequestRef.current.isCurrent(requestId)) {
        setCapabilities(nextCapabilities);
      }
    } catch (nextError) {
      if (inspectRequestRef.current.isCurrent(requestId)) {
        setCapabilities([]);
        setError(resolveApiError(nextError, translate("settings.localAgentDetectFailed")));
      }
    } finally {
      if (inspectRequestRef.current.isCurrent(requestId)) {
        setLoading(false);
      }
    }
  }, [translate]);

  const configure = useCallback(
    async (targets: LocalAgentTarget[]) => {
      if (!mountedRef.current || configuringRef.current || configurationBusyRef.current || loading || !dialogOpen || targets.length === 0) {
        return;
      }
      const requestId = configureRequestRef.current.begin();
      configuringRef.current = true;
      configurationBusyRef.current = true;
      const selectedTransport = transportRef.current;
      setConfiguring(true);
      setError(null);
      setResults([]);
      try {
        const currentSettings = await prepareConfiguration(selectedTransport);
        if (!configureRequestRef.current.isCurrent(requestId)) return;
        if (selectedTransport === "stdio" && !currentSettings.mcpEnabled) {
          const nextSettings = await api.updateMcpSettings(
            true,
            currentSettings.mcpHttpEnabled,
            currentSettings.mcpHttpPort,
            getSavedPermissions(),
          );
          if (!configureRequestRef.current.isCurrent(requestId)) {
            return;
          }
          onChange(nextSettings);
        }
        let nextResults: LocalAgentConfigureResult[];
        try {
          nextResults = selectedTransport === "http"
            ? await api.configureLocalAgents(targets, "http")
            : await api.configureLocalAgents(targets);
        } finally {
          // 后端可能已启用 HTTP，再遇到单个配置文件失败；回读真实开关，不猜测回滚状态。
          if (selectedTransport === "http" && configureRequestRef.current.isCurrent(requestId)) {
            try {
              const actual = await api.getAppSettings();
              if (configureRequestRef.current.isCurrent(requestId)) onChange(actual);
            } catch (nextError) {
              if (configureRequestRef.current.isCurrent(requestId)) {
                setError(resolveApiError(nextError, translate("settings.localAgentSettingsRefreshFailed")));
              }
            }
          }
        }
        if (!configureRequestRef.current.isCurrent(requestId)) {
          return;
        }
        const manualTargets = new Set(
          nextResults
            .filter(
              (result) =>
                result.mcpStatus !== "failed" &&
                result.promptStatus === "manualRequired" &&
                manualPromptCopiedKeys[result.target],
            )
            .map((result) => result.target),
        );
        if (manualTargets.size > 0) {
          try {
            const prompt = await api.getMcpAgentPrompt();
            if (!configureRequestRef.current.isCurrent(requestId)) return;
            await writeText(prompt);
            nextResults = nextResults.map((result) => {
              const messageKey = manualPromptCopiedKeys[result.target];
              return manualTargets.has(result.target) && messageKey
                ? { ...result, message: translate(messageKey) }
                : result;
            });
          } catch (nextError) {
            nextResults = nextResults.map((result) => {
              const messageKey = manualPromptCopyFailedKeys[result.target];
              return manualTargets.has(result.target) && messageKey
                ? {
                    ...result,
                    message: resolveApiError(nextError, translate(messageKey)),
                    promptStatus: "failed" as const,
                  }
                : result;
            });
          }
        }
        if (configureRequestRef.current.isCurrent(requestId)) {
          setResults(nextResults);
        }
      } catch (nextError) {
        if (configureRequestRef.current.isCurrent(requestId)) {
          setError(
            resolveApiError(nextError, translate("settings.localAgentConfigureFailed")),
          );
        }
      } finally {
        if (configureRequestRef.current.isCurrent(requestId)) {
          configuringRef.current = false;
          configurationBusyRef.current = false;
          setConfiguring(false);
        }
      }
    },
    [configurationBusyRef, dialogOpen, getSavedPermissions, loading, onChange, prepareConfiguration, translate],
  );

  return {
    capabilities,
    cancel,
    configure,
    configuring,
    dialogOpen,
    error,
    loading,
    open,
    results,
    transport,
  };
}
