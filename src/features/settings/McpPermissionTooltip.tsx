import { useEffect, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";

export const MCP_PERMISSION_TOOLTIP_ID = "mcp-permission-tooltip";

export interface McpPermissionTooltipState {
  key: string;
  text: string;
  anchor: {
    bottom: number;
    left: number;
    top: number;
    width: number;
  };
}

interface McpPermissionTooltipProps {
  onClose: () => void;
  tooltip: McpPermissionTooltipState | null;
}

const TOOLTIP_GAP = 6;
const TOOLTIP_MARGIN = 8;

export function McpPermissionTooltip({
  onClose,
  tooltip,
}: McpPermissionTooltipProps) {
  const elementRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!tooltip) {
      return;
    }
    window.addEventListener("resize", onClose);
    window.addEventListener("scroll", onClose, true);
    return () => {
      window.removeEventListener("resize", onClose);
      window.removeEventListener("scroll", onClose, true);
    };
  }, [onClose, tooltip]);

  useLayoutEffect(() => {
    const element = elementRef.current;
    if (!element || !tooltip) {
      return;
    }
    const tooltipRect = element.getBoundingClientRect();
    const { anchor } = tooltip;
    const centeredLeft = anchor.left + anchor.width / 2 - tooltipRect.width / 2;
    const left = Math.min(
      Math.max(centeredLeft, TOOLTIP_MARGIN),
      window.innerWidth - tooltipRect.width - TOOLTIP_MARGIN,
    );
    const below = anchor.bottom + TOOLTIP_GAP;
    const above = anchor.top - tooltipRect.height - TOOLTIP_GAP;
    const top =
      below + tooltipRect.height <= window.innerHeight - TOOLTIP_MARGIN ||
      above < TOOLTIP_MARGIN
        ? below
        : above;
    const maxTop = Math.max(
      TOOLTIP_MARGIN,
      window.innerHeight - tooltipRect.height - TOOLTIP_MARGIN,
    );
    element.style.left = `${left}px`;
    element.style.top = `${Math.min(Math.max(top, TOOLTIP_MARGIN), maxTop)}px`;
    element.style.visibility = "visible";
  }, [tooltip]);

  return tooltip
    ? createPortal(
        <div
          className="settings-mcp-permission-tooltip"
          id={MCP_PERMISSION_TOOLTIP_ID}
          ref={elementRef}
          role="tooltip"
        >
          {tooltip.text}
        </div>,
        document.body,
      )
    : null;
}
