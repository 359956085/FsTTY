import {
  createShellIntegrationCommand,
  parseCommandHistoryOsc,
  type ManagedShellName,
  type ShellIntegrationDescriptor,
} from "./terminalCommandHistory";
import { isValidRemotePath } from "./terminalProtocol";

export const SHELL_OSC_IDENTIFIERS = [7, 133, 633, 777] as const;

type ShellOscIdentifier = (typeof SHELL_OSC_IDENTIFIERS)[number];
type ShellPhase = "idle" | "prompt" | "commandLine" | "executing";

interface TerminalShellIntegrationOptions {
  addHistory: (command: string) => Promise<void>;
  createToken?: () => string;
  onDirectoryChange: (path: string) => void;
  onHistoryError: (error: unknown) => void;
  send: (data: string) => void;
}

const MAX_COMMAND_BYTES = 64 * 1024;

export function createTerminalShellIntegration(options: TerminalShellIntegrationOptions) {
  let phase: ShellPhase = "idle";
  let pendingCommand: string | null = null;
  let historyWriteChain = Promise.resolve();
  let nativeCommandCapability = false;
  let managedAttempted = false;
  let managedIntegration: ShellIntegrationDescriptor | null = null;
  let managedCommandSaved = false;

  const resetCommand = (nextPhase: ShellPhase) => {
    phase = nextPhase;
    pendingCommand = null;
  };

  const reportDirectory = (path: string | null) => {
    if (path && isValidRemotePath(path)) {
      options.onDirectoryChange(path);
    }
  };

  const saveCommand = (command: string | null) => {
    if (!command) return;
    historyWriteChain = historyWriteChain
      .then(() => options.addHistory(command))
      .catch(options.onHistoryError);
  };

  const savePendingCommand = () => {
    const command = pendingCommand;
    pendingCommand = null;
    saveCommand(command);
  };

  const handleLifecycle = (data: string, supportsCommand: boolean) => {
    if (data === "A") {
      resetCommand("prompt");
      return;
    }
    if (data === "B") {
      resetCommand("commandLine");
      return;
    }
    if (data === "C") {
      if (phase === "commandLine") savePendingCommand();
      phase = "executing";
      return;
    }
    if (data === "D" || data.startsWith("D;")) {
      resetCommand("idle");
      return;
    }
    if (!supportsCommand || phase !== "commandLine" || pendingCommand !== null) return;
    pendingCommand = parseOsc633Command(data);
  };

  const handleManagedOsc = (data: string) => {
    const integration = managedIntegration;
    if (!integration) return;
    const directoryPrefix = `fstty-cwd:${integration.token}:`;
    if (data.startsWith(directoryPrefix)) {
      managedCommandSaved = false;
      reportDirectory(data.slice(directoryPrefix.length));
      return;
    }
    if (data === `fstty-ready:${integration.token}`) return;
    const parsed = parseCommandHistoryOsc(data, integration);
    if (!parsed.matched || managedCommandSaved) return;
    managedCommandSaved = true;
    saveCommand(parsed.command);
  };

  return {
    snapshotToken() {
      return managedIntegration?.token ?? null;
    },
    restore(token: string | null | undefined) {
      // 远端钩子仍在运行；恢复只接回原令牌，禁止向 Vim 等前台程序重新注入命令。
      managedAttempted = true;
      if (token && /^[a-f0-9]{32}$/i.test(token)) {
        const suffix = token.slice(0, 16);
        managedIntegration = {
          functionName: `__fstty_cwd_${suffix}`,
          historyFunctionName: `__fstty_command_${suffix}`,
          token,
        };
      }
    },
    activate(shellName: ManagedShellName | null | undefined) {
      if (!shellName || nativeCommandCapability || managedAttempted) return false;
      managedAttempted = true;
      try {
        const token = (options.createToken ?? createRandomToken)();
        if (!/^[a-f0-9]{32}$/i.test(token)) return false;
        const suffix = token.slice(0, 16);
        const integration = {
          functionName: `__fstty_cwd_${suffix}`,
          historyFunctionName: `__fstty_command_${suffix}`,
          token,
        };
        managedIntegration = integration;
        managedCommandSaved = false;
        options.send(createShellIntegrationCommand(shellName, integration));
        return true;
      } catch {
        managedIntegration = null;
        return false;
      }
    },
    handleOsc(identifier: ShellOscIdentifier, data: string) {
      if (identifier === 7) {
        reportDirectory(parseOsc7Directory(data));
      } else if (identifier === 133) {
        handleLifecycle(data, false);
      } else if (identifier === 633) {
        if (data.startsWith("P;Cwd=")) {
          reportDirectory(decodeOsc633Value(data.slice("P;Cwd=".length)));
        } else {
          if (
            data === "A" ||
            data === "B" ||
            data === "C" ||
            data === "D" ||
            data.startsWith("D;") ||
            data.startsWith("E;") ||
            data === "P;HasRichCommandDetection=True"
          ) {
            nativeCommandCapability = true;
          }
          // 受控钩子启用后，命令只从带随机令牌的私有协议采集，避免双写。
          handleLifecycle(data, managedIntegration === null);
        }
      } else {
        handleManagedOsc(data);
      }
      return true;
    },
    reset() {
      resetCommand("idle");
      nativeCommandCapability = false;
      managedAttempted = false;
      managedIntegration = null;
      managedCommandSaved = false;
    },
  };
}

export function parseOsc7Directory(data: string) {
  if (Array.from(data).some(isControlCharacter)) return null;
  try {
    const uri = new URL(data);
    if (
      uri.protocol !== "file:" ||
      uri.username ||
      uri.password ||
      uri.port ||
      uri.search ||
      uri.hash
    ) {
      return null;
    }
    const path = decodeURIComponent(uri.pathname);
    return isValidRemotePath(path) ? path : null;
  } catch {
    return null;
  }
}

export function decodeOsc633Value(value: string) {
  let decoded = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character !== "\\") {
      decoded += character;
      continue;
    }
    if (value[index + 1] === "\\") {
      decoded += "\\";
      index += 1;
      continue;
    }
    const hexadecimal = value.slice(index + 2, index + 4);
    if (
      value[index + 1]?.toLowerCase() !== "x" ||
      hexadecimal.length !== 2 ||
      !/^[0-9a-f]{2}$/i.test(hexadecimal)
    ) {
      return null;
    }
    const codePoint = Number.parseInt(hexadecimal, 16);
    // OSC 633 只允许用 \xAB 转义 ASCII；非 ASCII 文本保持原始 UTF-8 字符。
    if (codePoint > 0x7f) return null;
    decoded += String.fromCharCode(codePoint);
    index += 3;
  }
  return decoded;
}

function parseOsc633Command(data: string) {
  if (!data.startsWith("E;")) return null;
  const fields = data.slice(2).split(";");
  if (fields.length > 2) return null;
  const command = decodeOsc633Value(fields[0] ?? "");
  if (
    command === null ||
    command.trim().length === 0 ||
    new TextEncoder().encode(command).byteLength > MAX_COMMAND_BYTES ||
    Array.from(command).some(isControlCharacter)
  ) {
    return null;
  }
  return command;
}

function createRandomToken() {
  return crypto.randomUUID().replace(/-/g, "");
}

function isControlCharacter(character: string) {
  const codePoint = character.codePointAt(0) ?? 0;
  return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
}
