import type { KeyboardEvent, PointerEventHandler } from "react";
import type { ResizeDirection } from "./usePaneLayout";

interface ResizeHandleProps {
  orientation: "horizontal" | "vertical";
  ariaLabel: string;
  valueMin: number;
  valueMax: number;
  valueNow: number;
  onPointerDown: PointerEventHandler<HTMLDivElement>;
  onKeyboardResize: (direction: ResizeDirection) => void;
  className?: string;
  disabled?: boolean;
}

export function ResizeHandle({
  orientation,
  ariaLabel,
  valueMin,
  valueMax,
  valueNow,
  onPointerDown,
  onKeyboardResize,
  className = "",
  disabled = false,
}: ResizeHandleProps) {
  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const previousKey = orientation === "vertical" ? "ArrowLeft" : "ArrowUp";
    const nextKey = orientation === "vertical" ? "ArrowRight" : "ArrowDown";

    if (event.key === previousKey) {
      event.preventDefault();
      onKeyboardResize(-1);
    } else if (event.key === nextKey) {
      event.preventDefault();
      onKeyboardResize(1);
    }
  }

  return (
    <div
      aria-disabled={disabled}
      aria-label={ariaLabel}
      aria-orientation={orientation}
      aria-valuemax={valueMax}
      aria-valuemin={valueMin}
      aria-valuenow={Math.round(valueNow)}
      className={`resize-handle resize-handle-${orientation} ${className}`.trim()}
      onKeyDown={disabled ? undefined : handleKeyDown}
      onPointerDown={disabled ? undefined : onPointerDown}
      role="separator"
      style={{ touchAction: "none" }}
      tabIndex={disabled ? -1 : 0}
    />
  );
}
