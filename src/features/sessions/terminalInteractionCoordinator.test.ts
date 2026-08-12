import { describe, expect, it } from "vitest";
import { createTerminalInteractionCoordinator } from "./terminalInteractionCoordinator";

describe("终端交互协调器", () => {
  it("拦截重复提交并使取消后的旧结果失效", () => {
    const coordinator = createTerminalInteractionCoordinator();
    const generation = coordinator.begin("credential");

    expect(generation).not.toBeNull();
    expect(coordinator.begin("credential")).toBeNull();
    coordinator.cancel("credential");
    expect(coordinator.isCurrent("credential", generation!)).toBe(false);
    expect(coordinator.begin("credential")).not.toBeNull();
  });

  it("销毁后拒绝所有交互结果", () => {
    const coordinator = createTerminalInteractionCoordinator();
    const generation = coordinator.begin("trustHost")!;
    coordinator.dispose();

    expect(coordinator.isCurrent("trustHost", generation)).toBe(false);
    expect(coordinator.finish("trustHost", generation)).toBe(false);
    expect(coordinator.begin("trustHost")).toBeNull();
  });
});
