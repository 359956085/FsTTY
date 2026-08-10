// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import {
  createCommandHistoryInsertion,
  createShellIntegrationCommand,
  parseCommandHistoryOsc,
  type ShellIntegrationDescriptor,
} from "./terminalCommandHistory";

const integration: ShellIntegrationDescriptor = {
  functionName: "__fstty_cwd_0123456789abcdef",
  historyFunctionName: "__fstty_command_0123456789abcdef",
  token: "0123456789abcdef0123456789abcdef",
};

describe("terminalCommandHistory", () => {
  it("选择命令只清空当前行并插入，不发送回车", () => {
    const insertion = createCommandHistoryInsertion("ls -la");
    expect(insertion).toBe("\u0015ls -la");
    expect(insertion).not.toContain("\r");
    expect(insertion).not.toContain("\n");
  });

  it("Bash 只删除精确令牌命中的当前历史并保留 PROMPT_COMMAND", () => {
    const command = createShellIntegrationCommand("bash", integration);
    expect(command).toContain("builtin history 1");
    expect(command).toContain(integration.token);
    expect(command).toContain('builtin history -d "${BASH_REMATCH[1]}"');
    expect(command).toContain("PROMPT_COMMAND");
    expect(command).not.toContain("history -w");
    expect(command).not.toContain("HISTFILE");
  });

  it("Zsh 只清理内存历史并保留既有钩子", () => {
    const command = createShellIntegrationCommand("zsh", integration);
    expect(command).toContain("zmodload zsh/parameter");
    expect(command).toContain('unset "history[$__fstty_hist_id]"');
    expect(command).toContain("precmd_functions+=(");
    expect(command).toContain("preexec_functions+=(");
    expect(command).not.toContain("HISTFILE");
    expect(command).not.toContain("fc -W");
  });

  it("私有命令协议严格校验令牌、Base64、控制字符和内部命令", () => {
    const encode = (value: string) => window.btoa(unescape(encodeURIComponent(value)));
    expect(
      parseCommandHistoryOsc(
        `fstty-command:${integration.token}:${encode("echo 中文")}`,
        integration,
      ),
    ).toEqual({ command: "echo 中文", matched: true });
    expect(parseCommandHistoryOsc("fstty-command:wrong:ZWNobyBvaw==", integration)).toEqual({
      command: null,
      matched: false,
    });
    for (const value of ["%%%", encode("echo\nunsafe"), encode(`echo ${integration.token}`)]) {
      expect(
        parseCommandHistoryOsc(
          `fstty-command:${integration.token}:${value}`,
          integration,
        ),
      ).toEqual({ command: null, matched: true });
    }
    const oversized = window.btoa("a".repeat(64 * 1024 + 1));
    expect(
      parseCommandHistoryOsc(
        `fstty-command:${integration.token}:${oversized}`,
        integration,
      ),
    ).toEqual({ command: null, matched: true });
  });
});
