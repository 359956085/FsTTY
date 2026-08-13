import type { DeviceStatus, SshConnection } from "../../shared/api/types";
import {
  appendDeviceMetricSample,
  type DeviceMetricSample,
  type DeviceNetworkCounterSample,
} from "./deviceMetrics";

interface DeviceRuntime {
  connection: SshConnection | null;
  deviceStatus: DeviceStatus | null;
  deviceHistory: DeviceMetricSample[];
}

interface SessionDevicePollingControllerOptions<TRuntime extends DeviceRuntime> {
  getDeviceStatus: (connectionId: string) => Promise<DeviceStatus>;
  getRuntime: (sessionId: string) => TRuntime | undefined;
  intervalMs: number;
  now?: () => number;
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
  const counters = new Map<string, DeviceNetworkCounterSample>();

  const advance = (values: Map<string, number>, sessionId: string) => {
    const next = (values.get(sessionId) ?? 0) + 1;
    values.set(sessionId, next);
    return next;
  };

  const clearTimer = (sessionId: string) => {
    const timer = timers.get(sessionId);
    if (timer !== undefined) {
      clearTimeout(timer);
      timers.delete(sessionId);
    }
  };

  const cancelSession = (sessionId: string) => {
    clearTimer(sessionId);
    advance(requests, sessionId);
    advance(polls, sessionId);
    counters.delete(sessionId);
  };

  const load = async (sessionId: string, connectionId: string) => {
    const requestId = advance(requests, sessionId);
    try {
      const deviceStatus = await options.getDeviceStatus(connectionId);
      const runtime = options.getRuntime(sessionId);
      if (
        !active ||
        requests.get(sessionId) !== requestId ||
        runtime?.connection?.connectionId !== connectionId
      ) {
        return;
      }
      const sample = appendDeviceMetricSample(
        runtime.deviceHistory,
        deviceStatus,
        (options.now ?? performance.now.bind(performance))(),
        counters.get(sessionId) ?? null,
      );
      if (sample.networkCounter) counters.set(sessionId, sample.networkCounter);
      else counters.delete(sessionId);
      options.updateRuntime(sessionId, (current) => ({
        ...current,
        deviceStatus,
        deviceHistory: sample.history,
      }));
    } catch {
      // 设备状态属于辅助信息；单次失败等待下一轮，不覆盖连接主错误。
    }
  };

  const start = (sessionId: string, connectionId: string) => {
    cancelSession(sessionId);
    if (!active) return;
    const pollId = polls.get(sessionId) ?? 0;
    const poll = async () => {
      await load(sessionId, connectionId);
      if (
        !active ||
        polls.get(sessionId) !== pollId ||
        options.getRuntime(sessionId)?.connection?.connectionId !== connectionId
      ) {
        return;
      }
      const timer = setTimeout(() => {
        timers.delete(sessionId);
        void poll();
      }, options.intervalMs);
      clearTimer(sessionId);
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
      counters.clear();
    },
    removeSession: cancelSession,
    start,
  };
}
