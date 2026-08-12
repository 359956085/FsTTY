import { Channel } from "@tauri-apps/api/core";
import type { TransferEvent } from "../../shared/api/types";
import i18n from "../../shared/i18n";
import { createTransferSpeedTracker } from "./fileUtils";
import type { SessionRuntime, TransferProgress } from "./useSessionConnections";

export type RuntimeUpdater = (
  sessionId: string,
  update: (runtime: SessionRuntime) => SessionRuntime,
) => void;

export function createTransferChannel(
  sessionId: string,
  transferId: string,
  direction: TransferProgress["direction"],
  fileName: string,
  updateRuntime: RuntimeUpdater,
  batchIndex?: number,
  batchTotal?: number,
) {
  const channel = new Channel<TransferEvent>();
  const speedTracker = createTransferSpeedTracker();
  const initialSpeed = speedTracker.update(0, performance.now());
  channel.onmessage = (event) => {
    if (event.transferId !== transferId) return;
    const speed = speedTracker.update(event.transferredBytes, performance.now());
    updateRuntime(sessionId, (runtime) => ({
      ...runtime,
      transfer: {
        id: transferId,
        direction,
        fileName,
        batchIndex,
        batchTotal,
        transferredBytes: event.transferredBytes,
        totalBytes: event.totalBytes,
        ...speed,
        state:
          event.kind === "completed"
            ? "completed"
            : event.kind === "cancelled"
              ? "cancelled"
              : "running",
      },
    }));
  };
  updateRuntime(sessionId, (runtime) => ({
    ...runtime,
    error: null,
    transfer: {
      id: transferId,
      direction,
      fileName,
      batchIndex,
      batchTotal,
      transferredBytes: 0,
      totalBytes: 0,
      ...initialSpeed,
      state: "running",
    },
  }));
  return channel;
}

export function fileNameFromPath(path: string) {
  return path.split(/[\\/]/).pop() || i18n.t("sessions.fallbackFileName");
}
