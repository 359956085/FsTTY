import type { ShortcutSettings } from "../../shared/api/types";
import { DEFAULT_SHORTCUTS, terminalFontShortcutStep } from "../../shared/shortcuts";
import { createWheelStepAccumulator, wheelShortcutFromEvent } from "../../shared/wheelShortcuts";

// Capture before xterm's mouse reporting and the WebView's page zoom handlers.
export function installTerminalFontWheel(container: HTMLElement, adjust: (steps: number) => void, isEnabled: () => boolean,
  getShortcuts: () => ShortcutSettings = () => DEFAULT_SHORTCUTS) {
  let accumulate = createWheelStepAccumulator();
  const listener = (event: WheelEvent) => {
    if (!isEnabled()) { accumulate = createWheelStepAccumulator(); return; }
    const binding = wheelShortcutFromEvent(event);
    const direction = binding ? terminalFontShortcutStep({ code: binding.code, ctrlKey: binding.ctrl, altKey: binding.alt, shiftKey: binding.shift, metaKey: false }, getShortcuts()) : 0;
    if (!direction) {
      accumulate = createWheelStepAccumulator();
      // Clearing/rebinding must not turn the old Ctrl gesture into page zoom.
      if (event.ctrlKey && !event.metaKey) { event.preventDefault(); event.stopImmediatePropagation(); }
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    const steps = accumulate(event);
    if (steps) adjust(Math.abs(steps) * direction);
  };
  container.addEventListener("wheel", listener, { capture: true, passive: false });
  return () => container.removeEventListener("wheel", listener, true);
}
