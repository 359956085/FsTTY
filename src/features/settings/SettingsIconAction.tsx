import type { ReactNode } from "react";
import { MCP_PERMISSION_TOOLTIP_ID } from "./McpPermissionTooltip";

interface SettingsIconActionProps {
  activeTooltipKey: string | null;
  children: ReactNode;
  disabled?: boolean;
  label: string;
  onActivate: (element: HTMLButtonElement) => void;
  onHideTooltip: () => void;
  onShowTooltip: (key: string, text: string, element: HTMLElement) => void;
  tooltipKey: string;
}

export function SettingsIconAction({
  activeTooltipKey,
  children,
  disabled = false,
  label,
  onActivate,
  onHideTooltip,
  onShowTooltip,
  tooltipKey,
}: SettingsIconActionProps) {
  return (
    <button
      aria-describedby={
        activeTooltipKey === tooltipKey ? MCP_PERMISSION_TOOLTIP_ID : undefined
      }
      aria-label={label}
      className="icon-button settings-icon-action"
      disabled={disabled}
      onBlur={onHideTooltip}
      onClick={(event) => onActivate(event.currentTarget)}
      onFocus={(event) => onShowTooltip(tooltipKey, label, event.currentTarget)}
      onMouseEnter={(event) => onShowTooltip(tooltipKey, label, event.currentTarget)}
      onMouseLeave={(event) => {
        if (document.activeElement !== event.currentTarget) {
          onHideTooltip();
        }
      }}
      type="button"
    >
      {children}
    </button>
  );
}
