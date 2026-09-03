import { Channel } from "@tauri-apps/api/core";
import type {
  TransferConflictDecision,
  TransferJobEvent,
  TransferJobSummary,
} from "../../shared/api/types";
import { createTransferSpeedTracker } from "./fileUtils";
import type { SessionRuntime, TransferProgress } from "./useSessionConnections";

export type TransferJobRuntimeUpdater = (
  runtimeId: string,
  update: (runtime: SessionRuntime) => SessionRuntime,
) => void;

interface TransferJobSubscriptionOptions {
  jobId: string;
  runtimeId: string;
  connectionId: string;
  isCurrent: () => boolean;
  onConflict: (job: TransferJobSummary) => Promise<TransferConflictDecision>;
  onTerminal: (job: TransferJobSummary) => void;
  resolveConflict: (
    jobId: string,
    decision: TransferConflictDecision,
  ) => Promise<void>;
  resolveError: (error: unknown) => string;
  updateRuntime: TransferJobRuntimeUpdater;
}

function visibleState(job: TransferJobSummary): TransferProgress["state"] {
  if (job.state === "completed") return "completed";
  if (job.state === "cancelled" || job.state === "failed") return "cancelled";
  return "running";
}

export function createTransferJobSubscription(
  options: TransferJobSubscriptionOptions,
) {
  const channel = new Channel<TransferJobEvent>();
  let speedTracker = createTransferSpeedTracker();
  let currentBatchKey = "";
  let conflictPending = false;
  let handledConflictKey: string | null = null;
  let terminalHandled = false;
  let latestConflict: TransferJobSummary | null = null;
  let latestBatchIndex = 0;

  const conflictKey = (job: TransferJobSummary) => `${job.batchIndex}:${job.fileName}`;
  const settleConflict = async () => {
    const job = latestConflict;
    if (!job || conflictPending || terminalHandled || !options.isCurrent()) return;
    const key = conflictKey(job);
    if (handledConflictKey === key) return;
    conflictPending = true;
    handledConflictKey = key;
    try {
      const decision = await options.onConflict(job);
      if (
        options.isCurrent() && !terminalHandled && latestConflict &&
        conflictKey(latestConflict) === key
      ) {
        await options.resolveConflict(job.jobId, decision);
      }
    } catch (error) {
      if (options.isCurrent() && !terminalHandled && latestConflict && conflictKey(latestConflict) === key) {
        handledConflictKey = null;
        options.updateRuntime(job.runtimeId, (runtime) => ({
          ...runtime, error: options.resolveError(error),
        }));
      }
    } finally {
      conflictPending = false;
      // 下一文件的冲突可先于上一决定的 IPC 回包到达，必须在回包后继续处理。
      if (latestConflict && conflictKey(latestConflict) !== key) void settleConflict();
    }
  };

  const apply = async (job: TransferJobSummary) => {
    if (
      job.jobId !== options.jobId ||
      job.runtimeId !== options.runtimeId ||
      job.connectionId !== options.connectionId ||
      terminalHandled || job.batchIndex < latestBatchIndex ||
      !options.isCurrent()
    ) {
      return;
    }
    latestBatchIndex = job.batchIndex;
    const batchKey = `${job.batchIndex}:${job.fileName}`;
    if (batchKey !== currentBatchKey) {
      currentBatchKey = batchKey;
      speedTracker = createTransferSpeedTracker();
    }
    const speed = speedTracker.update(job.transferredBytes, performance.now());
    options.updateRuntime(job.runtimeId, (runtime) => ({
      ...runtime,
      error:
        job.state === "failed" ||
        (job.state === "completed" && job.message && job.failed > 0)
          ? job.message ?? runtime.error
          : runtime.error,
      transfer: {
        id: job.jobId,
        connectionId: job.connectionId,
        direction: job.direction,
        fileName: job.fileName,
        batchIndex: job.batchTotal > 1 ? job.batchIndex : undefined,
        batchTotal: job.batchTotal > 1 ? job.batchTotal : undefined,
        transferredBytes: job.transferredBytes,
        totalBytes: job.totalBytes,
        ...speed,
        state: visibleState(job),
      },
    }));

    if (job.state !== "waitingForConflict") {
      handledConflictKey = null;
    }
    latestConflict = job.state === "waitingForConflict" ? job : null;

    const terminal = ["completed", "cancelled", "failed"].includes(job.state);
    if (terminal && !terminalHandled) {
      terminalHandled = true;
      options.onTerminal(job);
    }
    await settleConflict();
  };

  channel.onmessage = (event) => {
    if (event.kind === "updated") void apply(event.job);
  };
  return { apply, channel };
}
