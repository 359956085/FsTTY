// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import {
  createShellIntegrationCommand,
  createCommandHistoryInsertion,
  parseCommandHistoryOsc,
  type ShellIntegrationDescriptor,
} from "./terminalCommandHistory";

const integration: ShellIntegrationDescriptor = {
  functionName: "__fstty_cwd_token",
  historyFunctionName: "__fstty_history_token",
  token: "token123",
};

describe("terminalCommandHistory", () => {
  it("Bash 和 Zsh 保留现有钩子并携带随机令牌", () => {
    const bash = createShellIntegrationCommand("bash", integration);
    expect(bash).toContain("PROMPT_COMMAND+=");
    expect(bash).toContain("builtin fc -ln -0");
    expect(bash).not.toContain("builtin fc -ln -1");
    expect(bash).not.toContain("HISTCONTROL=");
    expect(bash).toContain("fstty-command:token123");

    const zsh = createShellIntegrationCommand("zsh", integration);
    expect(zsh).toContain("precmd_functions+=(__fstty_cwd_token)");
    expect(zsh).toContain("preexec_functions+=(__fstty_history_token)");
    expect(createShellIntegrationCommand("fish", integration)).toBeNull();
  });

  it("解析有效 Unicode 命令并拒绝伪造、控制字符和内部命令", () => {
    const encode = (value: string) =>
      window.btoa(String.fromCharCode(...new TextEncoder().encode(value)));
    expect(
      parseCommandHistoryOsc(`fstty-command:token123:${encode("echo 中文")}`, integration),
    ).toEqual({ command: "echo 中文", matched: true });
    expect(parseCommandHistoryOsc("fstty-command:other:bHM=", integration).matched).toBe(false);
    expect(
      parseCommandHistoryOsc(`fstty-command:token123:${encode("echo a\nwhoami")}`, integration)
        .command,
    ).toBeNull();
    expect(
      parseCommandHistoryOsc(
        `fstty-command:token123:${encode("builtin cd -- '/tmp'")}`,
        integration,
      ).command,
    ).toBeNull();
  });

  it("损坏 Base64 静默丢弃", () => {
    vi.spyOn(window, "atob").mockImplementationOnce(() => {
      throw new Error("invalid");
    });
    expect(parseCommandHistoryOsc("fstty-command:token123:!", integration)).toEqual({
      command: null,
      matched: true,
    });
  });

  it("选择命令只清空当前行并插入，不发送回车", () => {
    const insertion = createCommandHistoryInsertion("ls -la");
    expect(insertion).toBe("\u0015ls -la");
    expect(insertion).not.toContain("\r");
    expect(insertion).not.toContain("\n");
  });
});
