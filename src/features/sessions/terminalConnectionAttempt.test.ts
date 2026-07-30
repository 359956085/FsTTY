import { describe, expect, it } from "vitest";
import { createTerminalConnectionAttemptGuard } from "./terminalConnectionAttempt";

describe("createTerminalConnectionAttemptGuard", () => {
  it("新连接会使旧连接结果失效", () => {
    const guard = createTerminalConnectionAttemptGuard();
    const first = guard.begin();
    const second = guard.begin();

    expect(guard.isCurrent(first)).toBe(false);
    expect(guard.isCurrent(second)).toBe(true);
  });

  it("主动失效后拒绝当前连接结果", () => {
    const guard = createTerminalConnectionAttemptGuard();
    const attempt = guard.begin();

    guard.invalidate();

    expect(guard.isCurrent(attempt)).toBe(false);
  });
});
