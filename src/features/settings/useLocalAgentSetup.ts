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
  getSavedPermissions: () => McpGroupPermission[];
  onChange: (settings: AppSettings) => void;
  settings: AppSettings;
  translate: (key: string) => string;
}

export function useLocalAgentSetup({
  getSavedPermissions,
  onChange,
  settings,
  translate,
}: UseLocalAgentSetupOptions) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [capabilities, setCapabilities] = useState<LocalAgentCapability[]>([]);
  const [results, setResults] = useState<LocalAgentConfigureResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [configuring, setConfiguring] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inspectRequestRef = useRef(createLatestRequestGuard());
  const configureRequestRef = useRef(createLatestRequestGuard());
  const configuringRef = useRef(false);

  const cancel = useCallback(() => {
    inspectRequestRef.current.invalidate();
    configureRequestRef.current.invalidate();
    configuringRef.current = false;
    setDialogOpen(false);
    setLoading(false);
    setConfiguring(false);
  }, []);

  useEffect(
    () => () => {
      inspectRequestRef.current.invalidate();
      configureRequestRef.current.invalidate();
      configuringRef.current = false;
    },
    [],
  );

  const open = useCallback(async () => {
    const requestId = inspectRequestRef.current.begin();
    setDialogOpen(true);
    setLoading(true);
    setResults([]);
    setError(null);
    try {
      const nextCapabilities = await api.inspectLocalAgentSetup();
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
      if (configuringRef.current || targets.length === 0) {
        return;
      }
      const requestId = configureRequestRef.current.begin();
      configuringRef.current = true;
      setConfiguring(true);
      setError(null);
      setResults([]);
      try {
        if (!settings.mcpEnabled) {
          const nextSettings = await api.updateMcpSettings(
            true,
            settings.mcpHttpEnabled,
            settings.mcpHttpPort,
            getSavedPermissions(),
          );
          if (!configureRequestRef.current.isCurrent(requestId)) {
            return;
          }
          onChange(nextSettings);
        }
        let nextResults = await api.configureLocalAgents(targets);
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
            await writeText(await api.getMcpAgentPrompt());
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
          setConfiguring(false);
        }
      }
    },
    [getSavedPermissions, onChange, settings, translate],
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
  };
}
