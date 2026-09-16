import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";

interface TooltipButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "title"> {
  label: string;
  buttonRef?: RefObject<HTMLButtonElement | null>;
}

export function TooltipButton({
  label,
  buttonRef: externalButtonRef,
  children,
  onPointerEnter,
  onPointerLeave,
  onFocus,
  onBlur,
  onClick,
  "aria-describedby": describedBy,
  ...props
}: TooltipButtonProps) {
  const id = useId();
  const localButtonRef = useRef<HTMLButtonElement>(null);
  const buttonRef = externalButtonRef ?? localButtonRef;
  const tooltipRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [open, setOpen] = useState(false);
  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);
  const hide = useCallback(() => {
    clearTimer();
    setOpen(false);
  }, [clearTimer]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") hide();
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    window.addEventListener("blur", hide);
    return () => {
      clearTimer();
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
      window.removeEventListener("blur", hide);
    };
  }, [clearTimer, hide]);

  useLayoutEffect(() => {
    const tooltip = tooltipRef.current;
    const button = buttonRef.current;
    if (!open || !tooltip || !button) return;
    const anchor = button.getBoundingClientRect();
    const bounds = tooltip.getBoundingClientRect();
    const margin = 8;
    const below = anchor.bottom + 6;
    const top = below + bounds.height <= window.innerHeight - margin
      ? below
      : anchor.top - bounds.height - 6;
    tooltip.style.left = `${Math.max(margin, Math.min(
      anchor.left + (anchor.width - bounds.width) / 2,
      window.innerWidth - bounds.width - margin,
    ))}px`;
    tooltip.style.top = `${Math.max(margin, Math.min(top, window.innerHeight - bounds.height - margin))}px`;
    tooltip.style.visibility = "visible";
  }, [buttonRef, label, open]);

  return (
    <>
      <button
        type="button"
        aria-label={label}
        {...props}
        aria-describedby={[describedBy, open ? id : null].filter(Boolean).join(" ") || undefined}
        ref={buttonRef}
        onPointerEnter={(event) => {
          onPointerEnter?.(event);
          if (event.pointerType === "touch") return;
          clearTimer();
          timerRef.current = setTimeout(() => setOpen(true), 250);
        }}
        onPointerLeave={(event) => {
          onPointerLeave?.(event);
          if (document.activeElement !== event.currentTarget) hide();
        }}
        onFocus={(event) => {
          onFocus?.(event);
          clearTimer();
          setOpen(true);
        }}
        onBlur={(event) => {
          hide();
          onBlur?.(event);
        }}
        onClick={(event) => {
          hide();
          onClick?.(event);
        }}
      >
        {children}
      </button>
      {open && createPortal(
        <div className="button-tooltip" id={id} ref={tooltipRef} role="tooltip">
          {label}
        </div>,
        document.body,
      )}
    </>
  );
}
