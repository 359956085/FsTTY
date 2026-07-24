import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import {
  readWorkspacePreferences,
  updateWorkspacePreferences,
  WORKSPACE_LAYOUT_LIMITS,
  type WorkspaceLayoutPreferences,
} from "./workspacePreferences";

export type PaneResizeTarget = "left" | "right" | "files";
export type ResizeDirection = -1 | 1;

export const WORKSPACE_COLLAPSED_PANE_WIDTH = 72;

interface UsePaneLayoutResult {
  rootRef: RefObject<HTMLDivElement | null>;
  layout: WorkspaceLayoutPreferences;
  beginResize: (
    target: PaneResizeTarget,
    event: ReactPointerEvent<HTMLDivElement>,
  ) => void;
  adjustResize: (
    target: PaneResizeTarget,
    direction: ResizeDirection,
  ) => void;
  toggleLeftCollapsed: () => void;
  toggleRightCollapsed: () => void;
}

interface ActiveDrag {
  pointerId: number;
  target: PaneResizeTarget;
  handle: HTMLDivElement;
  startCoordinate: number;
  startValue: number;
  trackSize: number;
  rootWidth: number;
}

const KEYBOARD_WIDTH_STEP = 8;
const KEYBOARD_RATIO_STEP = 2;
const VERTICAL_HANDLES_WIDTH = 8;
const WORKSPACE_TAB_BAR_HEIGHT = 48;
const HORIZONTAL_HANDLE_HEIGHT = 4;
const DEVICE_STATUS_MIN_HEIGHT = 230;

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function getCssVariable(target: PaneResizeTarget) {
  switch (target) {
    case "left":
      return "--workspace-left-width";
    case "right":
      return "--workspace-right-width";
    case "files":
      return "--workspace-files-ratio";
  }
}

function applyCssValue(
  root: HTMLDivElement | null,
  target: PaneResizeTarget,
  value: number,
) {
  root?.style.setProperty(
    getCssVariable(target),
    target === "files" ? `${value}%` : `${value}px`,
  );
}

function getBoundedValue(
  target: PaneResizeTarget,
  value: number,
  layout: WorkspaceLayoutPreferences,
  rootWidth: number,
  filesTrackHeight = 0,
) {
  if (target === "files") {
    const heightLimitedMax =
      filesTrackHeight > 0
        ? ((filesTrackHeight - HORIZONTAL_HANDLE_HEIGHT - DEVICE_STATUS_MIN_HEIGHT) /
            filesTrackHeight) *
          100
        : WORKSPACE_LAYOUT_LIMITS.fileRatio.max;
    const max = clamp(
      heightLimitedMax,
      0,
      WORKSPACE_LAYOUT_LIMITS.fileRatio.max,
    );
    // 窗口较矮时优先保留设备状态五行，文件区通过自身滚动继续使用。
    const min = Math.min(WORKSPACE_LAYOUT_LIMITS.fileRatio.min, max);
    return clamp(value, min, max);
  }

  const limits =
    target === "left"
      ? WORKSPACE_LAYOUT_LIMITS.leftWidth
      : WORKSPACE_LAYOUT_LIMITS.rightWidth;
  const otherWidth =
    target === "left"
      ? layout.rightCollapsed
        ? WORKSPACE_COLLAPSED_PANE_WIDTH
        : layout.rightWidth
      : layout.leftCollapsed
        ? WORKSPACE_COLLAPSED_PANE_WIDTH
        : layout.leftWidth;
  const availableMax =
    rootWidth > 0
      ? rootWidth -
        otherWidth -
        WORKSPACE_LAYOUT_LIMITS.terminalMinWidth -
        VERTICAL_HANDLES_WIDTH
      : limits.max;

  return clamp(
    value,
    limits.min,
    Math.max(limits.min, Math.min(limits.max, availableMax)),
  );
}

function calculateDragValue(
  drag: ActiveDrag,
  event: PointerEvent,
  layout: WorkspaceLayoutPreferences,
) {
  const coordinate = drag.target === "files" ? event.clientY : event.clientX;
  const offset = coordinate - drag.startCoordinate;
  const rawValue =
    drag.target === "files"
      ? drag.startValue + (offset / drag.trackSize) * 100
      : drag.target === "right"
        ? drag.startValue - offset
        : drag.startValue + offset;

  return getBoundedValue(
    drag.target,
    rawValue,
    layout,
    drag.rootWidth,
    drag.trackSize,
  );
}

