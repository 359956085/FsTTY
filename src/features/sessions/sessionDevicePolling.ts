import type {
  DeviceMetricSample,
  DeviceMetricsSnapshot,
  DeviceStatus,
  SshConnection,
} from "../../shared/api/types";
import {
  DEVICE_INITIAL_POLL_INTERVAL_MS,
  DEVICE_INITIAL_POLL_TIMEOUT_MS,
} from "./deviceMetrics";

interface DeviceRuntime {
  connection: SshConnection | null;
  deviceLoading: boolean;
  deviceStatus: DeviceStatus | null;
  deviceHistory: DeviceMetricSample[];
  deviceWindowEndMs: number;
}

interface SessionDevicePollingControllerOptions<TRuntime extends DeviceRuntime> {
  getDeviceMetricsSnapshot: (connectionId: string) => Promise<DeviceMetricsSnapshot>;
  getRuntime: (sessionId: string) => TRuntime | undefined;
  intervalMs: number;
  updateRuntime: (
    sessionId: string,
    update: (runtime: TRuntime) => TRuntime,
  ) => void;
}

export interface SessionDevicePollingController {
  activate: () => void;
  cancelSession: (sessionId: string) => void;
  dispose: () => void;
  removeSession: (sessionId: string) => void;
  start: (sessionId: string, connectionId: string) => void;
}

export function createSessionDevicePollingController<TRuntime extends DeviceRuntime>(
  options: SessionDevicePollingControllerOptions<TRuntime>,
): SessionDevicePollingController {
  let active = true;
  const requests = new Map<string, number>();
  const polls = new Map<string, number>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const initialTimers = new Map<string, ReturnType<typeof setTimeout>>();

  const advance = (values: Map<string, number>, sessionId: string) => {
    const next = (values.get(sessionId) ?? 0) + 1;
    values.set(sessionId, next);
    return next;
  };

  const clearTimer = (
    collection: Map<string, ReturnType<typeof setTimeout>>,
    sessionId: string,
  ) => {
    const timer = collection.get(sessionId);
    if (timer !== undefined) {
      clearTimeout(timer);
      collection.delete(sessionId);
    }
  };

  const cancelSession = (sessionId: string) => {
    clearTimer(timers, sessionId);
    clearTimer(initialTimers, sessionId);
    advance(requests, sessionId);
    advance(polls, sessionId);
  };

  const start = (sessionId: string, connectionId: string) => {
    cancelSession(sessionId);
    if (!active) return;
    const pollId = polls.get(sessionId) ?? 0;
    const isCurrent = () => active && polls.get(sessionId) === pollId;
    // 前端时钟仅限制本次首屏等待，曲线时间仍完全使用 Rust 返回的单调时间。
    const initialDeadline = performance.now() + DEVICE_INITIAL_POLL_TIMEOUT_MS;
    const existing = options.getRuntime(sessionId);
    let initialPending = !(
      existing?.connection?.connectionId === connectionId &&
      (existing.deviceStatus !== null || existing.deviceHistory.length > 0)
    );
    const updateLoading = (loading: boolean) => {
      options.updateRuntime(sessionId, (current) => {
        if (!isCurrent() || current.connection?.connectionId !== connectionId) return current;
        const nextLoading = loading && current.deviceStatus === null && current.deviceHistory.length === 0;
        return current.deviceLoading === nextLoading
          ? current
          : { ...current, deviceLoading: nextLoading };
      });
    };
    const finishInitialLoad = () => {
      initialPending = false;
      clearTimer(initialTimers, sessionId);
    };
    updateLoading(initialPending);
    if (initialPending) {
      // 独立超时退出加载态；正在等待的 IPC 不取消也不重叠发起新请求。
      initialTimers.set(sessionId, setTimeout(() => {
        if (!isCurrent()) return;
        finishInitialLoad();
        updateLoading(false);
      }, DEVICE_INITIAL_POLL_TIMEOUT_MS));
    }

    const poll = async () => {
      const requestId = advance(requests, sessionId);
      try {
        const snapshot = await options.getDeviceMetricsSnapshot(connectionId);
        if (
          isCurrent() &&
          requests.get(sessionId) === requestId &&
          snapshot.connectionId === connectionId
        ) {
          // 失败也会产生空值历史点，不能把已完成的失败采样当成仍在等待。
          const hasResult = snapshot.status !== null || snapshot.history.length > 0;
          if (hasResult || performance.now() >= initialDeadline) finishInitialLoad();
          // 缓存 IPC 可能先于 React 提交连接状态；归属校验必须随状态更新一起排队。
          options.updateRuntime(sessionId, (current) => {
            if (
              !isCurrent() ||
              requests.get(sessionId) !== requestId ||
              current.connection?.connectionId !== connectionId ||
              snapshot.windowEndMs < current.deviceWindowEndMs
            ) {
              return current;
            }
            if (!hasResult && (current.deviceStatus !== null || current.deviceHistory.length > 0)) {
              return current;
            }
            // Rust 返回完整的有界历史；直接替换，重复读取或窗口重建不能重复累计。
            return {
              ...current,
              deviceLoading: initialPending,
              deviceStatus: snapshot.status,
              deviceHistory: snapshot.history,
              deviceWindowEndMs: snapshot.windowEndMs,
            };
          });
        }
      } catch {
        // 设备状态属于辅助信息；单次失败继续读缓存，不覆盖连接主错误或旧曲线。
      }
      if (!isCurrent()) return;
      const remainingMs = initialDeadline - performance.now();
      if (initialPending && remainingMs <= 0) {
        finishInitialLoad();
        updateLoading(false);
      }
      const delayMs = initialPending
        ? Math.min(DEVICE_INITIAL_POLL_INTERVAL_MS, remainingMs)
        : options.intervalMs;
      const timer = setTimeout(() => {
        if (!isCurrent()) return;
        timers.delete(sessionId);
        if (options.getRuntime(sessionId)?.connection?.connectionId !== connectionId) {
          cancelSession(sessionId);
          return;
        }
        void poll();
      }, delayMs);
      clearTimer(timers, sessionId);
      timers.set(sessionId, timer);
    };
    void poll();
  };

  return {
    activate: () => {
      active = true;
    },
    cancelSession,
    dispose: () => {
      active = false;
      for (const sessionId of new Set([...requests.keys(), ...polls.keys()])) {
        cancelSession(sessionId);
      }
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      for (const timer of initialTimers.values()) clearTimeout(timer);
      initialTimers.clear();
    },
    removeSession: cancelSession,
    start,
  };
}
