import { describe, expect, it, vi } from "vitest";
import {
  createTerminalShellIntegration,
  decodeOsc633Value,
  parseOsc7Directory,
  SHELL_OSC_IDENTIFIERS,
} from "./terminalShellIntegration";

function createController() {
  const addHistory = vi.fn().mockResolvedValue(undefined);
  const onDirectoryChange = vi.fn();
  const onHistoryError = vi.fn();
  const send = vi.fn();
  const controller = createTerminalShellIntegration({
    addHistory,
    createToken: () => "0123456789abcdef0123456789abcdef",
    onDirectoryChange,
    onHistoryError,
    send,
  });
  return { addHistory, controller, onDirectoryChange, onHistoryError, send };
}

describe("terminalShellIntegration", () => {
  it("轻量恢复沿用原钩子令牌且绝不向前台程序注入命令", async () => {
    const original = createController();
    original.controller.activate("bash");
    const restored = createController();
    restored.controller.restore(original.controller.snapshotToken());
    expect(restored.controller.activate("bash")).toBe(false);
    restored.controller.handleOsc(
      777, "fstty-cwd:0123456789abcdef0123456789abcdef:/srv/app",
    );
    restored.controller.handleOsc(
      777, "fstty-command:0123456789abcdef0123456789abcdef:ZWNobyBvaw==",
    );
    await Promise.resolve();
    expect(restored.onDirectoryChange).toHaveBeenCalledWith("/srv/app");
    expect(restored.addHistory).toHaveBeenCalledWith("echo ok");
    expect(restored.send).not.toHaveBeenCalled();
  });

  it("无钩子或非法令牌恢复也不会补发初始化文本", () => {
    for (const token of [null, "invalid-token"]) {
      const { controller, send } = createController();
      controller.restore(token);
      expect(controller.activate("bash")).toBe(false);
      expect(controller.snapshotToken()).toBeNull();
      expect(send).not.toHaveBeenCalled();
    }
  });

  it("注册标准协议和受控私有协议", () => {
    expect(SHELL_OSC_IDENTIFIERS).toEqual([7, 133, 633, 777]);
  });

  it("无原生命令能力时 Bash 和 Zsh 每次连接只注入一次", () => {
    for (const shellName of ["bash", "zsh"] as const) {
      const { controller, send } = createController();
      expect(controller.activate(shellName)).toBe(true);
      expect(controller.activate(shellName)).toBe(false);
      expect(send).toHaveBeenCalledOnce();
      expect(send.mock.calls[0]?.[0]).toContain("0123456789abcdef0123456789abcdef");
    }
  });

  it("原生 OSC 633 命令能力存在时不注入", () => {
    const { controller, send } = createController();
    controller.handleOsc(633, "P;HasRichCommandDetection=True");
    expect(controller.activate("bash")).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it("注入发送失败时保持被动模式且不重试", () => {
    const send = vi.fn(() => {
      throw new Error("write failed");
    });
    const controller = createTerminalShellIntegration({
      addHistory: vi.fn().mockResolvedValue(undefined),
      createToken: () => "0123456789abcdef0123456789abcdef",
      onDirectoryChange: vi.fn(),
      onHistoryError: vi.fn(),
      send,
    });
    expect(controller.activate("bash")).toBe(false);
    expect(controller.activate("bash")).toBe(false);
    expect(send).toHaveBeenCalledOnce();
    expect(controller.handleOsc(7, "file://host/srv")).toBe(true);
  });

  it("仅有 OSC 633 目录能力时仍允许注入", () => {
    const { controller, send } = createController();
    controller.handleOsc(633, "P;Cwd=/srv/apps");
    expect(controller.activate("bash")).toBe(true);
    expect(send).toHaveBeenCalledOnce();
  });

  it("重置后允许使用新令牌重新注入", () => {
    const createToken = vi
      .fn()
      .mockReturnValueOnce("0123456789abcdef0123456789abcdef")
      .mockReturnValueOnce("fedcba9876543210fedcba9876543210");
    const send = vi.fn();
    const controller = createTerminalShellIntegration({
      addHistory: vi.fn().mockResolvedValue(undefined),
      createToken,
      onDirectoryChange: vi.fn(),
      onHistoryError: vi.fn(),
      send,
    });
    expect(controller.activate("bash")).toBe(true);
    controller.reset();
    expect(controller.activate("bash")).toBe(true);
    expect(send.mock.calls[0]?.[0]).not.toBe(send.mock.calls[1]?.[0]);
  });

  it("私有协议只接受当前令牌，且每个命令周期最多保存一次", async () => {
    const { addHistory, controller } = createController();
    controller.activate("bash");
    controller.handleOsc(777, "fstty-command:wrong:ZWNobyB3cm9uZw==");
    controller.handleOsc(
      777,
      "fstty-command:0123456789abcdef0123456789abcdef:ZWNobyBvaw==",
    );
    controller.handleOsc(
      777,
      "fstty-command:0123456789abcdef0123456789abcdef:ZWNobyBkdXBsaWNhdGU=",
    );
    controller.handleOsc(777, "fstty-cwd:0123456789abcdef0123456789abcdef:/srv");
    controller.handleOsc(
      777,
      "fstty-command:0123456789abcdef0123456789abcdef:cHdk",
    );
    await vi.waitFor(() => expect(addHistory).toHaveBeenCalledTimes(2));
    expect(addHistory).toHaveBeenNthCalledWith(1, "echo ok");
    expect(addHistory).toHaveBeenNthCalledWith(2, "pwd");
  });

  it("OSC 7 首次上报立即跟随并支持编码路径和不同主机名", () => {
    const { controller, onDirectoryChange } = createController();
    controller.handleOsc(7, "file://ip-172-26-8-238/srv/%E4%B8%AD%E6%96%87");
    expect(onDirectoryChange).toHaveBeenCalledOnce();
    expect(onDirectoryChange).toHaveBeenCalledWith("/srv/中文");
  });

  it("OSC 633 Cwd 首次上报立即跟随", () => {
    const { controller, onDirectoryChange } = createController();
    controller.handleOsc(633, "P;Cwd=/srv/apps");
    expect(onDirectoryChange).toHaveBeenCalledWith("/srv/apps");
  });

  it("拒绝危险或损坏目录", () => {
    expect(parseOsc7Directory("https://host/srv")).toBeNull();
    expect(parseOsc7Directory("file://user@host/srv")).toBeNull();
    expect(parseOsc7Directory("file://host/srv?query=1")).toBeNull();
    expect(parseOsc7Directory("file://host/%ZZ")).toBeNull();
    expect(parseOsc7Directory("file://host/srv\napps")).toBeNull();
    expect(parseOsc7Directory("relative/path")).toBeNull();

    const { controller, onDirectoryChange } = createController();
    controller.handleOsc(633, "P;Cwd=relative/path");
    controller.handleOsc(633, "P;Cwd=/srv\\qbad");
    controller.handleOsc(633, `P;Cwd=/${"a".repeat(4097)}`);
    expect(onDirectoryChange).not.toHaveBeenCalled();
  });

  it("按 OSC 633 生命周期保存明确上报的命令", async () => {
    const { addHistory, controller } = createController();
    controller.handleOsc(633, "A");
    controller.handleOsc(633, "B");
    controller.handleOsc(633, "E;echo 中文\\x3b pwd;nonce");
    controller.handleOsc(633, "C");
    await vi.waitFor(() => expect(addHistory).toHaveBeenCalledWith("echo 中文; pwd"));
    expect(addHistory).toHaveBeenCalledOnce();
  });

  it("重复、乱序和控制字符命令不会写入", async () => {
    const { addHistory, controller } = createController();
    controller.handleOsc(633, "E;before-start");
    controller.handleOsc(633, "B");
    controller.handleOsc(633, "E;first");
    controller.handleOsc(633, "E;second");
    controller.handleOsc(633, "C");
    controller.handleOsc(633, "C");
    controller.handleOsc(633, "B");
    controller.handleOsc(633, "E;echo\\x0abad");
    controller.handleOsc(633, "C");
    await vi.waitFor(() => expect(addHistory).toHaveBeenCalledOnce());
    expect(addHistory).toHaveBeenCalledWith("first");
  });

  it("OSC 133 仅维护生命周期，不采集命令", async () => {
    const { addHistory, controller } = createController();
    controller.handleOsc(133, "A");
    controller.handleOsc(133, "B");
    controller.handleOsc(133, "E;echo should-not-save");
    controller.handleOsc(133, "C");
    await Promise.resolve();
    expect(addHistory).not.toHaveBeenCalled();
  });

  it("重置会丢弃未完成命令周期", async () => {
    const { addHistory, controller } = createController();
    controller.handleOsc(633, "B");
    controller.handleOsc(633, "E;echo stale");
    controller.reset();
    controller.handleOsc(633, "C");
    await Promise.resolve();
    expect(addHistory).not.toHaveBeenCalled();
  });

  it("历史保存失败只报告错误，后续命令继续串行保存", async () => {
    const addHistory = vi
      .fn()
      .mockRejectedValueOnce(new Error("failed"))
      .mockResolvedValueOnce(undefined);
    const onHistoryError = vi.fn();
    const controller = createTerminalShellIntegration({
      addHistory,
      onDirectoryChange: vi.fn(),
      onHistoryError,
      send: vi.fn(),
    });
    for (const command of ["first", "second"]) {
      controller.handleOsc(633, "B");
      controller.handleOsc(633, `E;${command}`);
      controller.handleOsc(633, "C");
    }
    await vi.waitFor(() => expect(addHistory).toHaveBeenCalledTimes(2));
    expect(onHistoryError).toHaveBeenCalledOnce();
  });

  it("OSC 633 转义严格解码", () => {
    expect(decodeOsc633Value("echo\\x20a\\x3bb\\\\c")).toBe("echo a;b\\c");
    expect(decodeOsc633Value("bad\\q")).toBeNull();
    expect(decodeOsc633Value("bad\\xzz")).toBeNull();
    expect(decodeOsc633Value("bad\\xff")).toBeNull();
  });
});
