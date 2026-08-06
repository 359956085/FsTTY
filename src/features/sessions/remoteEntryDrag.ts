import type { FileEntry } from "../../shared/api/types";

interface PointerCaptureTarget {
  hasPointerCapture(pointerId: number): boolean;
  releasePointerCapture(pointerId: number): void;
  setPointerCapture(pointerId: number): void;
}

interface RemoteEntryDragSnapshot {
  source: FileEntry;
  targetDirectory: string | null;
}

interface RemoteEntryMove {
  source: FileEntry;
  targetDirectory: string;
}

interface BeginRemoteEntryDrag {
  captureTarget: PointerCaptureTarget;
  clientX: number;
  clientY: number;
  pointerId: number;
  source: FileEntry;
}

interface MoveRemoteEntryDrag {
  clientX: number;
  clientY: number;
  pointerId: number;
  targetDirectory: string | null;
}

interface FinishRemoteEntryDrag {
  move: RemoteEntryMove | null;
  suppressClick: boolean;
}

interface RemoteEntryDragControllerOptions {
  onChange: (snapshot: RemoteEntryDragSnapshot | null) => void;
  threshold?: number;
}

interface ActiveRemoteEntryDrag extends RemoteEntryDragSnapshot {
  captureTarget: PointerCaptureTarget;
  dragging: boolean;
  pointerId: number;
  startX: number;
  startY: number;
}

export function createRemoteEntryDragController({
  onChange,
  threshold = 5,
}: RemoteEntryDragControllerOptions) {
  let active: ActiveRemoteEntryDrag | null = null;
  let disposed = false;

  const releaseCapture = (drag: ActiveRemoteEntryDrag) => {
    try {
      if (drag.captureTarget.hasPointerCapture(drag.pointerId)) {
        drag.captureTarget.releasePointerCapture(drag.pointerId);
      }
    } catch {
      // DOM 节点卸载后浏览器可能拒绝释放捕获；状态仍必须完成清理。
    }
  };

  const cancel = (pointerId?: number) => {
    const drag = active;
    if (!drag || (pointerId !== undefined && drag.pointerId !== pointerId)) {
      return false;
    }
    active = null;
    releaseCapture(drag);
    if (!disposed) {
      onChange(null);
    }
    return true;
  };

  return {
    source() {
      return active?.source ?? null;
    },
    begin({ captureTarget, clientX, clientY, pointerId, source }: BeginRemoteEntryDrag) {
      if (disposed) {
        return false;
      }
      cancel();
      captureTarget.setPointerCapture(pointerId);
      active = {
        captureTarget,
        dragging: false,
        pointerId,
        source,
        startX: clientX,
        startY: clientY,
        targetDirectory: null,
      };
      return true;
    },
    move({ clientX, clientY, pointerId, targetDirectory }: MoveRemoteEntryDrag) {
      const drag = active;
      if (disposed || !drag || drag.pointerId !== pointerId) {
        return { active: false, started: false };
      }
      let started = false;
      if (!drag.dragging) {
        if (Math.hypot(clientX - drag.startX, clientY - drag.startY) < threshold) {
          return { active: false, started: false };
        }
        drag.dragging = true;
        started = true;
      }
      if (started || drag.targetDirectory !== targetDirectory) {
        drag.targetDirectory = targetDirectory;
        onChange({ source: drag.source, targetDirectory });
      }
      return { active: true, started };
    },
    finish(pointerId: number): FinishRemoteEntryDrag {
      const drag = active;
      if (disposed || !drag || drag.pointerId !== pointerId) {
        return { move: null, suppressClick: false };
      }
      const move: RemoteEntryMove | null =
        drag.dragging && drag.targetDirectory
          ? { source: drag.source, targetDirectory: drag.targetDirectory }
          : null;
      const result = {
        move,
        suppressClick: drag.dragging,
      };
      cancel(pointerId);
      return result;
    },
    cancel,
    dispose() {
      if (disposed) {
        return;
      }
      const drag = active;
      active = null;
      disposed = true;
      if (drag) {
        releaseCapture(drag);
      }
    },
  };
}
