// @vitest-environment jsdom
import { Terminal } from "@xterm/xterm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLocalTerminalHighlighter, createOutputClassifier } from "./localTerminalHighlight";

const token = "e6b4ea51-2f6b-4449-9550-f4b20082a620";
const osc = (value: string, id = token) => `\x1b]777;fstty-highlight:${id}:${value}\x07`;
const cleanups: Array<() => void> = [];
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()); vi.useRealTimers(); });
function setup(cols = 100, rows = 8, scrollback = 10000) {
  const terminal = new Terminal({ cols, rows, scrollback, allowProposedApi: true,
    theme: { red: "#ff0000", yellow: "#ffff00", blue: "#0000ff" } });
  const unavailable = vi.fn();
  const highlighter = createLocalTerminalHighlighter(terminal, unavailable);
  const handler = terminal.parser.registerOscHandler(777, data => highlighter.handleOsc(data));
  highlighter.begin(token);
  cleanups.push(() => { handler.dispose(); highlighter.dispose(); terminal.dispose(); });
  const write = (data: string | Uint8Array) => new Promise<void>(resolve => highlighter.write(data, resolve));
  const execute = () => write(osc("ready") + osc("execute"));
  return { terminal, highlighter, unavailable, write, execute };
}

describe("本地输出识别", () => {
  it.each(["ERROR: failed", "FATAL: failed", "错误：失败", "Access is denied.", "系统找不到指定的路径。", "'ls' is not recognized as an internal or external command,"])("识别明确错误 %s", text => {
    expect(createOutputClassifier().classify(text)?.kind).toBe("error");
  });
  it.each(["WARN: caution", "WARNING: caution", "警告：注意"])("识别明确警告 %s", text => {
    expect(createOutputClassifier().classify(text)?.kind).toBe("warning");
  });
  it("目录必须同时满足标准表头和行结构，普通文件和任意路径不匹配", () => {
    const classifier = createOutputClassifier();
    const row = "2026/10/08  12:30    <DIR>          中文 文件夹";
    expect(classifier.classify(row)).toBeNull();
    classifier.classify(" C:\\用户 的目录");
    const span = classifier.classify(row)!;
    expect(row.slice(span.start, span.end)).toBe("中文 文件夹");
    expect(classifier.classify("2026/10/08  12:30       18          file.txt")).toBeNull();
    classifier.reset();
    expect(classifier.classify("C:\\users\\file")).toBeNull();
    classifier.classify(" Directory: C:\\Test");
    classifier.classify("Mode                 LastWriteTime         Length Name");
    expect(classifier.classify("d----         2026/10/8     12:30                Documents")?.kind).toBe("directory");
    expect(classifier.classify("-a---         2026/10/8     12:30             42 file.txt")).toBeNull();
    expect(classifier.classify("ERROR count = 42, 192.168.1.1")).toBeNull();
  });
});

