import type { Terminal, IDecoration, IMarker, ITheme, IBufferLine } from "@xterm/xterm";

import type { LocalHighlightSnapshot, LocalHighlightKind } from "../../shared/api/types";
export type HighlightKind = LocalHighlightKind;
type Phase = LocalHighlightSnapshot["phase"];
type Span = LocalHighlightSnapshot["spans"][number];
const MAX_SPANS = 2000;
const MAX_LINE = 8192;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createOutputClassifier() {
  let directory: LocalHighlightSnapshot["directory"] = null;
  let powershellPath = false;
  let cmdContinuation = false;
  return {
    reset(value: LocalHighlightSnapshot["directory"] = null) { directory = value; powershellPath = false; cmdContinuation = false; },
    context() { return directory; },
    classify(text: string): Omit<Span, "line"> | null {
      const continuation = cmdContinuation;
      cmdContinuation = false;
      if (continuation && /^\s*(?:operable program or batch file\.|或批处理文件。)\s*$/i.test(text)) return { start: 0, end: text.length, kind: "error" };
      if (text.length > MAX_LINE) { directory = null; return null; }
      if (/^\s*(?:ERROR|FATAL|WARN(?:ING)?)\b\s*[:：[]/i.test(text) || /^\s*(?:错误|警告)\s*[:：]/.test(text)) {
        directory = null; powershellPath = false;
        return { start: 0, end: text.length, kind: /^\s*(?:WARN(?:ING)?\b|警告)/i.test(text) ? "warning" : "error" };
      }
      if (/^\s*(?:Access is denied\.|The system cannot find the (?:file|path) specified\.|The syntax of the command is incorrect\.|File Not Found|拒绝访问。|系统找不到指定的(?:文件|路径)。|命令语法不正确。|找不到文件)\s*$/i.test(text) ||
          /^'.+' (?:is not recognized as an internal or external command,|不是内部或外部命令，也不是可运行的程序)\s*$/i.test(text)) {
        directory = null; powershellPath = false;
        cmdContinuation = /^'.+' (?:is not recognized|不是内部或外部命令)/i.test(text);
        return { start: 0, end: text.length, kind: "error" };
      }
      if (/^\s*(?:Directory of [A-Z]:\\|[A-Z]:\\.*的目录\s*$)/i.test(text)) { directory = "cmd"; return null; }
      if (/^\s*(?:Directory|目录)\s*[:：]\s*(?:[A-Z]:\\|\\\\[^\\]+\\)/i.test(text)) { powershellPath = true; directory = null; return null; }
      if (/^\s*Mode\s+LastWriteTime\s+Length\s+Name\s*$/.test(text)) { directory = powershellPath ? "powershell" : null; powershellPath = false; return null; }
      let match: RegExpExecArray | null = null;
      if (directory === "cmd") match = /^\s*\d{1,4}[/.-]\d{1,2}[/.-]\d{1,4}\s+\d{1,2}:\d{2}(?:\s*[AP]M)?\s+<(?:DIR|JUNCTION|SYMLINKD)>\s+(.+?)\s*$/i.exec(text);
      if (directory === "powershell") match = /^\s*d[rwahs\-l+]{4,6}\s+\d{1,4}[/.-]\d{1,2}[/.-]\d{1,4}\s+\d{1,2}:\d{2}(?:\s*[AP]M)?\s+(.+?)\s*$/i.exec(text);
      if (match) {
        const start = text.lastIndexOf(match[1]);
        return { start, end: start + match[1].length, kind: "directory" };
      }
      // Only blank/separator lines and structurally valid file rows preserve context.
      const file = directory === "cmd"
        ? /^\s*\d{1,4}[/.-]\d{1,2}[/.-]\d{1,4}\s+\d{1,2}:\d{2}(?:\s*[AP]M)?\s+[\d,.]+\s+\S/i.test(text)
        : directory === "powershell" && /^\s*[-a][rwahs\-l+]{4,6}\s+\d{1,4}[/.-]\d{1,2}[/.-]\d{1,4}\s+\d{1,2}:\d{2}(?:\s*[AP]M)?\s+\d+\s+\S/i.test(text);
      if (text.trim() && !/^[-\s]+$/.test(text) && !file) { directory = null; powershellPath = false; }
      return null;
    },
  };
}

function plain(line: IBufferLine) {
  for (let i = 0; i < line.length; i++) {
    const cell = line.getCell(i);
    if (cell && (!cell.isFgDefault() || !cell.isBgDefault() || cell.isBold() || cell.isInverse() || cell.isItalic() || cell.isUnderline() || cell.isBlink() || cell.isDim() || cell.isInvisible() || cell.isStrikethrough() || cell.isOverline())) return false;
  }
  return true;
}
function cells(line: IBufferLine, offset: number) {
  let consumed = 0;
  for (let x = 0; x < line.length; x++) {
    const cell = line.getCell(x);
    if (!cell || cell.getWidth() === 0) continue;
    if (consumed >= offset) return x;
    consumed += cell.getChars().length || 1;
  }
  return line.length;
}

function completedLine(terminal: Terminal, y: number) {
  const buffer = terminal.buffer.normal;
  let start = y;
  while (start > 0 && buffer.getLine(start)?.isWrapped) start--;
  let text = "";
  for (let row = start; row <= y; row++) {
    const line = buffer.getLine(row);
    if (!line || !plain(line)) return null;
    text += line.translateToString(row === y);
    if (text.length > MAX_LINE) return null;
  }
  return { start, text };
}

// An internal checksum of confirmed output; no extra text is persisted or sent.
function fingerprint(text: string) {
  let a = 2166136261, b = 5381;
  for (let i = 0; i < text.length; i++) {
    a = Math.imul(a ^ text.charCodeAt(i), 16777619);
    b = Math.imul(b, 33) ^ text.charCodeAt(i);
  }
  return `${text.length}:${a >>> 0}:${b >>> 0}`;
}

// Decorations affect rendering only. PTY bytes and terminal selection are untouched.
export function createLocalTerminalHighlighter(terminal: Terminal, onUnavailable: () => void) {
  let token: string | null = null;
  let ready = false;
  let phase: Phase = "prompt";
  let warned = false;
  let initializingTimer: ReturnType<typeof setTimeout> | null = null;
  let rewritten = false;
  let trailingCr = false;
  let crHadText = false;
  let crMetadata: "text" | "escape" | "osc" | "oscEscape" | "csi" = "text";
  let unsupported = false;
  let disposed = false;
  let writing = false;
  const writes: Array<{ data: Uint8Array | string; callback?: () => void }> = [];
  const dirty = new Set<number>();
  const classifier = createOutputClassifier();
  const records: Array<{ marker: IMarker; span: Omit<Span, "line">; fingerprint: string; decorations?: IDecoration[]; parts?: IMarker[] }> = [];
  const resized = new Set<typeof records[number]>();
  const pending: Array<{ marker: IMarker; span: Omit<Span, "line">; text: string }> = [];
  const disposables: Array<{ dispose(): void }> = [];
  const clear = () => {
    resized.clear();
    pending.splice(0).forEach(item => item.marker.dispose());
    records.splice(0).forEach(item => { item.decorations?.forEach(decoration => decoration.dispose()); item.parts?.forEach(marker => marker.dispose()); item.marker.dispose(); });
    dirty.clear(); classifier.reset();
  };
  const stopTimer = () => { if (initializingTimer !== null) clearTimeout(initializingTimer); initializingTimer = null; };
  const warn = () => { if (!warned) { warned = true; onUnavailable(); } };
  function render(record: typeof records[number]) {
    if (terminal.buffer.active.type !== "normal") return;
    record.decorations?.forEach(decoration => decoration.dispose());
    record.parts?.forEach(marker => marker.dispose());
    record.decorations = []; record.parts = [];
    if (record.marker.isDisposed) return;
    const buffer = terminal.buffer.normal;
    const lines: Array<{ line: IBufferLine; y: number; length: number }> = [];
    let length = 0, content = "";
    for (let y = record.marker.line; y < buffer.length; y++) {
      const line = buffer.getLine(y);
      if (!line || y === record.marker.line && line.isWrapped || y > record.marker.line && !line.isWrapped) break;
      if (!plain(line)) return;
      const next = buffer.getLine(y + 1);
      const text = line.translateToString(!next?.isWrapped);
      lines.push({ line, y, length: text.length }); length += text.length; content += text;
      if (length > MAX_LINE || !next?.isWrapped) break;
    }
    if (length < record.span.end || fingerprint(content) !== record.fingerprint) return;
    const theme: ITheme = terminal.options.theme ?? {};
    const color = record.span.kind === "error" ? theme.red : record.span.kind === "warning" ? theme.yellow : theme.blue;
    if (!color) return;
    let offset = 0;
    for (const { line, y, length } of lines) {
      const start = Math.max(record.span.start - offset, 0), finish = Math.min(record.span.end - offset, length);
      if (finish > start) {
        const x = cells(line, start), end = cells(line, finish);
        const marker = y === record.marker.line ? record.marker : terminal.registerMarker(y - buffer.baseY - buffer.cursorY);
        if (marker !== record.marker) record.parts.push(marker);
        const decoration = terminal.registerDecoration({ marker, x, width: end - x, foregroundColor: color, layer: "bottom" });
        if (decoration) record.decorations.push(decoration);
      }
      offset += length;
    }
  }
  const complete = (y: number) => {
    if (unsupported || rewritten || !token || !ready || phase !== "execute" || terminal.buffer.active.type !== "normal" || dirty.has(y)) return;
    const line = completedLine(terminal, y);
    if (!line) return;
    const span = classifier.classify(line.text);
    if (span) {
      if (pending.length >= MAX_SPANS) pending.splice(0, 500).forEach(item => item.marker.dispose());
      const buffer = terminal.buffer.normal;
      pending.push({ marker: terminal.registerMarker(line.start - buffer.baseY - buffer.cursorY), span, text: line.text });
    }
  };
  const discardRows = (start: number, end: number) => {
    for (let i = pending.length - 1; i >= 0; i--) if (pending[i].marker.line >= start && pending[i].marker.line <= end) {
      pending.splice(i, 1)[0].marker.dispose();
    }
    for (let i = records.length - 1; i >= 0; i--) {
      const item = records[i];
      if (item.marker.line >= start && item.marker.line <= end || item.parts?.some(marker => marker.line >= start && marker.line <= end)) {
        if (resized.has(item)) {
          item.decorations?.forEach(decoration => decoration.dispose());
          item.parts?.forEach(marker => marker.dispose()); item.decorations = []; item.parts = [];
          continue;
        }
        records.splice(i, 1); item.decorations?.forEach(decoration => decoration.dispose()); item.parts?.forEach(marker => marker.dispose()); item.marker.dispose();
      }
    }
  };
  if (typeof terminal.registerDecoration === "function" && typeof terminal.onLineFeed === "function") {
    disposables.push(terminal.onLineFeed(() => {
      const buffer = terminal.buffer.normal, y = buffer.baseY + buffer.cursorY - 1;
      if (!buffer.getLine(y + 1)?.isWrapped) complete(y);
    }));
    disposables.push(terminal.onWriteParsed(() => {
      for (const item of pending.splice(0)) {
        const line = terminal.buffer.normal.getLine(item.marker.line);
        let end = item.marker.line;
        while (terminal.buffer.normal.getLine(end + 1)?.isWrapped) end++;
        if (item.marker.isDisposed || !line || completedLine(terminal, end)?.text !== item.text || dirty.has(item.marker.line)) { item.marker.dispose(); continue; }
        const record = { marker: item.marker, span: item.span, fingerprint: fingerprint(item.text) }; records.push(record); render(record);
      }
      for (let i = records.length - 1; i >= 0; i--) if (records[i].marker.isDisposed) {
        const item = records.splice(i, 1)[0];
        resized.delete(item);
        item.decorations?.forEach(decoration => decoration.dispose()); item.parts?.forEach(marker => marker.dispose());
      }
      while (records.length > MAX_SPANS) { const item = records.shift()!; resized.delete(item); item.decorations?.forEach(decoration => decoration.dispose()); item.parts?.forEach(marker => marker.dispose()); item.marker.dispose(); }
      resized.forEach(render);
    }));
    const invalidate = () => {
      const buffer = terminal.buffer.active, y = buffer.baseY + buffer.cursorY;
      // Unsupported output stops classifying this command; it does not erase
      // decorations from other rows or from earlier completed commands.
      if (phase === "execute") { unsupported = true; dirty.add(y); classifier.reset(); }
      discardRows(y, y);
      return false;
    };
    // ConPTY serializes ordinary console text with forward CUP jumps instead
    // of some CRLFs. Only moves to a later row's first cell complete a line.
    for (const final of ["H", "f"]) disposables.push(terminal.parser.registerCsiHandler({ final }, params => {
      const buffer = terminal.buffer.active;
      const row = typeof params[0] === "number" ? params[0] || 1 : 1;
      const col = typeof params[1] === "number" ? params[1] || 1 : 1;
      if (row > buffer.cursorY + 1 && col === 1 && row <= terminal.rows) {
        complete(buffer.baseY + buffer.cursorY);
        trailingCr = false; crMetadata = "text";
        return false;
      }
      if (row === buffer.cursorY + 1 && col === buffer.cursorX + 1) return false;
      const target = buffer.baseY + Math.min(Math.max(row - 1, 0), terminal.rows - 1);
      discardRows(target, target);
      return invalidate();
    }));
    disposables.push(terminal.parser.registerCsiHandler({ final: "X" }, params => {
      const buffer = terminal.buffer.active;
      const count = typeof params[0] === "number" ? params[0] || 1 : 1;
      const line = buffer.getLine(buffer.baseY + buffer.cursorY);
      // Windows PowerShell tables erase trailing padding after each row.
      // Erasing cells that already contain only spaces leaves the text intact.
      if (buffer.type === "normal" && line) {
        let blank = true;
        for (let x = buffer.cursorX; x < Math.min(terminal.cols, buffer.cursorX + count); x++) {
          const chars = line.getCell(x)?.getChars();
          if (chars && chars !== " ") { blank = false; break; }
        }
        if (blank) return false;
      }
      return invalidate();
    }));
    for (const final of ["A", "B", "C", "D", "E", "F", "G", "I", "Z", "a", "e", "d", "K", "@", "P", "L", "M", "S", "T", "b", "g", "r", "s", "u", "h", "l"]) {
      disposables.push(terminal.parser.registerCsiHandler({ final }, invalidate));
    }
    disposables.push(terminal.parser.registerCsiHandler({ final: "J" }, params => {
      const buffer = terminal.buffer.active;
      if (buffer.type !== "normal") return false;
      const mode = params[0] || 0, y = buffer.baseY + buffer.cursorY;
      if (mode === 0) discardRows(y, buffer.baseY + terminal.rows - 1);
      else if (mode === 1) discardRows(buffer.baseY, y);
      else if (mode === 2) discardRows(buffer.baseY, buffer.baseY + terminal.rows - 1);
      else if (mode === 3) discardRows(0, buffer.baseY - 1);
      dirty.clear(); classifier.reset(); return false;
    }));
    for (const final of ["h", "l"]) disposables.push(terminal.parser.registerCsiHandler({ prefix: "?", final }, params => {
      if (params.some(value => value === 47 || value === 1047 || value === 1049)) { unsupported = true; dirty.clear(); classifier.reset(); }
      return false;
    }));
    disposables.push(terminal.onResize(() => {
      // Reflow changes physical cells. Recreate only still identifiable unwrapped spans.
      pending.splice(0).forEach(item => item.marker.dispose()); dirty.clear();
      // ConPTY repaints visible rows after a real size change, including while
      // the shell is at its prompt. Restore only identical confirmed output.
      const buffer = terminal.buffer.normal;
      records.forEach(item => { if (item.marker.line >= buffer.baseY && item.marker.line < buffer.baseY + terminal.rows) resized.add(item); });
      records.forEach(render);
    }));
    disposables.push(terminal.parser.registerEscHandler({ final: "c" }, () => { clear(); return false; }));
    for (const final of ["M", "D", "E", "8"]) disposables.push(terminal.parser.registerEscHandler({ final }, invalidate));
  }
  function pump() {
    if (writing || disposed || !writes.length) return;
    const item = writes.shift()!;
    writing = true; rewritten = false;
    // Keep the control observation aligned with xterm's asynchronous write queue.
    const bytes = typeof item.data === "string" ? new TextEncoder().encode(item.data) : item.data;
    if (trailingCr) {
      // ConPTY can insert a title OSC between CR and LF when it scrolls.
      // Non-rendering metadata does not turn that newline into progress text.
      for (const byte of bytes) {
        if (crMetadata === "csi") { if (byte >= 0x40 && byte <= 0x7e) crMetadata = "text"; continue; }
        if (crMetadata === "osc") { if (byte === 7) crMetadata = "text"; else if (byte === 27) crMetadata = "oscEscape"; continue; }
        if (crMetadata === "oscEscape") { crMetadata = byte === 92 ? "text" : "osc"; continue; }
        if (crMetadata === "escape" && byte === 93) { crMetadata = "osc"; continue; }
        if (crMetadata === "escape" && byte === 91) { crMetadata = "csi"; continue; }
        if (crMetadata === "text" && byte === 27) { crMetadata = "escape"; continue; }
        rewritten = byte !== 10 && crHadText;
        trailingCr = false; crMetadata = "text"; break;
      }
    }
    if (bytes.includes(8)) rewritten = true;
    if (rewritten && phase === "execute") {
      const buffer = terminal.buffer.active, y = buffer.baseY + buffer.cursorY;
      dirty.add(y); discardRows(y, y);
    }
    if (bytes[bytes.length - 1] === 13) {
      trailingCr = true; crHadText = terminal.buffer.active.cursorX > 0; crMetadata = "text";
    }
    terminal.write(item.data, () => {
      writing = false; rewritten = false;
      item.callback?.(); pump();
    });
  }
  return {
    begin(next: string | null) { stopTimer(); unsupported = false; rewritten = false; trailingCr = false; crMetadata = "text"; clear(); token = next && UUID.test(next) ? next : null; ready = false; warned = false; phase = "prompt"; },
    started() {
      if (!token || ready || initializingTimer !== null) return;
      initializingTimer = setTimeout(() => { initializingTimer = null; if (!ready && token) warn(); }, 15000);
    },
    write(data: Uint8Array | string, callback?: () => void) {
      if (disposed) { callback?.(); return; }
      // Observe a lone CR/backspace at its actual parser position, not before
      // an earlier execute marker in the same batch. Keep normal CRLF batches.
      const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
      let start = 0;
      for (let i = 0; i < bytes.length; i++) if (bytes[i] === 8 || bytes[i] === 13 && bytes[i + 1] !== 10) {
        if (i > start) writes.push({ data: bytes.slice(start, i) });
        writes.push({ data: bytes.slice(i, i + 1) }); start = i + 1;
      }
      if (start < bytes.length) writes.push({ data: bytes.slice(start) });
      if (!bytes.length) writes.push({ data });
      writes[writes.length - 1].callback = callback; pump();
    },
    handleOsc(data: string) {
      if (!token || !data.startsWith(`fstty-highlight:${token}:`)) return false;
      const value = data.slice(`fstty-highlight:${token}:`.length);
      if (value === "ready") { ready = true; stopTimer(); }
      else if (value === "failed" || value.startsWith("failed:")) { stopTimer(); ready = false; clear(); warn(); }
      else if (ready && (value === "prompt" || value === "input" || value === "execute")) {
        if (value === "prompt" && phase === "execute") {
          const buffer = terminal.buffer.normal;
          complete(buffer.baseY + buffer.cursorY);
        }
        phase = value;
        if (value === "execute") {
          // End the resize repaint window before any new command output.
          for (const item of resized) {
            let end = item.marker.line;
            while (terminal.buffer.normal.getLine(end + 1)?.isWrapped) end++;
            const line = completedLine(terminal, end);
            if (!line || fingerprint(line.text) !== item.fingerprint) {
              item.decorations?.forEach(decoration => decoration.dispose()); item.parts?.forEach(marker => marker.dispose()); item.marker.dispose();
              const index = records.indexOf(item); if (index >= 0) records.splice(index, 1);
            }
          }
          resized.clear(); rewritten = false; trailingCr = false; crMetadata = "text";
        }
        if (value !== "input") { unsupported = false; dirty.clear(); classifier.reset(); }
      }
      return true;
    },
    unavailable: warn,
    ended() { stopTimer(); },
    refresh() { records.forEach(render); },
    snapshot(): LocalHighlightSnapshot | undefined {
      if (!token) return undefined;
      return { version: 1, token, ready, phase: unsupported || rewritten ? "input" : phase, directory: classifier.context(), spans: records.filter(item => !item.marker.isDisposed)
        .filter(item => !resized.has(item) || item.decorations?.length)
        .map(item => ({ ...item.span, line: item.marker.line })) };
    },
    restore(snapshot: LocalHighlightSnapshot | undefined, nextToken: string | null, truncated: boolean) {
      stopTimer(); unsupported = false; clear(); token = nextToken && UUID.test(nextToken) ? nextToken : null; ready = false; warned = false;
      if (!snapshot || snapshot.version !== 1 || snapshot.token !== token || !["prompt", "input", "execute"].includes(snapshot.phase)) return;
      ready = snapshot.ready === true; phase = snapshot.phase;
      classifier.reset(["cmd", "powershell"].includes(snapshot.directory ?? "") ? snapshot.directory : null);
      if (truncated) { phase = "input"; classifier.reset(); return; }
      if (!Array.isArray(snapshot.spans)) return;
      const buffer = terminal.buffer.normal;
      for (const span of snapshot.spans.slice(-MAX_SPANS)) {
        if (!Number.isInteger(span.line) || span.line < 0 || span.line >= buffer.length || !Number.isInteger(span.start) || !Number.isInteger(span.end) || span.start < 0 || span.end <= span.start || span.end > MAX_LINE || !["error", "warning", "directory"].includes(span.kind)) continue;
        const marker = terminal.registerMarker(span.line - buffer.baseY - buffer.cursorY);
        let end = span.line;
        while (buffer.getLine(end + 1)?.isWrapped) end++;
        const line = completedLine(terminal, end);
        if (!line) { marker.dispose(); continue; }
        const record = { marker, fingerprint: fingerprint(line.text), span: { start: span.start, end: span.end, kind: span.kind } }; records.push(record); render(record);
      }
    },
    dispose() { disposed = true; writes.splice(0).forEach(item => item.callback?.()); stopTimer(); disposables.forEach(item => item.dispose()); clear(); token = null; },
  };
}
