import { describe, expect, it, vi } from "vitest";
import { runTransferWithConflictRetry } from "./transferConflict";

describe("runTransferWithConflictRetry", () => {
  it("在冲突确认后只重试一次覆盖写入", async () => {
    const attempts: boolean[] = [];
    const result = await runTransferWithConflictRetry(
      async (overwrite) => {
        attempts.push(overwrite);
        if (!overwrite) throw new Error("conflict");
        return { status: "completed", value: "ok" };
      },
      {
        isCurrent: () => true,
        isConflict: (error) => error instanceof Error && error.message === "conflict",
        confirmOverwrite: async () => true,
      },
    );

    expect(result).toEqual({ kind: "completed", value: "ok" });
    expect(attempts).toEqual([false, true]);
  });

  it("拒绝覆盖时跳过且不重复调用传输", async () => {
    const attempt = vi.fn(async () => {
      throw new Error("conflict");
    });

    const result = await runTransferWithConflictRetry(attempt, {
      isCurrent: () => true,
      isConflict: () => true,
      confirmOverwrite: async () => false,
    });

    expect(result).toEqual({ kind: "skipped" });
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("连接或会话过期后丢弃迟到结果", async () => {
    let current = true;
    const result = await runTransferWithConflictRetry(
      async () => {
        current = false;
        return { status: "completed", value: "late" };
      },
      {
        isCurrent: () => current,
        isConflict: () => false,
        confirmOverwrite: async () => true,
      },
    );

    expect(result).toEqual({ kind: "cancelled" });
  });

  it("非冲突失败不触发覆盖确认", async () => {
    const confirmOverwrite = vi.fn(async () => true);
    const error = new Error("network");
    const result = await runTransferWithConflictRetry(
      async () => {
        throw error;
      },
      {
        isCurrent: () => true,
        isConflict: () => false,
        confirmOverwrite,
      },
    );

    expect(result).toEqual({ kind: "failed", error });
    expect(confirmOverwrite).not.toHaveBeenCalled();
  });
});
