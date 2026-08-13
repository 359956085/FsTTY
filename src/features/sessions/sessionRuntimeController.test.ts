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

  it("传输替换、取消和移除后旧事件永久失效", () => {
    const controller = createSessionRuntimeController();
    const first = controller.beginTransfer("session-1", "connection-1", "transfer-1");
    expect(
      controller.isTransferCurrent("session-1", "connection-1", "transfer-1", first),
    ).toBe(true);

    const second = controller.beginTransfer("session-1", "connection-1", "transfer-2");
    expect(
      controller.isTransferCurrent("session-1", "connection-1", "transfer-1", first),
    ).toBe(false);
    expect(
      controller.isTransferCurrent("session-1", "connection-1", "transfer-2", second),
    ).toBe(true);

    controller.cancelTransfer("session-1");
    expect(
      controller.isTransferCurrent("session-1", "connection-1", "transfer-2", second),
    ).toBe(false);

    const third = controller.beginTransfer("session-1", "connection-2", "transfer-3");
    controller.removeSession("session-1");
    expect(
      controller.isTransferCurrent("session-1", "connection-2", "transfer-3", third),
    ).toBe(false);
  });

  it("卸载后使文件、设备、批量上传和传输全部失效", () => {
    const controller = createSessionRuntimeController();
    const fileRequest = controller.beginFileRequest("session-1");
    const deviceRequest = controller.beginDeviceRequest("session-1");
    const transfer = controller.beginTransfer(
      "session-1",
      "connection-1",
      "transfer-1",
    );
    controller.startUploadBatch("session-1", "batch-1");

    controller.dispose();

    expect(controller.isFileRequestCurrent("session-1", fileRequest)).toBe(false);
    expect(controller.isDeviceRequestCurrent("session-1", deviceRequest)).toBe(false);
    expect(controller.isUploadBatchCurrent("session-1", "batch-1")).toBe(false);
    expect(
      controller.isTransferCurrent("session-1", "connection-1", "transfer-1", transfer),
    ).toBe(false);

    expect(controller.isActive()).toBe(false);
    expect(controller.startUploadBatch("session-1", "batch-2")).toBe(false);
    controller.activate();
    expect(controller.isActive()).toBe(true);
    expect(controller.startUploadBatch("session-1", "batch-2")).toBe(true);
  });
});
