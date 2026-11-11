import type { ShortcutBinding } from "./api/types";

export function wheelShortcutFromEvent(event: WheelEvent): ShortcutBinding | null {
  if (event.metaKey || !Number.isFinite(event.deltaY) || event.deltaY === 0) return null;
  return { code: event.deltaY < 0 ? "WheelUp" : "WheelDown", ctrl: event.ctrlKey, alt: event.altKey, shift: event.shiftKey };
}

// Share the terminal's high-resolution wheel gesture rules with recording.
export function createWheelStepAccumulator() {
  let accumulated = 0;
  let lastTime = 0;
  let modifiers = "";
  return (event: WheelEvent) => {
    if (!Number.isFinite(event.deltaY) || event.deltaY === 0) return 0;
    const nextModifiers = [event.ctrlKey, event.altKey, event.shiftKey, event.metaKey].join(":");
    const now = Date.now();
    const delta = event.deltaY * (event.deltaMode === 1 ? 40 : event.deltaMode === 2 ? 100 : 1);
    if (now - lastTime > 300 || Math.sign(delta) !== Math.sign(accumulated) || modifiers !== nextModifiers) accumulated = 0;
    lastTime = now;
    modifiers = nextModifiers;
    accumulated += delta;
    const steps = Math.trunc(accumulated / 100);
    accumulated -= steps * 100;
    return steps;
  };
}
