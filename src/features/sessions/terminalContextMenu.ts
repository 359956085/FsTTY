import type { Terminal as XTerm } from "@xterm/xterm";

type TerminalMouseTrackingMode = XTerm["modes"]["mouseTrackingMode"];

interface RemoteRightDragStart {
  button: number;
  enabled: boolean;
  mouseTrackingMode: TerminalMouseTrackingMode;
  pointerId?: number;
  shiftKey: boolean;
}

export function shouldOpenLocalTerminalContextMenu(
  mouseTrackingMode: TerminalMouseTrackingMode,
  shiftKey: boolean,
) {
  return mouseTrackingMode === "none" || shiftKey;
}

export function createRemoteRightDragState() {
  let active = false;
  let initialMouseTrackingMode: TerminalMouseTrackingMode = "none";
  let listenersRearmed = false;
  let pointerId: number | null = null;
  let releaseHandled = false;

  const takeListenerRearm = (mouseTrackingMode: TerminalMouseTrackingMode) => {
    if (
      !active ||
      listenersRearmed ||
      mouseTrackingMode === initialMouseTrackingMode ||
      (mouseTrackingMode !== "drag" && mouseTrackingMode !== "any")
    ) {
      return false;
    }
    listenersRearmed = true;
    return true;
  };

  return {
    begin({ button, enabled, mouseTrackingMode, pointerId: nextPointerId, shiftKey }: RemoteRightDragStart) {
      const nextActive =
        enabled && button === 2 && !shiftKey && mouseTrackingMode !== "none";
      if (!nextActive) {
        active = false;
        initialMouseTrackingMode = "none";
        listenersRearmed = false;
        pointerId = null;
        releaseHandled = false;
        return;
      }
      active = true;
      initialMouseTrackingMode = mouseTrackingMode;
      listenersRearmed = false;
      pointerId = nextPointerId ?? null;
      releaseHandled = false;
    },
    end() {
      active = false;
      initialMouseTrackingMode = "none";
      listenersRearmed = false;
      pointerId = null;
      releaseHandled = false;
    },
    cancelPointer(cancelledPointerId: number) {
      if (active && (pointerId === null || pointerId === cancelledPointerId)) {
        active = false;
        initialMouseTrackingMode = "none";
        listenersRearmed = false;
        pointerId = null;
        releaseHandled = false;
      }
    },
    getMoveAction(
      mouseTrackingMode: TerminalMouseTrackingMode,
      buttons: number | undefined,
      synthetic: boolean,
    ) {
      if (!active || synthetic) {
        return { kind: "ignore" } as const;
      }
      if (takeListenerRearm(mouseTrackingMode)) {
        return { kind: "rearmAndRedispatchRightDrag" } as const;
      }
      if (buttons !== undefined && (buttons & 2) !== 0) {
        return { kind: "passthrough" } as const;
      }
      if (mouseTrackingMode === "drag" || mouseTrackingMode === "any") {
        return { kind: "repairRightDrag" } as const;
      }
      return { kind: "ignore" } as const;
    },
    getPointerUpAction(
      mouseTrackingMode: TerminalMouseTrackingMode,
      releasedPointerId: number,
    ) {
      if (
        !active ||
        releaseHandled ||
        (pointerId !== null && releasedPointerId !== pointerId)
      ) {
        return { kind: "ignore" } as const;
      }
      return takeListenerRearm(mouseTrackingMode)
        ? ({ kind: "rearmListeners" } as const)
        : ({ kind: "continue" } as const);
    },
    getNativeReleaseAction(button: number, synthetic: boolean) {
      if (!active || synthetic || releaseHandled) {
        return { kind: "ignore" } as const;
      }
      if (button !== 2) {
        return { kind: "repairRightRelease" } as const;
      }
      releaseHandled = true;
      return { kind: "passthrough" } as const;
    },
    getFallbackReleaseAction(releasedPointerId?: number) {
      if (
        !active ||
        releaseHandled ||
        (releasedPointerId !== undefined &&
          pointerId !== null &&
          releasedPointerId !== pointerId)
      ) {
        return { kind: "ignore" } as const;
      }
      // 原生 mouseup 缺失时才补发；状态层保证远端最多收到一次兜底释放。
      releaseHandled = true;
      return { kind: "redispatch", button: 2, buttons: 0 } as const;
    },
  };
}
