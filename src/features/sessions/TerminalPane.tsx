import { useEffect, useRef } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useTranslation } from "react-i18next";
import type { SessionConnection } from "../../shared/api/types";

interface TerminalPaneProps {
  connection: SessionConnection | null;
}

export function TerminalPane({ connection }: TerminalPaneProps) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const latestConnectionRef = useRef<SessionConnection | null>(connection);
  const commandRef = useRef("");

  useEffect(() => {
    const container = containerRef.current;

    if (!container) {
      return;
    }

    const terminal = new Terminal({
      convertEol: true,
      cursorBlink: true,
      fontFamily: "'Cascadia Mono', 'JetBrains Mono', Consolas, monospace",
      fontSize: 13,
      lineHeight: 1.45,
      theme: {
        background: "#071017",
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
    latestConnectionRef.current = connection;

    terminal.onData((data) => {
      const activeConnection = latestConnectionRef.current;

      if (data === "\r") {
        terminal.writeln("");
        terminal.writeln(`模拟命令: ${commandRef.current}`);
        terminal.write(`${activeConnection?.session.username ?? "user"}@${activeConnection?.session.name ?? "fstty"}:~$ `);
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

    const observer = new ResizeObserver(() => {
      fitAddon.fit();
    });

    observer.observe(container);

    return () => {
      observer.disconnect();
      terminalRef.current = null;
      terminal.dispose();
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
      <div className="terminal-input-hint">{t("sessions.terminalPlaceholder")}</div>
    </div>
  );
}

function writeConnectionOutput(terminal: Terminal, connection: SessionConnection | null) {
  for (const line of connection?.terminalOutput ?? []) {
    terminal.writeln(line);
  }
}