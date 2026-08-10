import { splitUtf8 } from "./terminalProtocol";

const CONNECTING_BUFFER_LIMIT = 64 * 1024;
const FLUSH_THRESHOLD = 32 * 1024;
const WRITE_CHUNK_LIMIT = 64 * 1024;
const FLUSH_DELAY_MS = 16;

interface TerminalInputControllerOptions {
  getConnectionId: () => string | null;
  isConnecting: () => boolean;
  onWriteError: (connectionId: string, error: unknown) => void;
  write: (connectionId: string, data: string) => Promise<void>;
}

export interface TerminalInputController {
  clear: () => void;
  dispose: () => void;
  enqueue: (data: string) => void;
  flush: () => void;
}

export function createTerminalInputController({
  getConnectionId,
  isConnecting,
  onWriteError,
  write,
}: TerminalInputControllerOptions): TerminalInputController {
  let buffer = "";
  let bufferConnectionId: string | null = null;
  let timer: number | null = null;
  let writeChain = Promise.resolve();
  let disposed = false;

  const clearTimer = () => {
    if (timer !== null) {
      window.clearTimeout(timer);
      timer = null;
    }
  };

  const clear = () => {
    clearTimer();
    buffer = "";
    bufferConnectionId = null;
    writeChain = Promise.resolve();
  };

  const flush = () => {
    clearTimer();
    const connectionId = getConnectionId();
    const data = buffer;
    const expectedConnectionId = bufferConnectionId;
    buffer = "";
    bufferConnectionId = null;
    if (
      disposed ||
      !connectionId ||
      !data ||
      (expectedConnectionId !== null && expectedConnectionId !== connectionId)
    ) {
      return;
    }

    for (const chunk of splitUtf8(data, WRITE_CHUNK_LIMIT)) {
      writeChain = writeChain
        .then(async () => {
          if (disposed || getConnectionId() !== connectionId) return;
          await write(connectionId, chunk);
        })
        .catch((error: unknown) => {
          if (disposed || getConnectionId() !== connectionId) return;
          clear();
          onWriteError(connectionId, error);
        });
    }
  };

  const enqueue = (data: string) => {
    if (disposed) return;
    const connectionId = getConnectionId();
    if (!connectionId && !isConnecting()) return;
    if (
      buffer &&
      bufferConnectionId !== null &&
      bufferConnectionId !== connectionId
    ) {
      // 连接切换时丢弃旧连接尚未发送的数据，禁止跨会话串写。
      clear();
    }
    const next = buffer + data;
    // 连接握手期间仅缓存终端能力应答，避免无界输入占用内存。
    if (!connectionId) {
      if (new TextEncoder().encode(next).byteLength <= CONNECTING_BUFFER_LIMIT) {
        buffer = next;
        bufferConnectionId = null;
      }
      return;
    }
    buffer = next;
    bufferConnectionId = connectionId;
    if (new TextEncoder().encode(buffer).byteLength >= FLUSH_THRESHOLD) {
      flush();
      return;
    }
    if (timer === null) timer = window.setTimeout(flush, FLUSH_DELAY_MS);
  };

  return {
    clear,
    dispose: () => {
      disposed = true;
      clear();
    },
    enqueue,
    flush,
  };
}
