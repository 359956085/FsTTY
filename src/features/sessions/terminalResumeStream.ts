import type { TerminalResumeEvent } from "../../shared/api/types";
import { decodeBase64 } from "./terminalProtocol";

type TerminalEnd = Extract<TerminalResumeEvent, { kind: "disconnected" | "error" }>;

interface TerminalResumeStreamOptions {
  connectionId: string;
  isCurrent(): boolean;
  write(data: string | Uint8Array, callback?: () => void): void;
  consumeBarrier(data: string): boolean;
  onEnd(event: TerminalEnd): void;
}

const CHUNK_BYTES = 192 * 1024;
const MAX_SNAPSHOT_CHUNKS = Math.ceil((32 * 1024 * 1024) / CHUNK_BYTES);

export function createTerminalResumeStream(options: TerminalResumeStreamOptions) {
  let started = false;
  let stopped = false;
  let readyReceived = false;
  let readyDrained = false;
  let expectedChunks: number | null = null;
  let nextChunk = 0;
  let end: TerminalEnd | null = null;
  let queued: TerminalResumeEvent[] = [];
  let queuedBytes = 0;
  let resolveReady!: (truncated: boolean) => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<boolean>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  // IPC 事件可以先于调用结果抵达，调用方安装等待器前也不能产生未处理拒绝。
  void ready.catch(() => undefined);
  const isCurrent = () => !stopped && options.isCurrent();
  const complete = () => expectedChunks !== null && nextChunk === expectedChunks;
  const finishEnd = () => {
    if (!end || !isCurrent()) return;
    stopped = true;
    options.onEnd(end);
  };
  const fail = (error: Error) => {
    if (!isCurrent()) return;
    queued = [];
    queuedBytes = 0;
    if (readyDrained) {
      end = { kind: "error", connectionId: options.connectionId, message: error.message };
      finishEnd();
    } else {
      stopped = true;
      rejectReady(error);
    }
  };

  const apply = (event: TerminalResumeEvent) => {
    if (!isCurrent()) return;
    if (event.kind === "snapshot") {
      if (
        readyReceived || end ||
        !Number.isInteger(event.totalChunks) || event.totalChunks < 1 ||
        event.totalChunks > MAX_SNAPSHOT_CHUNKS ||
        event.chunkIndex !== nextChunk || event.chunkIndex >= event.totalChunks ||
        (expectedChunks !== null && expectedChunks !== event.totalChunks) ||
        event.data.length > Math.ceil(CHUNK_BYTES / 3) * 4
      ) {
        throw new Error("终端恢复快照分块顺序无效");
      }
      const bytes = decodeBase64(event.data);
      if (bytes.length > CHUNK_BYTES) throw new Error("终端恢复快照分块过大");
      expectedChunks = event.totalChunks;
      nextChunk += 1;
      options.write(bytes);
    } else if (event.kind === "data") {
      if (end) return;
      if (!complete()) throw new Error("终端恢复快照不完整");
      if (!options.consumeBarrier(event.data)) options.write(decodeBase64(event.data));
    } else if (event.kind === "disconnected" || event.kind === "error") {
      end ??= event;
      if (readyDrained) finishEnd();
    } else {
      if (readyReceived || !complete()) throw new Error("终端恢复快照不完整");
      readyReceived = true;
      options.write("", () => {
        if (!isCurrent()) return;
        readyDrained = true;
        resolveReady(event.truncated);
        finishEnd();
      });
    }
  };

  const push = (event: TerminalResumeEvent) => {
    if (!isCurrent() || event.connectionId !== options.connectionId) return;
    try {
      if (!started) {
        queuedBytes += "data" in event ? event.data.length : 0;
        if (queued.length >= 1024 || queuedBytes > 64 * 1024 * 1024) {
          throw new Error("终端恢复等待队列过大");
        }
        queued.push(event);
      } else {
        apply(event);
      }
    } catch (error) {
      fail(error instanceof Error ? error : new Error("终端恢复数据无效"));
    }
  };

  return {
    ready,
    push,
    start() {
      if (started || !isCurrent()) return;
      started = true;
      const pending = queued;
      queued = [];
      queuedBytes = 0;
      pending.forEach(push);
    },
    dispose() {
      stopped = true;
      queued = [];
      queuedBytes = 0;
      rejectReady(new Error("终端恢复已取消"));
    },
  };
}
