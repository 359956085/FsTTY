import { Info } from "lucide-react";
import { useTranslation } from "react-i18next";
import type {
  McpGroupPermission,
  McpPermissionCatalogEntry,
  SessionGroup,
} from "../../shared/api/types";
import { Button } from "../../shared/ui/Button";
import {
  MCP_PERMISSION_FIELDS,
  MCP_PERMISSION_LABEL_KEYS,
  permissionFrom,
} from "./mcpPermissions";
import { MCP_PERMISSION_TOOLTIP_ID } from "./McpPermissionTooltip";

interface McpPermissionsPanelProps {
  catalog: readonly McpPermissionCatalogEntry[];
  catalogFailed: boolean;
  dirty: boolean;
  error: string | null;
  groups: readonly SessionGroup[];
  onHideTooltip: () => void;
  onSave: () => void;
  onShowTooltip: (key: string, text: string, element: HTMLElement) => void;
  onUpdate: (groupName: string, patch: Partial<McpGroupPermission>) => void;
  permissions: readonly McpGroupPermission[];
  saving: boolean;
  saveSucceeded: boolean;
  tooltipKey: string | null;
}

export function McpPermissionsPanel({
  catalog,
  catalogFailed,
  dirty,
  error,
  groups,
  onHideTooltip,
  onSave,
  onShowTooltip,
  onUpdate,
  permissions,
  saving,
  saveSucceeded,
  tooltipKey,
}: McpPermissionsPanelProps) {
  const { t } = useTranslation();

  return (
    <section
      aria-labelledby="mcp-permissions-title"
      className="settings-panel settings-mcp-panel"
    >
      <header className="settings-panel-header settings-mcp-permissions-header">
        <h3 id="mcp-permissions-title">{t("settings.mcpPermissions")}</h3>
        <Button disabled={saving || !dirty} onClick={onSave}>
          {t("settings.mcpSave")}
        </Button>
      </header>
      <div className="settings-mcp-warning">{t("settings.mcpCommandWarning")}</div>
      <div className="settings-mcp-grid">
        <span>{t("settings.mcpGroup")}</span>
        {MCP_PERMISSION_FIELDS.map((permissionKey) => {
          const labelKey = MCP_PERMISSION_LABEL_KEYS[permissionKey];
          const tools =
            catalog.find((entry) => entry.permissionKey === permissionKey)?.tools ?? [];
          const label = t(labelKey);
          const tooltip = catalogFailed
            ? t("settings.mcpPermissionCatalogLoadFailed")
            : permissionKey === "enabled"
              ? t("settings.mcpAccessToolsHint")
              : t("settings.mcpPermissionTools", { tools: tools.join("\n") });

          return (
            <span className="settings-mcp-permission-header" key={labelKey}>
              {label}
              <span
                aria-describedby={tooltipKey === labelKey ? MCP_PERMISSION_TOOLTIP_ID : undefined}
                aria-label={`${label}: ${tooltip.split("\n").join(", ")}`}
                className="settings-mcp-permission-info"
                onBlur={onHideTooltip}
                onFocus={(event) =>
                  onShowTooltip(labelKey, tooltip, event.currentTarget)
                }
                onMouseEnter={(event) =>
                  onShowTooltip(labelKey, tooltip, event.currentTarget)
                }
                onMouseLeave={(event) => {
                  if (document.activeElement !== event.currentTarget) {
                    onHideTooltip();
                  }
                }}
                role="img"
                tabIndex={0}
              >
                <Info aria-hidden="true" size={13} />
              </span>
            </span>
          );
        })}
        {groups.flatMap((group) => {
          const permission = permissionFrom(permissions, group.name);
          return [
            <strong key={`${group.name}-name`}>{group.name}</strong>,
            ...MCP_PERMISSION_FIELDS.map((field) => (
              <input
                aria-label={`${group.name} ${String(field)}`}
                checked={Boolean(permission[field])}
                disabled={saving}
                key={`${group.name}-${String(field)}`}
                onChange={(event) =>
                  onUpdate(group.name, { [field]: event.target.checked })
                }
                type="checkbox"
              />
            )),
          ];
        })}
      </div>
      <div className="settings-mcp-permission-feedback" aria-live="polite">
        {error ? (
          <div className="form-error settings-mcp-feedback" role="alert">
            {error}
          </div>
        ) : saveSucceeded ? (
          <div className="form-success settings-mcp-feedback" role="status">
            {t("settings.mcpSaved")}
          </div>
        ) : null}
      </div>
    </section>
  );
}
