import { describe, expect, it } from "vitest";
import { createSessionRuntimeController } from "./sessionRuntimeController";

describe("会话运行时控制器", () => {
  it("移除后重开会话不会复用旧文件请求代次", () => {
    const controller = createSessionRuntimeController();
    const staleRequest = controller.beginFileRequest("session-1");

    controller.removeSession("session-1");
    const currentRequest = controller.beginFileRequest("session-1");

    expect(currentRequest).toBeGreaterThan(staleRequest);
    expect(controller.isFileRequestCurrent("session-1", staleRequest)).toBe(false);
  });
});
