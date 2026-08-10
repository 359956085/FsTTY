import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTerminalShellIntegration,
  SHELL_OSC_IDENTIFIER,
} from "./terminalShellIntegration";

describe("terminalShellIntegration", () => {
  beforeEach(() => {
    vi.stubGlobal("crypto", { randomUUID: () => "12345678-1234-1234-1234-123456789abc" });
  });

  it("完成 Shell 探测、目录上报和安全目录切换", () => {
    const send = vi.fn();
    const onDirectoryChange = vi.fn();
    const controller = createTerminalShellIntegration({
      addHistory: vi.fn().mockResolvedValue(undefined),
      onDirectoryChange,
      onHistoryError: vi.fn(),
      send,
    });
    controller.start();
    expect(send).toHaveBeenCalledWith(expect.stringContaining(`]${SHELL_OSC_IDENTIFIER};fstty-shell:`));
    controller.handleOsc("fstty-shell:12345678123412341234123456789abc:/bin/bash");
    expect(send).toHaveBeenLastCalledWith(expect.stringContaining("PROMPT_COMMAND"));
    controller.handleOsc("fstty-cwd:12345678123412341234123456789abc:/srv/apps");
    expect(onDirectoryChange).toHaveBeenCalledWith("/srv/apps");
    expect(controller.requestDirectory("/srv/logs")).toBe(true);
    expect(send).toHaveBeenLastCalledWith(" builtin cd -- '/srv/logs'\r");
  });

  it("用户输入、无效路径和重置会阻止自动切换", () => {
    const controller = createTerminalShellIntegration({
      addHistory: vi.fn().mockResolvedValue(undefined),
      onDirectoryChange: vi.fn(),
      onHistoryError: vi.fn(),
      send: vi.fn(),
    });
    controller.start();
    controller.handleOsc("fstty-shell:12345678123412341234123456789abc:/bin/bash");
    controller.handleOsc("fstty-cwd:12345678123412341234123456789abc:/srv/apps");
    controller.markInput();
    expect(controller.requestDirectory("/srv/logs")).toBe(false);
    controller.handleOsc("fstty-cwd:12345678123412341234123456789abc:/srv/apps");
    expect(controller.requestDirectory("relative/path")).toBe(false);
    controller.reset();
    expect(controller.requestDirectory("/srv/logs")).toBe(false);
  });
});
