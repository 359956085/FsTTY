import { Download, Plus, Trash2, Upload, X } from "lucide-react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { api } from "../../shared/api/client";
import { resolveApiError } from "../../shared/api/errors";
import type {
  McpCommandMatchType,
  McpCommandPolicy,
  McpGroupPermission,
} from "../../shared/api/types";
import { Button } from "../../shared/ui/Button";
import { Select } from "../../shared/ui/Select";
import {
  normalizeMcpCommandPolicy,
  validateMcpCommandPolicy,
} from "./mcpPermissions";

interface McpCommandPolicyDialogProps {
  groupName: string | null;
  onClose: () => void;
  onConfirm: (policy: McpCommandPolicy) => void;
  permission: McpGroupPermission | null;
}

export function McpCommandPolicyDialog({
  groupName,
  onClose,
  onConfirm,
  permission,
}: McpCommandPolicyDialogProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<McpCommandPolicy | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(permission ? clonePolicy(permission.commandPolicy) : null);
    setError(null);
    setBusy(false);
  }, [groupName, permission]);

  useEffect(() => {
    if (!groupName) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented && !busy) onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [busy, groupName, onClose]);

  if (!groupName || !permission || !draft) return null;
  const currentDraft = draft;
  const active = permission.enabled && permission.commandExecute && draft.enabled;
  const modeOptions = [
    { value: "allow", label: t("settings.mcpCommandPolicyAllow") },
    { value: "exclude", label: t("settings.mcpCommandPolicyExclude") },
  ] as const;
  const matchTypeOptions = [
    { value: "exact", label: t("settings.mcpCommandPolicyExact") },
    { value: "glob", label: t("settings.mcpCommandPolicyGlob") },
  ] as const;
  const displayedRules = draft.rules
    .map((rule, ruleIndex) => ({ rule, ruleIndex }))
    .reverse();

  function updateRule(index: number, patch: { matchType?: McpCommandMatchType; pattern?: string }) {
    setError(null);
    setDraft((current) =>
      current
        ? {
            ...current,
            rules: current.rules.map((rule, ruleIndex) =>
              ruleIndex === index ? { ...rule, ...patch } : rule,
            ),
          }
        : current,
    );
  }

  async function importPolicy() {
    if (busy) return;
    try {
      const path = await open({
        directory: false,
        multiple: false,
        filters: [{ name: "JSON", extensions: ["json"] }],
        title: t("settings.mcpCommandPolicyImport"),
      });
      if (!path) return;
      setBusy(true);
      setError(null);
      setDraft(await api.importMcpCommandPolicy(path));
    } catch (nextError) {
      setError(resolveApiError(nextError, t("settings.mcpCommandPolicyImportFailed")));
    } finally {
      setBusy(false);
    }
  }

  async function exportPolicy() {
    if (busy) return;
    try {
      const path = await save({
        defaultPath: defaultExportName(),
        filters: [{ name: "JSON", extensions: ["json"] }],
        title: t("settings.mcpCommandPolicyExport"),
      });
      if (!path) return;
      setBusy(true);
      setError(null);
      await api.exportMcpCommandPolicy(path, currentDraft);
    } catch (nextError) {
      setError(resolveApiError(nextError, t("settings.mcpCommandPolicyExportFailed")));
    } finally {
      setBusy(false);
    }
  }

  function confirmDraft() {
    const validation = validateMcpCommandPolicy(currentDraft);
    if (validation) {
      setError(t(`settings.mcpCommandPolicyValidation.${validation}`));
      return;
    }
    onConfirm(normalizeMcpCommandPolicy(currentDraft));
  }

  return createPortal(
    <div
      className="dialog-backdrop settings-mcp-command-policy-backdrop"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target && !busy) onClose();
      }}
    >
      <section
        aria-labelledby="mcp-command-policy-title"
        aria-modal="true"
        className="dialog settings-mcp-command-policy-dialog"
        role="dialog"
      >
        <header className="dialog-header">
          <div>
            <h2 id="mcp-command-policy-title">{t("settings.mcpCommandPolicyTitle")}</h2>
            <small>{t("settings.mcpCommandPolicyGroup", { group: groupName })}</small>
          </div>
          <button
            aria-label={t("sessions.close")}
            className="icon-button"
            disabled={busy}
            onClick={onClose}
            type="button"
          >
            <X aria-hidden="true" size={18} />
          </button>
        </header>

        <div className="settings-mcp-command-policy-body">
          <div className="settings-row settings-mcp-command-policy-switch-row">
            <div className="settings-row-copy">
              <label className="settings-row-label" htmlFor="mcp-command-policy-enabled">
                {t("settings.mcpCommandPolicyEnable")}
              </label>
              <small className={active ? undefined : "settings-mcp-risk-hint"}>
                {t(active ? "settings.mcpCommandPolicyActive" : "settings.mcpCommandPolicyInactive")}
              </small>
            </div>
            <input
              checked={draft.enabled}
              className="settings-auto-update-toggle"
              disabled={busy}
              id="mcp-command-policy-enabled"
              onChange={(event) => {
                setError(null);
                setDraft({ ...draft, enabled: event.target.checked });
              }}
              role="switch"
              type="checkbox"
            />
          </div>

          <div className="settings-mcp-command-policy-toolbar">
            <div className="settings-mcp-command-policy-mode">
              <span>{t("settings.mcpCommandPolicyMode")}</span>
              <Select<McpCommandPolicy["mode"]>
                ariaLabel={t("settings.mcpCommandPolicyMode")}
                className="settings-mcp-command-policy-mode-select"
                disabled={busy}
                onChange={(mode) => {
                  setError(null);
                  setDraft({ ...draft, mode });
                }}
                options={modeOptions}
                value={draft.mode}
              />
            </div>
            <div className="settings-mcp-command-policy-actions">
              <Button
                disabled={busy}
                icon={<Upload aria-hidden="true" size={15} />}
                onClick={() => void importPolicy()}
                variant="ghost"
              >
                {t("settings.mcpCommandPolicyImport")}
              </Button>
              <Button
                disabled={busy}
                icon={<Download aria-hidden="true" size={15} />}
                onClick={() => void exportPolicy()}
                variant="ghost"
              >
                {t("settings.mcpCommandPolicyExport")}
              </Button>
              <Button
                disabled={busy || draft.rules.length >= 100}
                icon={<Plus aria-hidden="true" size={15} />}
                onClick={() => {
                  setError(null);
                  setDraft({
                    ...draft,
                    rules: [...draft.rules, { matchType: "exact", pattern: "" }],
                  });
                }}
              >
                {t("settings.mcpCommandPolicyAdd")}
              </Button>
            </div>
          </div>

          <div className="settings-mcp-command-policy-warning">
            {t("settings.mcpCommandPolicyGlobWarning")}
          </div>

          <div className="settings-mcp-command-policy-rules">
            {draft.rules.length === 0 ? (
              <div className="settings-mcp-command-policy-empty">
                {t(
                  draft.mode === "allow"
                    ? "settings.mcpCommandPolicyAllowEmpty"
                    : "settings.mcpCommandPolicyExcludeEmpty",
                )}
              </div>
            ) : (
              displayedRules.map(({ rule, ruleIndex }, displayIndex) => (
                <div className="settings-mcp-command-policy-rule" key={ruleIndex}>
                  <Select<McpCommandMatchType>
                    ariaLabel={t("settings.mcpCommandPolicyMatchType", {
                      index: displayIndex + 1,
                    })}
                    className="settings-mcp-command-policy-match-select"
                    disabled={busy}
                    onChange={(matchType) => updateRule(ruleIndex, { matchType })}
                    options={matchTypeOptions}
                    value={rule.matchType}
                  />
                  <input
                    aria-label={t("settings.mcpCommandPolicyPattern", {
                      index: displayIndex + 1,
                    })}
                    disabled={busy}
                    maxLength={4096}
                    onChange={(event) =>
                      updateRule(ruleIndex, { pattern: event.target.value })
                    }
                    placeholder={t(
                      rule.matchType === "exact"
                        ? "settings.mcpCommandPolicyPatternPlaceholderExact"
                        : "settings.mcpCommandPolicyPatternPlaceholderGlob",
                    )}
                    type="text"
                    value={rule.pattern}
                  />
                  <button
                    aria-label={t("settings.mcpCommandPolicyDeleteRule", {
                      index: displayIndex + 1,
                    })}
                    className="icon-button settings-mcp-command-policy-delete"
                    disabled={busy}
                    onClick={() => {
                      setError(null);
                      setDraft({
                        ...draft,
                        rules: draft.rules.filter(
                          (_, currentRuleIndex) => currentRuleIndex !== ruleIndex,
                        ),
                      });
                    }}
                    type="button"
                  >
                    <Trash2 aria-hidden="true" size={16} />
                  </button>
                </div>
              ))
            )}
          </div>
          {error ? (
            <div className="form-error" role="alert">
              {error}
            </div>
          ) : null}
        </div>

        <footer className="dialog-actions">
          <Button disabled={busy} onClick={onClose} variant="ghost">
            {t("sessions.cancel")}
          </Button>
          <Button disabled={busy} onClick={confirmDraft}>
            {t("settings.mcpCommandPolicyComplete")}
          </Button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}

function clonePolicy(policy: McpCommandPolicy): McpCommandPolicy {
  return { ...policy, rules: policy.rules.map((rule) => ({ ...rule })) };
}

function defaultExportName() {
  const now = new Date();
  const part = (value: number) => String(value).padStart(2, "0");
  return `fstty-mcp-command-policy-${now.getFullYear()}${part(now.getMonth() + 1)}${part(now.getDate())}-${part(now.getHours())}${part(now.getMinutes())}${part(now.getSeconds())}.json`;
}