function fitLayoutToRoot(
  layout: WorkspaceLayoutPreferences,
  rootWidth: number,
  rootHeight: number,
  resizeFirst: "left" | "right",
) {
  if (rootWidth <= 0 && rootHeight <= 0) {
    return layout;
  }

  let leftWidth = layout.leftWidth;
  let rightWidth = layout.rightWidth;
  const filesTrackHeight = Math.max(rootHeight - WORKSPACE_TAB_BAR_HEIGHT, 0);
  const fileRatio = getBoundedValue(
    "files",
    layout.fileRatio,
    layout,
    rootWidth,
    filesTrackHeight,
  );
  const effectiveLeft = layout.leftCollapsed
    ? WORKSPACE_COLLAPSED_PANE_WIDTH
    : leftWidth;
  const effectiveRight = layout.rightCollapsed
    ? WORKSPACE_COLLAPSED_PANE_WIDTH
    : rightWidth;
  let overflow =
    effectiveLeft +
    effectiveRight +
    VERTICAL_HANDLES_WIDTH +
    WORKSPACE_LAYOUT_LIMITS.terminalMinWidth -
    rootWidth;

  if (overflow <= 0) {
    return fileRatio === layout.fileRatio ? layout : { ...layout, fileRatio };
  }

  const shrink = (target: "left" | "right") => {
    if (
      (target === "left" && layout.leftCollapsed) ||
      (target === "right" && layout.rightCollapsed)
    ) {
      return;
    }

    const current = target === "left" ? leftWidth : rightWidth;
    const min =
      target === "left"
        ? WORKSPACE_LAYOUT_LIMITS.leftWidth.min
        : WORKSPACE_LAYOUT_LIMITS.rightWidth.min;
    const amount = Math.min(Math.max(current - min, 0), overflow);

    if (target === "left") {
      leftWidth -= amount;
    } else {
      rightWidth -= amount;
    }
    overflow -= amount;
  };

  shrink(resizeFirst);
  shrink(resizeFirst === "left" ? "right" : "left");

  return leftWidth === layout.leftWidth &&
    rightWidth === layout.rightWidth &&
    fileRatio === layout.fileRatio
    ? layout
    : { ...layout, leftWidth, rightWidth, fileRatio };
}

