import { useEffect, useRef } from "react";
import type { Terminal as XTerm } from "@xterm/xterm";
import type { SessionConnection } from "../../shared/api/types";

interface TerminalPaneProps {
  connection: SessionConnection | null;
}

export function TerminalPane({ connection }: TerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<XTerm | null>(null);
  const latestConnectionRef = useRef<SessionConnection | null>(connection);
  const commandRef = useRef("");

  useEffect(() => {
    let disposed = false;
    let observer: ResizeObserver | null = null;
    let terminalInstance: XTerm | null = null;

    async function mountTerminal() {
      const container = containerRef.current;

      if (!container) {
        return;
      }

      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
      ]);

      if (disposed) {
        // 动态模块加载期间组件可能已卸载，避免创建无法释放的终端实例。
        return;
      }

      const terminal = new Terminal({
        convertEol: true,
        cursorBlink: true,
        fontFamily: "'Cascadia Mono', 'JetBrains Mono', Consolas, monospace",
        fontSize: 13,
        lineHeight: 1.38,
        theme: {
          background: "#09131c",
          foreground: "#c9d3dd",
          cursor: "#f5f7fb",
          black: "#0b1118",
          blue: "#22a7f0",
          cyan: "#2dd4bf",
          green: "#67d75b",
          red: "#ff6b6b",
          yellow: "#fbbf24",
        },
      });
      const fitAddon = new FitAddon();

      terminal.loadAddon(fitAddon);
      terminal.open(container);
      fitAddon.fit();
      terminalRef.current = terminal;
      terminalInstance = terminal;

      terminal.onData((data) => {
        const activeConnection = latestConnectionRef.current;

        if (data === "\r") {
          terminal.writeln("");
          terminal.writeln(`模拟命令: ${commandRef.current}`);
          terminal.write(
            `${activeConnection?.session.username ?? "user"}@${activeConnection?.session.name ?? "fstty"}:~$ `,
          );
          commandRef.current = "";
          return;
        }

        if (data === "\u007f") {
          if (commandRef.current.length > 0) {
            commandRef.current = commandRef.current.slice(0, -1);
            terminal.write("\b \b");
          }
          return;
        }

        commandRef.current += data;
        terminal.write(data);
      });

      observer = new ResizeObserver(() => {
        fitAddon.fit();
      });
      observer.observe(container);
      writeConnectionOutput(terminal, latestConnectionRef.current);
    }

    void mountTerminal();

    return () => {
      disposed = true;
      observer?.disconnect();
      terminalRef.current = null;
      terminalInstance?.dispose();
    };
  }, []);

  useEffect(() => {
    latestConnectionRef.current = connection;
    commandRef.current = "";
    const terminal = terminalRef.current;

    if (!terminal) {
      return;
    }

    terminal.reset();
    writeConnectionOutput(terminal, connection);
  }, [connection]);

  return (
    <div className="terminal-wrap">
      <div className="terminal-body" ref={containerRef} />
    </div>
  );
}

function writeConnectionOutput(terminal: XTerm, connection: SessionConnection | null) {
  const lines = connection?.terminalOutput ?? [];

  lines.forEach((line, index) => {
    if (index === lines.length - 1) {
      terminal.write(line);
      return;
    }

    terminal.writeln(line);
  });
}
