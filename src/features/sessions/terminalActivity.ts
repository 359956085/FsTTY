export interface TerminalActivityController {
  start: () => void;
  stop: () => void;
}

interface SyncTerminalActivityOptions {
  active: boolean;
  connected: boolean;
  resizeObserver: TerminalActivityController | null;
  remoteMouse: TerminalActivityController | null;
  visible: boolean;
}

export function syncTerminalActivity({
  active,
  connected,
  resizeObserver,
  remoteMouse,
  visible,
}: SyncTerminalActivityOptions): {
  shouldFit: boolean;
  shouldResetInteraction: boolean;
} {
  const interactive = active && visible;

  if (interactive) {
    resizeObserver?.start();
  } else {
    resizeObserver?.stop();
  }

  if (interactive && connected) {
    remoteMouse?.start();
  } else {
    remoteMouse?.stop();
  }

  return {
    shouldFit: interactive,
    shouldResetInteraction: !interactive || !connected,
  };
}
