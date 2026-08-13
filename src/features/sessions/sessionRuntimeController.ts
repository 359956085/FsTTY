import type { DeviceNetworkCounterSample } from "./deviceMetrics";

export interface SessionRuntimeController {
  activate: () => void;
  beginTransfer: (sessionId: string, connectionId: string, transferId: string) => number;
  beginDeviceRequest: (sessionId: string) => number;
  beginFileRequest: (sessionId: string) => number;
  cancelFileRequest: (sessionId: string) => void;
  cancelUploadBatch: (sessionId: string) => void;
  cancelTransfer: (sessionId: string) => void;
  clearDeviceTimer: (sessionId: string) => void;
  deleteDeviceCounter: (sessionId: string) => void;
  dispose: () => void;
  endUploadBatch: (sessionId: string, token: string) => boolean;
  getDeviceCounter: (sessionId: string) => DeviceNetworkCounterSample | null;
  hasUploadBatch: (sessionId: string) => boolean;
  isDevicePollCurrent: (sessionId: string, pollId: number) => boolean;
  isDeviceRequestCurrent: (sessionId: string, requestId: number) => boolean;
  isFileRequestCurrent: (sessionId: string, requestId: number) => boolean;
  isUploadBatchCurrent: (sessionId: string, token: string) => boolean;
  isTransferCurrent: (
    sessionId: string,
    connectionId: string,
    transferId: string,
    generation: number,
  ) => boolean;
  isActive: () => boolean;
  removeSession: (sessionId: string) => void;
  setDeviceCounter: (
    sessionId: string,
    counter: DeviceNetworkCounterSample,
  ) => void;
  setDeviceTimer: (sessionId: string, timer: number) => void;
  startDevicePoll: (sessionId: string) => number;
  startUploadBatch: (sessionId: string, token: string) => boolean;
  stopDevicePoll: (sessionId: string) => void;
}

export function createSessionRuntimeController(): SessionRuntimeController {
  let active = true;
  const fileRequests = new Map<string, number>();
  const deviceRequests = new Map<string, number>();
  const devicePolls = new Map<string, number>();
  const deviceTimers = new Map<string, number>();
  const deviceCounters = new Map<string, DeviceNetworkCounterSample>();
  const uploadBatches = new Map<string, string>();
  const transferGenerations = new Map<string, number>();
  const activeTransfers = new Map<
    string,
    { connectionId: string; transferId: string; generation: number }
  >();

  const advance = (values: Map<string, number>, sessionId: string) => {
    const next = (values.get(sessionId) ?? 0) + 1;
    values.set(sessionId, next);
    return next;
  };

  const clearDeviceTimer = (sessionId: string) => {
    const timer = deviceTimers.get(sessionId);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      deviceTimers.delete(sessionId);
    }
  };

  const stopDevicePoll = (sessionId: string) => {
    clearDeviceTimer(sessionId);
    advance(deviceRequests, sessionId);
    advance(devicePolls, sessionId);
    deviceCounters.delete(sessionId);
  };

  const cancelTransfer = (sessionId: string) => {
    advance(transferGenerations, sessionId);
    activeTransfers.delete(sessionId);
  };

  const removeSession = (sessionId: string) => {
    clearDeviceTimer(sessionId);
    // 保留递增后的墓碑，避免同一会话快速重开时旧请求编号与新请求碰撞。
    advance(fileRequests, sessionId);
    advance(deviceRequests, sessionId);
    advance(devicePolls, sessionId);
    deviceCounters.delete(sessionId);
    uploadBatches.delete(sessionId);
    cancelTransfer(sessionId);
  };

  return {
    activate: () => {
      active = true;
    },
    beginTransfer: (sessionId, connectionId, transferId) => {
      const generation = advance(transferGenerations, sessionId);
      if (active) activeTransfers.set(sessionId, { connectionId, transferId, generation });
      return generation;
    },
    beginDeviceRequest: (sessionId) => advance(deviceRequests, sessionId),
    beginFileRequest: (sessionId) => advance(fileRequests, sessionId),
    cancelFileRequest: (sessionId) => {
      advance(fileRequests, sessionId);
    },
    cancelUploadBatch: (sessionId) => {
      uploadBatches.delete(sessionId);
    },
    cancelTransfer,
    clearDeviceTimer,
    deleteDeviceCounter: (sessionId) => {
      deviceCounters.delete(sessionId);
    },
    dispose: () => {
      active = false;
      // 递增代次而非只清空映射，确保卸载前启动的异步结果永久失效。
      for (const sessionId of fileRequests.keys()) advance(fileRequests, sessionId);
      for (const sessionId of deviceRequests.keys()) advance(deviceRequests, sessionId);
      for (const timer of deviceTimers.values()) window.clearTimeout(timer);
      deviceTimers.clear();
      devicePolls.clear();
      deviceCounters.clear();
      uploadBatches.clear();
      for (const sessionId of transferGenerations.keys()) cancelTransfer(sessionId);
      activeTransfers.clear();
    },
    endUploadBatch: (sessionId, token) => {
      if (uploadBatches.get(sessionId) !== token) return false;
      uploadBatches.delete(sessionId);
      return true;
    },
    getDeviceCounter: (sessionId) => deviceCounters.get(sessionId) ?? null,
    hasUploadBatch: (sessionId) => uploadBatches.has(sessionId),
    isDevicePollCurrent: (sessionId, pollId) => active && devicePolls.get(sessionId) === pollId,
    isDeviceRequestCurrent: (sessionId, requestId) =>
      active && deviceRequests.get(sessionId) === requestId,
    isFileRequestCurrent: (sessionId, requestId) =>
      active && fileRequests.get(sessionId) === requestId,
    isUploadBatchCurrent: (sessionId, token) =>
      active && uploadBatches.get(sessionId) === token,
    isTransferCurrent: (sessionId, connectionId, transferId, generation) => {
      const transfer = activeTransfers.get(sessionId);
      return active && Boolean(
        transfer?.connectionId === connectionId &&
        transfer.transferId === transferId &&
        transfer.generation === generation
      );
    },
    isActive: () => active,
    removeSession,
    setDeviceCounter: (sessionId, counter) => {
      deviceCounters.set(sessionId, counter);
    },
    setDeviceTimer: (sessionId, timer) => {
      clearDeviceTimer(sessionId);
      deviceTimers.set(sessionId, timer);
    },
    startDevicePoll: (sessionId) => {
      stopDevicePoll(sessionId);
      return devicePolls.get(sessionId) ?? 0;
    },
    startUploadBatch: (sessionId, token) => {
      if (!active || uploadBatches.has(sessionId)) return false;
      uploadBatches.set(sessionId, token);
      return true;
    },
    stopDevicePoll,
  };
}
