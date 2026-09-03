// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import type { TransferConflictDecision, TransferJobSummary } from "../../shared/api/types";
import { createTransferJobSubscription } from "./sessionTransferJob";
import { createRuntime } from "./useSessionConnections";

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class { onmessage = vi.fn(); },
}));

const job: TransferJobSummary = {
  jobId: "job", runtimeId: "runtime", connectionId: "connection", direction: "upload",
  fileName: "first.txt", batchIndex: 1, batchTotal: 2, transferredBytes: 0, totalBytes: 100,
  state: "waitingForConflict", uploaded: 0, failed: 0, skipped: 0, message: null,
};

function setup() {
  let runtime = createRuntime();
  const current = { value: true };
  const onConflict = vi.fn<(job: TransferJobSummary) => Promise<TransferConflictDecision>>()
    .mockResolvedValue("overwrite");
  const resolveConflict = vi.fn<(id: string, decision: TransferConflictDecision) => Promise<void>>()
    .mockResolvedValue(undefined);
  const onTerminal = vi.fn();
  const subscription = createTransferJobSubscription({
    jobId: job.jobId, runtimeId: job.runtimeId, connectionId: job.connectionId,
    isCurrent: () => current.value, onConflict, onTerminal, resolveConflict,
    resolveError: () => "失败", updateRuntime: (_id, update) => { runtime = update(runtime); },
  });
  return { subscription, onConflict, resolveConflict, onTerminal, current, runtime: () => runtime };
}

describe("后台传输订阅", () => {
  it("下一批冲突早于上一决定回包时仍继续弹出确认", async () => {
    const { subscription, onConflict, resolveConflict } = setup();
    let acknowledge!: () => void;
    resolveConflict.mockImplementationOnce(async () => {
      subscription.channel.onmessage({ kind: "updated", job: { ...job, state: "running" } });
      subscription.channel.onmessage({ kind: "updated", job: { ...job, batchIndex: 2, fileName: "second.txt" } });
      await new Promise<void>((resolve) => { acknowledge = resolve; });
    });
    const first = subscription.apply(job);
    await Promise.resolve();
    expect(onConflict).toHaveBeenCalledOnce();
    acknowledge();
    await first;
    await Promise.resolve();
    expect(onConflict).toHaveBeenCalledTimes(2);
    expect(resolveConflict).toHaveBeenCalledTimes(2);
  });

  it("同一冲突只确认一次，任务结束后忽略迟到摘要", async () => {
    const { subscription, onConflict, onTerminal, runtime } = setup();
    await subscription.apply(job);
    await subscription.apply(job);
    expect(onConflict).toHaveBeenCalledOnce();
    await subscription.apply({ ...job, state: "completed", transferredBytes: 100 });
    await subscription.apply({ ...job, state: "running" });
    expect(runtime().transfer?.state).toBe("completed");
    expect(runtime().transfer?.transferredBytes).toBe(100);
    expect(onTerminal).toHaveBeenCalledOnce();
  });

  it("确认期间任务已取消时不再提交旧决定", async () => {
    const { subscription, onConflict, resolveConflict } = setup();
    let decide!: (value: TransferConflictDecision) => void;
    onConflict.mockReturnValueOnce(new Promise((resolve) => { decide = resolve; }));
    const pending = subscription.apply(job);
    await subscription.apply({ ...job, state: "cancelled" });
    decide("overwrite");
    await pending;
    expect(resolveConflict).not.toHaveBeenCalled();
  });

  it("旧批次进度以及卸载后的事件不能回退新状态", async () => {
    const { subscription, current, runtime } = setup();
    await subscription.apply({ ...job, state: "running", batchIndex: 2, fileName: "second.txt" });
    await subscription.apply({ ...job, state: "running" });
    expect(runtime().transfer?.fileName).toBe("second.txt");
    current.value = false;
    await subscription.apply({ ...job, state: "failed", batchIndex: 2, message: "迟到失败" });
    expect(runtime().error).toBeNull();
    expect(runtime().transfer?.state).toBe("running");
  });
});
