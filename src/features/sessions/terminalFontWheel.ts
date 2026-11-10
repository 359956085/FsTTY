// Capture before xterm's mouse reporting and the WebView's page zoom handlers.
export function installTerminalFontWheel(container: HTMLElement, adjust: (steps: number) => void, isEnabled: () => boolean) {
  let accumulated = 0;
  let lastTime = 0;
  const listener = (event: WheelEvent) => {
    if (!event.ctrlKey || event.altKey || event.metaKey || !isEnabled()) { accumulated = 0; return; }
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!Number.isFinite(event.deltaY) || event.deltaY === 0) return;
    const now = Date.now();
    const delta = event.deltaY * (event.deltaMode === 1 ? 40 : event.deltaMode === 2 ? 100 : 1);
    if (now - lastTime > 300 || Math.sign(delta) !== Math.sign(accumulated)) accumulated = 0;
    lastTime = now;
    accumulated += delta;
    const steps = Math.trunc(accumulated / 100);
    if (steps) { accumulated -= steps * 100; adjust(-steps); }
  };
  container.addEventListener("wheel", listener, { capture: true, passive: false });
  return () => container.removeEventListener("wheel", listener, true);
}
