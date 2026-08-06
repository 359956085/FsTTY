import { describe, expect, it } from "vitest";
import { createLatestRequestGuard } from "./latestRequest";

describe("createLatestRequestGuard", () => {
  it("只接受最新请求并可在关闭或卸载时整体失效", () => {
    const guard = createLatestRequestGuard();
    const first = guard.begin();
    const second = guard.begin();

    expect(guard.isCurrent(first)).toBe(false);
    expect(guard.isCurrent(second)).toBe(true);

    guard.invalidate();
    expect(guard.isCurrent(second)).toBe(false);
  });
});
