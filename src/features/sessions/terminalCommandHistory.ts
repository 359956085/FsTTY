const SHELL_OSC_IDENTIFIER = 777;
const MAX_COMMAND_BYTES = 64 * 1024;

export type ManagedShellName = "bash" | "zsh";

export interface ShellIntegrationDescriptor {
  functionName: string;
  historyFunctionName: string;
  token: string;
}

export interface CommandHistoryOscResult {
  command: string | null;
  matched: boolean;
}

export function createCommandHistoryInsertion(command: string) {
  return `\u0015${command}`;
}

export function createShellIntegrationCommand(
  shellName: ManagedShellName,
  integration: ShellIntegrationDescriptor,
) {
  const directoryReport = `printf '\\033]${SHELL_OSC_IDENTIFIER};fstty-cwd:${integration.token}:%s\\007' "$PWD"`;
  const readyReport = `printf '\\033]${SHELL_OSC_IDENTIFIER};fstty-ready:${integration.token}\\007'`;
  const commandReport = `printf '\\033]${SHELL_OSC_IDENTIFIER};fstty-command:${integration.token}:%s\\007' "$(printf '%s' "$__fstty_command" | command base64 | command tr -d '\\n')"`;
  const toolsAvailable =
    "command -v base64 >/dev/null 2>&1 && command -v tr >/dev/null 2>&1";

  if (shellName === "bash") {
    // 仅删除包含本次随机令牌的当前历史项；匹配失败时不碰任何用户命令。
    const cleanup = `__fstty_entry="$(HISTTIMEFORMAT= builtin history 1 2>/dev/null)"; if [[ "$__fstty_entry" == *'${integration.token}'* && "$__fstty_entry" =~ ^[[:space:]]*([0-9]+)[[:space:]] ]]; then builtin history -d "\${BASH_REMATCH[1]}"; fi; unset __fstty_entry`;
    return ` ${integration.functionName}(){ local __fstty_status=$? __fstty_command; if [[ \${HISTCMD:-0} -gt \${__fstty_last_histcmd:-0} ]] && ${toolsAvailable}; then __fstty_command="$(builtin fc -ln -0 2>/dev/null)"; __fstty_command="\${__fstty_command#"\${__fstty_command%%[![:space:]]*}"}"; [[ -n "$__fstty_command" ]] && ${commandReport}; fi; __fstty_last_histcmd=\${HISTCMD:-0}; ${directoryReport}; return $__fstty_status; }; case "$(declare -p PROMPT_COMMAND 2>/dev/null)" in "declare -a"*) PROMPT_COMMAND=(${integration.functionName} "\${PROMPT_COMMAND[@]}");; *) PROMPT_COMMAND="${integration.functionName}\${PROMPT_COMMAND:+;$PROMPT_COMMAND}";; esac; ${cleanup}; __fstty_last_histcmd=\${HISTCMD:-0}; ${directoryReport}; ${readyReport}\r`;
  }

  // Zsh 只清理当前进程内存历史。禁止写 HISTFILE，避免破坏 SHARE_HISTORY 等用户策略。
  const cleanup = `zmodload zsh/parameter 2>/dev/null; typeset __fstty_hist_id; for __fstty_hist_id in \${(k)history}; do [[ "\${history[$__fstty_hist_id]}" == *'${integration.token}'* ]] && unset "history[$__fstty_hist_id]"; done; unset __fstty_hist_id`;
  return ` ${integration.functionName}(){ ${directoryReport}; }; ${integration.historyFunctionName}(){ local __fstty_command="$1"; if [[ -n "$__fstty_command" ]] && ${toolsAvailable}; then ${commandReport}; fi; }; precmd_functions+=(${integration.functionName}); preexec_functions+=(${integration.historyFunctionName}); ${cleanup}; ${directoryReport}; ${readyReport}\r`;
}

export function parseCommandHistoryOsc(
  data: string,
  integration: ShellIntegrationDescriptor,
): CommandHistoryOscResult {
  const prefix = `fstty-command:${integration.token}:`;
  if (!data.startsWith(prefix)) {
    return { command: null, matched: false };
  }
  try {
    const binary = globalThis.atob(data.slice(prefix.length));
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_COMMAND_BYTES) {
      return { command: null, matched: true };
    }
    const command = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (
      command.trim().length === 0 ||
      Array.from(command).some(isControlCharacter) ||
      isInternalCommand(command, integration)
    ) {
      return { command: null, matched: true };
    }
    return { command, matched: true };
  } catch {
    return { command: null, matched: true };
  }
}

function isControlCharacter(character: string) {
  const codePoint = character.codePointAt(0) ?? 0;
  return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
}

function isInternalCommand(command: string, integration: ShellIntegrationDescriptor) {
  return (
    command.includes(integration.token) ||
    command.includes(integration.functionName) ||
    command.includes(integration.historyFunctionName)
  );
}