export function usePaneLayout(): UsePaneLayoutResult {
  const rootRef = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState<WorkspaceLayoutPreferences>(
    () => readWorkspacePreferences().layout,
  );
  const layoutRef = useRef(layout);
  const removeDragListenersRef = useRef<() => void>(() => undefined);

  const commitLayout = useCallback((next: WorkspaceLayoutPreferences) => {
    layoutRef.current = next;
    setLayout(next);
    updateWorkspacePreferences({ layout: next });
  }, []);

  useLayoutEffect(() => {
    const root = rootRef.current;
    applyCssValue(root, "left", layout.leftWidth);
    applyCssValue(root, "right", layout.rightWidth);
    applyCssValue(root, "files", layout.fileRatio);
    root?.style.setProperty(
      "--workspace-collapsed-pane-width",
      `${WORKSPACE_COLLAPSED_PANE_WIDTH}px`,
    );
  }, [layout]);

  useEffect(
    () => () => {
      removeDragListenersRef.current();
    },
    [],
  );

  useEffect(() => {
    const root = rootRef.current;
    if (!root || typeof ResizeObserver === "undefined") {
      return;
    }

    const observer = new ResizeObserver(([entry]) => {
      const current = layoutRef.current;
      // 窗口缩小时优先收缩右栏，保证终端不会被两侧面板挤没。
      const next = fitLayoutToRoot(
        current,
        entry.contentRect.width,
        entry.contentRect.height,
        "right",
      );
      if (next !== current) {
        commitLayout(next);
      }
    });

    observer.observe(root);
    return () => observer.disconnect();
  }, [commitLayout]);

  const beginResize = useCallback(
    (
      target: PaneResizeTarget,
      event: ReactPointerEvent<HTMLDivElement>,
    ) => {
      if (event.button !== 0) {
        return;
      }

      const root = rootRef.current;
      if (!root) {
        return;
      }

      event.preventDefault();
      removeDragListenersRef.current();

      const current = layoutRef.current;
      const rootBounds = root.getBoundingClientRect();
      const handle = event.currentTarget;
      const filesTrackHeight =
        target === "files"
          ? (handle.parentElement?.getBoundingClientRect().height ?? rootBounds.height)
          : rootBounds.height;
      const drag: ActiveDrag = {
        pointerId: event.pointerId,
        target,
        handle,
        startCoordinate: target === "files" ? event.clientY : event.clientX,
        startValue:
          target === "left"
            ? current.leftWidth
            : target === "right"
              ? current.rightWidth
              : current.fileRatio,
        trackSize: Math.max(filesTrackHeight, 1),
        rootWidth: rootBounds.width,
      };

      handle.setPointerCapture(event.pointerId);

      const cleanup = () => {
        window.removeEventListener("pointermove", handlePointerMove);
        window.removeEventListener("pointerup", handlePointerUp);
        window.removeEventListener("pointercancel", handlePointerCancel);
        window.removeEventListener("blur", handlePointerCancel);
        if (handle.hasPointerCapture(drag.pointerId)) {
          handle.releasePointerCapture(drag.pointerId);
        }
        removeDragListenersRef.current = () => undefined;
      };

      const handlePointerMove = (pointerEvent: PointerEvent) => {
        if (pointerEvent.pointerId !== drag.pointerId) {
          return;
        }

        pointerEvent.preventDefault();
        const nextValue = calculateDragValue(
          drag,
          pointerEvent,
          layoutRef.current,
        );
        // 高频拖动只写 CSS；松开后才触发 React 更新和持久化。
        applyCssValue(root, target, nextValue);
      };

      const handlePointerUp = (pointerEvent: PointerEvent) => {
        if (pointerEvent.pointerId !== drag.pointerId) {
          return;
        }

        const currentLayout = layoutRef.current;
        const nextValue = calculateDragValue(drag, pointerEvent, currentLayout);
        const nextLayout = {
          ...currentLayout,
          ...(target === "left"
            ? { leftWidth: nextValue }
            : target === "right"
              ? { rightWidth: nextValue }
              : { fileRatio: nextValue }),
        };
        cleanup();
        commitLayout(nextLayout);
      };

      const handlePointerCancel = () => {
        const currentLayout = layoutRef.current;
        applyCssValue(
          root,
          target,
          target === "left"
            ? currentLayout.leftWidth
            : target === "right"
              ? currentLayout.rightWidth
              : currentLayout.fileRatio,
        );
        cleanup();
      };

      removeDragListenersRef.current = cleanup;
      window.addEventListener("pointermove", handlePointerMove, { passive: false });
      window.addEventListener("pointerup", handlePointerUp);
      window.addEventListener("pointercancel", handlePointerCancel);
      window.addEventListener("blur", handlePointerCancel);
    },
    [commitLayout],
  );

  const adjustResize = useCallback(
    (target: PaneResizeTarget, direction: ResizeDirection) => {
      const current = layoutRef.current;
      const rootBounds = rootRef.current?.getBoundingClientRect();
      const rootWidth = rootBounds?.width ?? 0;
      const filesTrackHeight = Math.max(
        (rootBounds?.height ?? 0) - WORKSPACE_TAB_BAR_HEIGHT,
        0,
      );
      const movement =
        target === "files"
          ? direction * KEYBOARD_RATIO_STEP
          : direction * KEYBOARD_WIDTH_STEP;
      const rawValue =
        target === "left"
          ? current.leftWidth + movement
          : target === "right"
            ? current.rightWidth - movement
            : current.fileRatio + movement;
      const nextValue = getBoundedValue(
        target,
        rawValue,
        current,
        rootWidth,
        filesTrackHeight,
      );
      const nextLayout = {
        ...current,
        ...(target === "left"
          ? { leftWidth: nextValue }
          : target === "right"
            ? { rightWidth: nextValue }
            : { fileRatio: nextValue }),
      };

      commitLayout(nextLayout);
    },
    [commitLayout],
  );

  const toggleLeftCollapsed = useCallback(() => {
    const current = layoutRef.current;
    const toggled = { ...current, leftCollapsed: !current.leftCollapsed };
    const rootBounds = rootRef.current?.getBoundingClientRect();
    commitLayout(
      fitLayoutToRoot(
        toggled,
        rootBounds?.width ?? 0,
        rootBounds?.height ?? 0,
        "left",
      ),
    );
  }, [commitLayout]);

  const toggleRightCollapsed = useCallback(() => {
    const current = layoutRef.current;
    const toggled = { ...current, rightCollapsed: !current.rightCollapsed };
    const rootBounds = rootRef.current?.getBoundingClientRect();
    commitLayout(
      fitLayoutToRoot(
        toggled,
        rootBounds?.width ?? 0,
        rootBounds?.height ?? 0,
        "right",
      ),
    );
  }, [commitLayout]);

  return useMemo(
    () => ({
      rootRef,
      layout,
      beginResize,
      adjustResize,
      toggleLeftCollapsed,
      toggleRightCollapsed,
    }),
    [
      adjustResize,
      beginResize,
      layout,
      toggleLeftCollapsed,
      toggleRightCollapsed,
    ],
  );
}
