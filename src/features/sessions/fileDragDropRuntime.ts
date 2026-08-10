import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";

interface DragUploadState {
  enabled: boolean;
  onUploadFiles: (paths: string[]) => void;
}

interface FileDragDropRuntimeOptions {
  getDragUploadState: () => DragUploadState;
  getPanel: () => HTMLElement | null;
  onActiveChange: (active: boolean) => void;
  onWindowBlur: () => void;
}

export interface FileDragDropRuntime {
  dispose: () => void;
}

export function installFileDragDropRuntime(
  options: FileDragDropRuntimeOptions,
): FileDragDropRuntime {
  let disposed = false;
  let removeDragDropListener: () => void = () => undefined;
  let removeScaleListener: () => void = () => undefined;

  const handleWindowBlur = () => {
    if (disposed) return;
    options.onActiveChange(false);
    options.onWindowBlur();
  };
  window.addEventListener("blur", handleWindowBlur);

  void (async () => {
    const appWindow = getCurrentWindow();
    // Tauri 提供物理坐标，DOM 使用逻辑坐标；跨屏时必须跟随缩放变化。
    let scaleFactor = await appWindow.scaleFactor();
    const stopScaleListener = await appWindow.onScaleChanged((event) => {
      scaleFactor = event.payload.scaleFactor;
    });
    if (disposed) {
      stopScaleListener();
      return;
    }
    removeScaleListener = stopScaleListener;

    const stopDragDropListener = await getCurrentWebview().onDragDropEvent((event) => {
      if (disposed) return;
      const payload = event.payload;
      if (payload.type === "leave") {
        options.onActiveChange(false);
        return;
      }

      const position = payload.position.toLogical(scaleFactor);
      const bounds = options.getPanel()?.getBoundingClientRect();
      const inside = Boolean(
        bounds &&
          position.x >= bounds.left &&
          position.x <= bounds.right &&
          position.y >= bounds.top &&
          position.y <= bounds.bottom,
      );
      const dragUpload = options.getDragUploadState();
      if (payload.type === "drop") {
        options.onActiveChange(false);
        if (inside && dragUpload.enabled && payload.paths.length > 0) {
          dragUpload.onUploadFiles(payload.paths);
        }
        return;
      }
      options.onActiveChange(inside && dragUpload.enabled);
    });

    if (disposed) {
      stopDragDropListener();
    } else {
      removeDragDropListener = stopDragDropListener;
    }
  })().catch(() => undefined);

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      options.onActiveChange(false);
      removeDragDropListener();
      removeScaleListener();
      window.removeEventListener("blur", handleWindowBlur);
    },
  };
}
