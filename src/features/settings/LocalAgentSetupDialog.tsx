import { CheckCircle2, LoaderCircle, X, XCircle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type {
  LocalAgentCapability,
  LocalAgentConfigureResult,
  LocalAgentSetupState,
  LocalAgentStepStatus,
  LocalAgentTarget,
  McpTransport,
} from "../../shared/api/types";
import { Button } from "../../shared/ui/Button";

interface LocalAgentSetupDialogProps {
  capabilities: LocalAgentCapability[];
  configuring: boolean;
  error: string | null;
  httpPort?: number;
  loading: boolean;
  onClose: () => void;
  onConfigure: (targets: LocalAgentTarget[]) => void;
  open: boolean;
  results: LocalAgentConfigureResult[];
  transport?: McpTransport;
}

const targetLabels: Record<LocalAgentTarget, string> = {
  codex: "Codex",
  claude: "Claude Code",
  cursor: "Cursor",
  vsCode: "VS Code / GitHub Copilot",
  geminiCli: "Gemini CLI",
  openCode: "OpenCode",
  trae: "Trae",
  traeCn: "Trae CN",
};

const stateKeys: Record<LocalAgentSetupState, string> = {
  notDetected: "settings.localAgentNotDetected",
  missing: "settings.localAgentMissing",
  current: "settings.localAgentCurrent",
  outdated: "settings.localAgentOutdated",
  invalid: "settings.localAgentInvalid",
};

const resultKeys: Record<LocalAgentStepStatus, string> = {
  configured: "settings.localAgentConfigured",
  current: "settings.localAgentCurrent",
  manualRequired: "settings.localAgentManualRequired",
  failed: "settings.localAgentFailed",
};

function overallResultStatus(result: LocalAgentConfigureResult): LocalAgentStepStatus {
  if (result.mcpStatus === "failed" || result.promptStatus === "failed") {
    return "failed";
  }
  if (result.promptStatus === "manualRequired") {
    return "manualRequired";
  }
  if (result.mcpStatus === "configured" || result.promptStatus === "configured") {
    return "configured";
  }
  return "current";
}

export function LocalAgentSetupDialog({
  capabilities,
  configuring,
  error,
  httpPort = 37653,
  loading,
  onClose,
  onConfigure,
  open,
  results,
  transport = "stdio",
}: LocalAgentSetupDialogProps) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<Set<LocalAgentTarget>>(new Set());

  useEffect(() => {
    if (open && !loading) {
      setSelected(new Set(capabilities.filter((item) => item.installed).map((item) => item.target)));
    }
  }, [capabilities, loading, open]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !configuring) {
        onClose();
      }
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [configuring, onClose, open]);

  const resultByTarget = useMemo(
    () => new Map(results.map((result) => [result.target, result])),
    [results],
  );
  const selectedTargets = capabilities
    .filter((item) => item.installed && selected.has(item.target))
    .map((item) => item.target);

  return open
    ? createPortal(
        <div
          className="dialog-backdrop settings-local-agent-backdrop"
          onMouseDown={(event) => {
            if (event.currentTarget === event.target && !configuring) {
              onClose();
            }
          }}
        >
          <section
            aria-labelledby="local-agent-dialog-title"
            aria-modal="true"
            className="dialog settings-local-agent-dialog"
            role="dialog"
          >
            <header className="dialog-header">
              <div>
                <h2 id="local-agent-dialog-title">{t(transport === "http" ? "settings.localAgentHttpTitle" : "settings.localAgentTitle")}</h2>
                <small>{t(transport === "http" ? "settings.localAgentHttpHint" : "settings.localAgentHint")}</small>
              </div>
              <button
                aria-label={t("sessions.close")}
                className="icon-button"
                disabled={configuring}
                onClick={onClose}
                type="button"
              >
                <X aria-hidden="true" size={18} />
              </button>
            </header>

            <div className="settings-local-agent-body">
              {transport === "http" ? (
                <div className="settings-row-copy" role="note">
                  <small>{t("settings.localAgentHttpAddress", { url: `http://127.0.0.1:${httpPort}/mcp` })}</small>
                  <small>{t("settings.localAgentHttpSecretHint")}</small>
                  <small>{t("settings.localAgentHttpRuntimeHint")}</small>
                  <small className="settings-mcp-risk-hint">{t("settings.localAgentHttpNetworkHint")}</small>
                </div>
              ) : null}
              {loading ? (
                <div className="settings-local-agent-loading">
                  <LoaderCircle aria-hidden="true" className="spin" size={18} />
                  {t("settings.localAgentDetecting")}
                </div>
              ) : (
                <div className="settings-local-agent-list">
                  {capabilities.map((capability) => {
                    const result = resultByTarget.get(capability.target);
                    const resultStatus = result ? overallResultStatus(result) : null;
                    return (
                      <label
                        className={`settings-local-agent-item${
                          capability.installed ? "" : " disabled"
                        }`}
                        key={capability.target}
                      >
                        <input
                          checked={selected.has(capability.target)}
                          disabled={!capability.installed || configuring}
                          onChange={(event) => {
                            setSelected((current) => {
                              const next = new Set(current);
                              if (event.target.checked) {
                                next.add(capability.target);
                              } else {
                                next.delete(capability.target);
                              }
                              return next;
                            });
                          }}
                          type="checkbox"
                        />
                        <span className="settings-local-agent-copy">
                          <strong>{targetLabels[capability.target]}</strong>
                          <small>{capability.detail ?? t(stateKeys[capability.state])}</small>
                          {result?.message ? (
                            <small className="settings-local-agent-message">{result.message}</small>
                          ) : null}
                        </span>
                        {resultStatus ? (
                          <span
                            className={`settings-local-agent-result ${
                              resultStatus === "failed" ? "failed" : "succeeded"
                            }`}
                          >
                            {resultStatus === "failed" ? (
                              <XCircle aria-hidden="true" size={15} />
                            ) : (
                              <CheckCircle2 aria-hidden="true" size={15} />
                            )}
                            {t(resultKeys[resultStatus])}
                          </span>
                        ) : null}
                      </label>
                    );
                  })}
                </div>
              )}
              {error ? (
                <div className="form-error settings-local-agent-error" role="alert">
                  {error}
                </div>
              ) : null}
              {transport === "http" && results.some((result) => result.mcpStatus !== "failed") ? (
                <small className="settings-local-agent-message" role="status">{t("settings.localAgentHttpCompletedHint")}</small>
              ) : null}
            </div>

            <footer className="dialog-actions">
              <Button disabled={configuring} onClick={onClose} variant="ghost">
                {t("sessions.close")}
              </Button>
              <Button
                disabled={loading || configuring || selectedTargets.length === 0}
                icon={
                  configuring ? (
                    <LoaderCircle aria-hidden="true" className="spin" size={16} />
                  ) : undefined
                }
                onClick={() => onConfigure(selectedTargets)}
              >
                {t(configuring ? "settings.localAgentConfiguring" : "settings.localAgentConfigure")}
              </Button>
            </footer>
          </section>
        </div>,
        document.body,
      )
    : null;
}
