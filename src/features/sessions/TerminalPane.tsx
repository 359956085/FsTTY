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
    let command = "";

    terminal.loadAddon(fitAddon);
    terminal.open(container);
    fitAddon.fit();

    for (const line of connection?.terminalOutput ?? []) {
      terminal.writeln(line);
    }

    terminal.onData((data) => {
      if (data === "\r") {
        terminal.writeln("");
        terminal.writeln(`command mocked: ${command}`);
        terminal.write(`${connection?.session.username ?? "user"}@${connection?.session.name ?? "fstty"}:~$ `);
        command = "";
        return;
      }

      if (data === "\u007f") {
        if (command.length > 0) {
          command = command.slice(0, -1);
          terminal.write("\b \b");
        }
        return;
      }

      command += data;
      terminal.write(data);
    });

    const observer = new ResizeObserver(() => {
      fitAddon.fit();
    });

    observer.observe(container);

    return () => {
      observer.disconnect();
      terminal.dispose();
    };
  }, [connection]);

  return (
    <div className="terminal-wrap">
      <div className="terminal-body" ref={containerRef} />
      <div className="terminal-input-hint">{t("sessions.terminalPlaceholder")}</div>
    </div>
  );
}

