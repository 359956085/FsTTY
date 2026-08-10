import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  FILE_COLUMN_LIMITS,
  readWorkspacePreferences,
  updateWorkspacePreferences,
  type FileColumnPreferences,
} from "./workspacePreferences";

export type ResizableFileColumn = "name" | "size" | "modified";
export const RESIZABLE_FILE_COLUMNS: readonly ResizableFileColumn[] = [
  "name",
  "size",
  "modified",
];

const FILE_COLUMN_KEYBOARD_STEP = 8;

function clampFileColumn(column: ResizableFileColumn, value: number) {
  const limits = FILE_COLUMN_LIMITS[column];
  return Math.min(Math.max(value, limits.min), limits.max);
}

function applyFileColumnWidth(
  table: HTMLDivElement | null,
  column: keyof FileColumnPreferences,
  value: number,
) {
  table?.style.setProperty(`--file-column-${column}`, `${value}px`);
}

export function useFileColumnResizing() {
  const tableRef = useRef<HTMLDivElement>(null);
  const [fileColumns, setFileColumns] = useState<FileColumnPreferences>(
    () => readWorkspacePreferences().fileColumns,
  );
  const fileColumnsRef = useRef(fileColumns);
  const removeDragListenersRef = useRef<() => void>(() => undefined);

  useLayoutEffect(() => {
    fileColumnsRef.current = fileColumns;
    for (const column of RESIZABLE_FILE_COLUMNS) {
      applyFileColumnWidth(tableRef.current, column, fileColumns[column]);
    }
  }, [fileColumns]);

  useEffect(() => () => removeDragListenersRef.current(), []);

  const commit = useCallback((column: ResizableFileColumn, value: number) => {
    const next = {
      ...fileColumnsRef.current,
      [column]: clampFileColumn(column, value),
    };
    fileColumnsRef.current = next;
    setFileColumns(next);
    updateWorkspacePreferences({ fileColumns: next });
  }, []);

  const beginFileColumnResize = useCallback(
    (column: ResizableFileColumn, event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      removeDragListenersRef.current();
      const handle = event.currentTarget;
      const pointerId = event.pointerId;
      const startX = event.clientX;
      const startWidth = fileColumnsRef.current[column];
      handle.setPointerCapture(pointerId);

      const cleanup = () => {
        window.removeEventListener("pointermove", handlePointerMove);
        window.removeEventListener("pointerup", handlePointerUp);
        window.removeEventListener("pointercancel", handlePointerCancel);
        window.removeEventListener("blur", cancelDrag);
        if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
        removeDragListenersRef.current = () => undefined;
      };
      const calculateWidth = (clientX: number) =>
        clampFileColumn(column, startWidth + clientX - startX);
      const handlePointerMove = (pointerEvent: PointerEvent) => {
        if (pointerEvent.pointerId !== pointerId) return;
        pointerEvent.preventDefault();
        applyFileColumnWidth(tableRef.current, column, calculateWidth(pointerEvent.clientX));
      };
      const handlePointerUp = (pointerEvent: PointerEvent) => {
        if (pointerEvent.pointerId !== pointerId) return;
        const nextWidth = calculateWidth(pointerEvent.clientX);
        cleanup();
        commit(column, nextWidth);
      };
      const cancelDrag = () => {
        applyFileColumnWidth(tableRef.current, column, fileColumnsRef.current[column]);
        cleanup();
      };
      const handlePointerCancel = (pointerEvent: PointerEvent) => {
        if (pointerEvent.pointerId !== pointerId) return;
        cancelDrag();
      };

      removeDragListenersRef.current = cleanup;
      window.addEventListener("pointermove", handlePointerMove, { passive: false });
      window.addEventListener("pointerup", handlePointerUp);
      window.addEventListener("pointercancel", handlePointerCancel);
      window.addEventListener("blur", cancelDrag);
    },
    [commit],
  );

  const adjustFileColumn = useCallback(
    (column: ResizableFileColumn, direction: -1 | 1) => {
      commit(column, fileColumnsRef.current[column] + direction * FILE_COLUMN_KEYBOARD_STEP);
    },
    [commit],
  );

  return { adjustFileColumn, beginFileColumnResize, fileColumns, tableRef };
}
