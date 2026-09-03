import { api } from "../../shared/api/client";
import type {
  LightweightModeState,
  LightweightSnapshotKind,
  LightweightTerminalRequest,
} from "../../shared/api/types";

const SNAPSHOT_CHUNK_BYTES = 192 * 1024;

const DEFAULT_STATE: LightweightModeState = {
  active: false,
  suppressConfirmation: false,
  phase: "normal",
  terminals: [],
  transferJobs: [],
};

export interface LightweightTerminalController {
  cancelPreparation(): void;
  capture(): Promise<{ full: string; viewport: string }>;
  describe(): LightweightTerminalRequest | null;
  isBlocked(): boolean;
  prepareBarrier(): void;
}

let initialState = DEFAULT_STATE;
let transitioning = false;
const controllers = new Map<string, LightweightTerminalController>();
const preservedRuntimeIds = new Set<string>();
const failedRuntimeIds = new Set<string>();
const restoreListeners = new Set<() => void>();
let restoreRevision = 0;

function notifyRestoreChange() {
  restoreRevision += 1;
  restoreListeners.forEach((listener) => listener());
}

export function initializeLightweightMode(state: LightweightModeState) {
  initialState = state;
  transitioning = false;
  preservedRuntimeIds.clear();
  failedRuntimeIds.clear();
  state.terminals.forEach((terminal) => preservedRuntimeIds.add(terminal.runtimeId));
  notifyRestoreChange();
}

export function getInitialLightweightModeState() {
  return initialState;
}

export function getPreservedRuntimeIds() {
  return new Set(preservedRuntimeIds);
}

export function hasPreservedTerminal(runtimeId: string) {
  return preservedRuntimeIds.has(runtimeId);
}

export function markPreservedTerminalAttached(runtimeId: string) {
  if (preservedRuntimeIds.delete(runtimeId)) notifyRestoreChange();
}

export function markPreservedTerminalFailed(runtimeId: string) {
  failedRuntimeIds.add(runtimeId);
  markPreservedTerminalAttached(runtimeId);
}

export function getLightweightRestoreRevision() {
  return restoreRevision;
}

export function subscribeLightweightRestore(listener: () => void) {
  restoreListeners.add(listener);
  return () => { restoreListeners.delete(listener); };
}

export function getValidRestoredRuntimeIds(runtimeIds: Iterable<string>) {
  return [...runtimeIds].filter((id) => !failedRuntimeIds.has(id));
}

export function registerLightweightTerminal(
  runtimeId: string,
  controller: LightweightTerminalController,
) {
  controllers.set(runtimeId, controller);
  return () => {
    if (controllers.get(runtimeId) === controller) {
      controllers.delete(runtimeId);
    }
  };
}

export function isLightweightTransitioning() {
  return transitioning;
}

export async function enterLightweightMode(suppressConfirmation: boolean) {
  if (transitioning) {
    return;
  }
  const currentControllers = [...controllers.values()];
  if (currentControllers.some((controller) => controller.isBlocked())) {
    throw new Error("连接、认证或终端初始化正在进行");
  }
  const active = currentControllers.flatMap((controller) => {
    const terminal = controller.describe();
    return terminal ? [{ controller, terminal }] : [];
  });
  transitioning = true;
  let token: string | null = null;
  let committed = false;
  try {
    active.forEach(({ controller }) => controller.prepareBarrier());
    const result = await api.beginLightweightMode(
      active.map(({ terminal }) => terminal),
      suppressConfirmation,
    );
    token = result.token;
    for (const { controller, terminal } of active) {
      const snapshot = await controller.capture();
      await uploadSnapshot(token, terminal.runtimeId, "full", snapshot.full);
      await uploadSnapshot(token, terminal.runtimeId, "viewport", snapshot.viewport);
    }
    await api.commitLightweightMode(token);
    committed = true;
  } catch (error) {
    if (token) {
      await api.abortLightweightMode(token).catch(() => undefined);
    }
    throw error;
  } finally {
    if (!committed) {
      active.forEach(({ controller }) => controller.cancelPreparation());
      transitioning = false;
    }
  }
}

async function uploadSnapshot(
  token: string,
  runtimeId: string,
  kind: LightweightSnapshotKind,
  snapshot: string,
) {
  const bytes = new TextEncoder().encode(snapshot);
  const totalChunks = Math.max(1, Math.ceil(bytes.byteLength / SNAPSHOT_CHUNK_BYTES));
  for (let index = 0; index < totalChunks; index += 1) {
    const start = index * SNAPSHOT_CHUNK_BYTES;
    const chunk = bytes.subarray(start, start + SNAPSHOT_CHUNK_BYTES);
    await api.appendLightweightSnapshotChunk(
      token,
      runtimeId,
      kind,
      index,
      totalChunks,
      encodeBase64(chunk),
    );
  }
}

function encodeBase64(bytes: Uint8Array) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 32 * 1024) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32 * 1024));
  }
  return btoa(binary);
}
