const SHELL_OSC_IDENTIFIER = 777;
const MAX_COMMAND_BYTES = 64 * 1024;

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
  shellName: string | undefined,
  integration: ShellIntegrationDescriptor,
) {
  const directoryReport = `printf '\\033]${SHELL_OSC_IDENTIFIER};fstty-cwd:${integration.token}:%s\\007' "$PWD"`;
  const commandReport = `printf '\\033]${SHELL_OSC_IDENTIFIER};fstty-command:${integration.token}:%s\\007' "$(printf '%s' "$__fstty_command" | command base64 | command tr -d '\\n')"`;
  const toolsAvailable = "command -v base64 >/dev/null 2>&1 && command -v tr >/dev/null 2>&1";

  if (shellName === "bash") {
    return ` ${integration.functionName}(){ local __fstty_status=$? __fstty_command; if ${toolsAvailable} && [[ \${HISTCMD:-0} -gt \${__fstty_last_histcmd:-0} ]]; then __fstty_command="$(builtin fc -ln -0 2>/dev/null)"; __fstty_command="\${__fstty_command#"\${__fstty_command%%[![:space:]]*}"}"; [[ -n "$__fstty_command" ]] && ${commandReport}; fi; __fstty_last_histcmd=\${HISTCMD:-0}; ${directoryReport}; return $__fstty_status; }; __fstty_last_histcmd=\${HISTCMD:-0}; case "$(declare -p PROMPT_COMMAND 2>/dev/null)" in "declare -a"*) PROMPT_COMMAND+=(${integration.functionName});; *) PROMPT_COMMAND="${integration.functionName}\${PROMPT_COMMAND:+;$PROMPT_COMMAND}";; esac\r`;
  }
  if (shellName === "zsh") {
    return ` ${integration.functionName}(){ ${directoryReport}; }; ${integration.historyFunctionName}(){ local __fstty_command="$1"; if [[ -n "$__fstty_command" ]] && ${toolsAvailable}; then ${commandReport}; fi; }; precmd_functions+=(${integration.functionName}); preexec_functions+=(${integration.historyFunctionName})\r`;
  }
  return null;
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
    const binary = window.atob(data.slice(prefix.length));
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
  const trimmed = command.trimStart();
  return (
    command.includes(integration.token) ||
    command.includes(integration.functionName) ||
    command.includes(integration.historyFunctionName) ||
    trimmed.startsWith("builtin cd -- ")
  );
}
