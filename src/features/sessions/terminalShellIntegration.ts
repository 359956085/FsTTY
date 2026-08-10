import {
  createShellIntegrationCommand,
  parseCommandHistoryOsc,
  type ShellIntegrationDescriptor,
} from "./terminalCommandHistory";
import { isValidRemotePath, quoteShellPath } from "./terminalProtocol";

export const SHELL_OSC_IDENTIFIER = 777;

interface ShellIntegration extends ShellIntegrationDescriptor {
  stage: "detecting" | "installing" | "active" | "unsupported";
}

interface TerminalShellIntegrationOptions {
  addHistory: (command: string) => Promise<void>;
  onDirectoryChange: (path: string) => void;
  onHistoryError: (error: unknown) => void;
  send: (data: string) => void;
}

export function createTerminalShellIntegration(
  options: TerminalShellIntegrationOptions,
) {
  let atPrompt = false;
  let integration: ShellIntegration | null = null;
  let lastDirectory: string | null = null;
  let historyWriteChain = Promise.resolve();

  return {
    handleOsc(data: string) {
      if (!integration) return true;
      const history = parseCommandHistoryOsc(data, integration);
      if (history.matched) {
        if (history.command) {
          historyWriteChain = historyWriteChain
            .then(() => options.addHistory(history.command!))
            .catch(options.onHistoryError);
        }
        return true;
      }

      const shellPrefix = `fstty-shell:${integration.token}:`;
      if (data.startsWith(shellPrefix) && integration.stage === "detecting") {
        const shellName = data
          .slice(shellPrefix.length)
          .replace(/\\/g, "/")
          .split("/")
          .pop()
          ?.toLowerCase();
        const command = createShellIntegrationCommand(shellName, integration);
        if (!command) {
          integration.stage = "unsupported";
          return true;
        }
        integration.stage = "installing";
        options.send(command);
        return true;
      }

      const directoryPrefix = `fstty-cwd:${integration.token}:`;
      if (!data.startsWith(directoryPrefix)) return true;
      const path = data.slice(directoryPrefix.length);
      if (!isValidRemotePath(path)) return true;
      integration.stage = "active";
      atPrompt = true;
      lastDirectory = path;
      options.onDirectoryChange(path);
      return true;
    },
    markInput() {
      atPrompt = false;
    },
    requestDirectory(path: string) {
      if (
        integration?.stage !== "active" ||
        !atPrompt ||
        lastDirectory === path ||
        !isValidRemotePath(path)
      ) {
        return false;
      }
      atPrompt = false;
      options.send(` builtin cd -- ${quoteShellPath(path)}\r`);
      return true;
    },
    reset() {
      lastDirectory = null;
      atPrompt = false;
      integration = null;
    },
    start() {
      // 独立令牌防止远端普通程序伪造同编号 OSC，误触发目录同步。
      const token = crypto.randomUUID().replace(/-/g, "");
      integration = {
        functionName: `__fstty_cwd_${token.slice(0, 12)}`,
        historyFunctionName: `__fstty_history_${token.slice(0, 12)}`,
        stage: "detecting",
        token,
      };
      atPrompt = false;
      lastDirectory = null;
      options.send(
        ` printf '\\033]${SHELL_OSC_IDENTIFIER};fstty-shell:${token}:%s\\007' "$SHELL"\r`,
      );
    },
  };
}
