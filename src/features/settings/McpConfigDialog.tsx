import { Copy, X } from "lucide-react";
import { useEffect } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { McpClientTarget } from "../../shared/api/types";
import { Button } from "../../shared/ui/Button";
import { Select } from "../../shared/ui/Select";

export type McpTransport = "http" | "stdio";

export interface McpConfigDialogState {
  config: string;
  error: string | null;
  loading: boolean;
  target: McpClientTarget;
  transport: McpTransport;
}

interface McpConfigDialogProps {
  dialog: McpConfigDialogState | null;
  onClose: () => void;
  onCopy: () => void;
  onTargetChange: (transport: McpTransport, target: McpClientTarget) => void;
  options: ReadonlyArray<{ value: McpClientTarget; label: string }>;
}

export function McpConfigDialog({
  dialog,
  onClose,
  onCopy,
  onTargetChange,
  options,
}: McpConfigDialogProps) {
  const { t } = useTranslation();

  useEffect(() => {
    if (!dialog) {
      return;
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [dialog, onClose]);

  return dialog
    ? createPortal(
        <div
          className="dialog-backdrop settings-mcp-config-backdrop"
          onMouseDown={(event) => {
            if (event.currentTarget === event.target) {
              onClose();
            }
          }}
        >
          <section
            aria-labelledby="mcp-config-dialog-title"
            aria-modal="true"
            className="dialog settings-mcp-config-dialog"
            role="dialog"
          >
            <header className="dialog-header">
              <h2 id="mcp-config-dialog-title">
                {t("settings.mcpConfigDialogTitle", { transport: dialog.transport })}
              </h2>
              <button
                aria-label={t("sessions.close")}
                className="icon-button"
                onClick={onClose}
                type="button"
              >
                <X aria-hidden="true" size={18} />
              </button>
            </header>
            <div className="settings-mcp-config-body">
              <label className="settings-mcp-config-field">
                <span>{t("settings.mcpClient")}</span>
                <Select<McpClientTarget>
                  ariaLabel={t("settings.mcpClient")}
                  onChange={(target) => onTargetChange(dialog.transport, target)}
                  options={options}
                  value={dialog.target}
                />
              </label>
              <div className="settings-mcp-config-field">
                <span>{t("settings.mcpConfigPreview")}</span>
                <pre className="settings-mcp-config-preview" tabIndex={0}>
                  {dialog.loading ? t("settings.mcpConfigLoading") : dialog.config}
                </pre>
              </div>
              {dialog.target === "dsh" ? (
                <small className="settings-mcp-config-target-hint">
                  {t("settings.mcpDshConfigHint")}
                </small>
              ) : null}
              {dialog.transport === "http" ? (
                <small className="settings-mcp-config-secret-hint">
                  {t("settings.mcpConfigSecretHint")}
                </small>
              ) : null}
              {dialog.error ? (
                <div className="form-error" role="alert">
                  {dialog.error}
                </div>
              ) : null}
            </div>
            <footer className="dialog-actions">
              <Button onClick={onClose} variant="ghost">
                {t("sessions.close")}
              </Button>
              <Button
                disabled={dialog.loading || !dialog.config}
                icon={<Copy aria-hidden="true" size={16} />}
                onClick={onCopy}
              >
                {t("settings.mcpCopyConfig")}
              </Button>
            </footer>
          </section>
        </div>,
        document.body,
      )
    : null;
}