describe("真实 xterm 装饰生命周期", () => {
  it.each([7, 4096])("尺寸改变后的 ConPTY 提示符重绘只恢复完全相同的历史行（%s 字节）", async chunk => {
    const { highlighter, write, execute, terminal } = setup(100, 10); await execute();
    const body = " Directory of C:\\Fixture\r\n2026/10/08  08:55    <DIR>          Folder\r\n";
    await write(body + osc("prompt") + "C:\\Fixture>" + osc("input"));
    terminal.resize(90, 10);
    const redraw = new TextEncoder().encode("\x1b[H Directory of C:\\Fixture\x1b[K\r\n2026/10/08  08:55    <DIR>          Folder\x1b[K\r\nC:\\Fixture>\x1b[K");
    for (let start = 0; start < redraw.length; start += chunk) await write(redraw.slice(start, start + chunk));
    expect(highlighter.snapshot()?.spans.map(span => span.kind)).toEqual(["directory"]);
    await write(osc("execute") + "\r\nERROR: next\r\n" + osc("prompt"));
    expect(highlighter.snapshot()?.spans.map(span => span.kind)).toEqual(["directory", "error"]);
  });
  it("尺寸重绘中改变的内容不继承旧色，下一次命令结束恢复窗口", async () => {
    const { highlighter, write, execute, terminal } = setup(100, 10); await execute();
    await write("ERROR: retained\r\n" + osc("prompt") + osc("input"));
    terminal.resize(90, 10);
    await write("\x1b[Hplain changed\x1b[K");
    expect(highlighter.snapshot()?.spans).toHaveLength(0);
    await write(osc("execute") + "\x1b[HERROR: retained\r\n" + osc("prompt"));
    expect(highlighter.snapshot()?.spans).toHaveLength(0);
  });
  it.each([7, 4096])("Windows PowerShell 表格尾部空白擦除不阻止目录补色（%s 字节）", async chunk => {
    const { highlighter, write, execute } = setup(100, 10); await execute();
    const trace = "    目录: C:\\Fixture\r\nMode                 LastWriteTime         Length Name\x1b[45X\r\n" +
      "----                 -------------         ------ ----\x1b[45X\r\nd-----         2026/10/8     12:30                Folder\x1b[40X\r\n" + osc("prompt");
    const bytes = new TextEncoder().encode(trace);
    for (let start = 0; start < bytes.length; start += chunk) await write(bytes.slice(start, start + chunk));
    expect(highlighter.snapshot()?.spans.map(span => span.kind)).toEqual(["directory"]);
    await write(osc("execute") + "\x1b[4;1H\x1b[100X" + osc("prompt"));
    expect(highlighter.snapshot()?.spans).toHaveLength(0);
  });
  it("dir 后的 cd 和提示符定位不清除已有历史颜色", async () => {
    const { highlighter, write, execute } = setup(); await execute();
    await write(" Directory of C:\\Fixture\r\n2026/10/08  08:55    <DIR>          Folder\r\n" + osc("prompt") + "C:\\Fixture>" + osc("input"));
    const before = highlighter.snapshot()!.spans;
    await write("\x1b[34mcd\x1b[m ..\r\n" + osc("execute") + "\x1b[100C" + osc("prompt") + "\rC:\\>" + osc("input"));
    expect(highlighter.snapshot()?.spans).toEqual(before);
    await write("dir\r\n" + osc("execute") + " Directory of C:\\\r\n2026/10/08  08:55    <DIR>          Other\r\n\x1b[100C" + osc("prompt"));
    expect(highlighter.snapshot()?.spans.map(span => span.kind)).toEqual(["directory", "directory"]);
  });
  it("后续不支持的输出仅排除本次候选，不丢失先前命令装饰", async () => {
    const { highlighter, write, execute } = setup(); await execute();
    await write("ERROR: history\r\n" + osc("prompt") + osc("execute") + "10%\rERROR: progress\r\n\x1b[100C" + osc("prompt"));
    expect(highlighter.snapshot()?.spans).toHaveLength(1);
    expect(highlighter.snapshot()?.spans[0].line).toBe(0);
    await write(osc("execute") + "\x1b[1;1Hplain replacement\x1b[K" + osc("prompt"));
    expect(highlighter.snapshot()?.spans).toHaveLength(0);
  });
  it("擦除可见屏幕仅清理受影响行，滚屏中的历史颜色保留", async () => {
    const { highlighter, write, execute, terminal } = setup(100, 4); await execute();
    await write("ERROR: retained scrollback\r\nplain\r\nplain\r\nplain\r\nplain\r\nWARNING: visible\r\n");
    expect(terminal.buffer.normal.baseY).toBeGreaterThan(0);
    await write("\x1b[2J");
    expect(highlighter.snapshot()?.spans).toEqual([{start:0,end:26,kind:"error",line:0}]);
    await write("\x1b[3J");
    expect(highlighter.snapshot()?.spans).toHaveLength(0);
  });
  it.each([7, 4096])("滚屏时 CR 与 LF 之间的标题通知按 %s 字节分块不阻止目录着色", async chunk => {
    const { highlighter, write, execute } = setup(100, 4); await execute();
    const trace = " Directory of C:\\Fixture\r\x1b]0;cmd.exe - dir\x07\x1b[?25h\n\r\n2026/10/08  08:55    <DIR>          Folder\r\n\x1b[100C" + osc("prompt") + osc("input") +
      "cd ..\r\n" + osc("execute") + "\x1b[100C" + osc("prompt") + osc("input");
    const bytes = new TextEncoder().encode(trace);
    for (let start = 0; start < bytes.length; start += chunk) await write(bytes.slice(start, start + chunk));
    expect(highlighter.snapshot()?.spans).toHaveLength(1);
    expect(highlighter.snapshot()?.spans[0].kind).toBe("directory");
  });
  it.each([7, 4096])("首个目录行滚屏并插入标题和光标通知后保留全部目录颜色（%s 字节）", async chunk => {
    const { highlighter, write, execute } = setup(100, 3); await execute();
    const trace = " Directory of C:\\Fixture\r\n\r\n2026/10/08  08:55    <DIR>          .\r\x1b]0;cmd.exe - dir\x07\x1b[?25h\n" +
      "2026/10/08  08:55    <DIR>          ..\r\n2026/10/08  08:55    <DIR>          Folder\r\n\x1b[100C" + osc("prompt") + osc("input") +
      "cd ..\r\n" + osc("execute") + "\x1b[100C" + osc("prompt") + osc("input");
    const bytes = new TextEncoder().encode(trace);
    for (let start = 0; start < bytes.length; start += chunk) await write(bytes.slice(start, start + chunk));
    expect(highlighter.snapshot()?.spans.map(span => span.kind)).toEqual(["directory", "directory", "directory"]);
  });
  it.each([7, 113, 4096])("ConPTY 真实结构在 %s 字节分块下识别跳行、无末尾换行和目录", async chunk => {
    const { highlighter, write, terminal } = setup(100, 30);
    const trace = "\x1b[2J\x1b[m\x1b[H" + osc("ready") + osc("input") + "C:\\Fixture>\x1b[31mls\x1b[m\r\n\x1b[K\x1b[100C\r\x1b[?25h" + osc("execute") +
      "'ls' 不是内部或外部命令，也不是可运行的程序\r\n或批处理文件。\x1b[?25l" + osc("prompt") + "\x1b[4;1HC:\\Fixture>" + osc("input") + "\x1b[34mdir\x1b[m\r\n\x1b[K\x1b[100C\r\x1b[?25h" + osc("execute") +
      " 驱动器 C 中的卷没有标签。\r\n 卷的序列号是 E28F-757B\x1b[8;1H C:\\Fixture 的目录\x1b[10;1H2026/10/08  08:55    <DIR>          Contacts\r\n2026/10/08  08:55    <DIR>          中文目录\r\n               0 个文件              0 字节\x1b[?25l" + osc("prompt") + "\x1b[14;1HC:\\Fixture>" + osc("input");
    const bytes = new TextEncoder().encode(trace);
    for (let start = 0; start < bytes.length; start += chunk) await write(bytes.slice(start, start + chunk));
    expect(highlighter.snapshot()?.spans.map(span => span.kind)).toEqual(["error", "error", "directory", "directory"]);
    expect(terminal.buffer.normal.getLine(9)?.translateToString(true)).toContain("Contacts");
  });
  it("执行标记同批次的进度改写仍不补色，向后定位不会保留旧着色", async () => {
    const { highlighter, write } = setup();
    await write(osc("ready") + osc("execute") + "20%\rERROR: progress\r\n" + osc("prompt"));
    expect(highlighter.snapshot()?.spans).toHaveLength(0);
    await write(osc("execute") + "ERROR: replace\r\n\x1b[1;1HWARNING: overwritten\r\n" + osc("prompt"));
    expect(highlighter.snapshot()?.spans).toEqual([{start:0,end:14,kind:"error",line:1}]);
  });
  it("仅在正确标记的执行阶段补色，Unicode 分块和复制字节不改变", async () => {
    const { highlighter, write, execute, terminal } = setup();
    await write("ERROR: before initialization\r\n" + osc("ready", "a6b4ea51-2f6b-4449-9550-f4b20082a620"));
    expect(highlighter.snapshot()?.spans).toHaveLength(0);
    await execute();
    const bytes = new TextEncoder().encode("错误：中文 😀\r\n");
    await write(bytes.slice(0, 8)); await write(bytes.slice(8));
    expect(highlighter.snapshot()?.spans).toHaveLength(1);
    expect(terminal.buffer.normal.getLine(1)?.translateToString(true)).toBe("错误：中文 😀");
    await write(osc("input") + "ERROR: typed\r\n" + osc("prompt") + "WARNING: prompt\r\n");
    expect(highlighter.snapshot()?.spans).toHaveLength(1);
    expect(JSON.stringify(highlighter.snapshot())).not.toContain("中文");
  });
  it("已有 ANSI/RGB/样式、进度改写、备用屏幕、未完成行不补色", async () => {
    const { highlighter, write, execute } = setup(); await execute();
    await write("\x1b[31mERROR: ANSI\x1b[0m\r\n\x1b[38;2;10;20;30mWARNING: RGB\x1b[0m\r\n\x1b[1mERROR: bold\x1b[0m\r\n");
    expect(highlighter.snapshot()?.spans).toHaveLength(0);
    await write("10%\rERROR: progress\r\n");
    await write("\x1b[?1049hERROR: TUI\r\n\x1b[?1049l");
    await write("ERROR: incomplete");
    expect(highlighter.snapshot()?.spans).toHaveLength(0);
  });
  it("连续异步批次中的进度改写保持排除，标准表格需有路径上下文", async () => {
    const { highlighter, write, execute } = setup(); await execute();
    const first = write("plain before progress\r\n");
    const second = write("20%\rERROR: rewritten\r\n");
    await Promise.all([first, second]);
    expect(highlighter.snapshot()?.spans).toHaveLength(0);
    await write("Mode                 LastWriteTime         Length Name\r\nd----         2026/10/8     12:30                Custom\r\n");
    expect(highlighter.snapshot()?.spans).toHaveLength(0);
    await write("'ls' is not recognized as an internal or external command,\r\noperable program or batch file.\r\n");
    expect(highlighter.snapshot()?.spans).toHaveLength(2);
  });
  it("清屏清理、滚动裁剪限制数量、重启与卸载移除监听和计时", async () => {
    const { highlighter, write, execute, unavailable, terminal } = setup(100, 5, 10); await execute();
    await write(Array.from({ length: 100 }, (_, i) => `ERROR: ${i}\r\n`).join(""));
    expect(highlighter.snapshot()!.spans.length).toBeLessThanOrEqual(15);
    await write("\x1b[2J"); expect(highlighter.snapshot()?.spans.every(span => span.line < terminal.buffer.normal.baseY)).toBe(true);
    await write("\x1b[3J"); expect(highlighter.snapshot()?.spans).toHaveLength(0);
    highlighter.begin(token); highlighter.dispose();
    await write(osc("failed")); expect(unavailable).not.toHaveBeenCalled();
  });
  it("恢复装饰和阶段，不接受旧令牌和裁剪后的显示位置", async () => {
    const { highlighter, write, execute, terminal } = setup(); await execute();
    await write("ERROR: retained\r\n"); const snapshot = highlighter.snapshot()!;
    highlighter.restore(snapshot, token, false); expect(highlighter.snapshot()?.spans).toHaveLength(1);
    terminal.options.theme = { red: "#ab0000" }; highlighter.refresh();
    highlighter.restore(snapshot, token, true); expect(highlighter.snapshot()?.spans).toHaveLength(0);
    highlighter.restore(snapshot, "a6b4ea51-2f6b-4449-9550-f4b20082a620", false);
    expect(highlighter.snapshot()?.ready).toBe(false);
  });
  it("降级提示每次启动仅一次；初始化成功、结束和卸载取消迟到提示", async () => {
    vi.useFakeTimers();
    const { highlighter, unavailable } = setup();
    highlighter.started(); vi.advanceTimersByTime(15000); expect(unavailable).toHaveBeenCalledTimes(1);
    highlighter.handleOsc(`fstty-highlight:${token}:failed:psreadline-import`);
    expect(unavailable).toHaveBeenCalledTimes(1);
    highlighter.begin(token); highlighter.started(); highlighter.handleOsc(`fstty-highlight:${token}:ready`);
    vi.advanceTimersByTime(15000); expect(unavailable).toHaveBeenCalledTimes(1);
    highlighter.begin(token); highlighter.started(); highlighter.ended(); vi.advanceTimersByTime(15000);
    expect(unavailable).toHaveBeenCalledTimes(1);
    highlighter.begin(token); highlighter.started(); highlighter.dispose(); vi.advanceTimersByTime(15000);
    expect(unavailable).toHaveBeenCalledTimes(1);
  });
});
