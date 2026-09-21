import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const baseCss = readFileSync(new URL("../src/styles/base.css", import.meta.url), "utf8");
const sessionsCss = readFileSync(
  new URL("../src/styles/sessions.css", import.meta.url),
  "utf8",
);
const settingsCss = readFileSync(
  new URL("../src/styles/settings.css", import.meta.url),
  "utf8",
);

function splitSelectorList(selectorList) {
  const selectors = [];
  let start = 0;
  let nesting = 0;
  let quote = "";
  // 只拆分顶层逗号，保留伪类参数和属性值中的逗号。
  for (let index = 0; index < selectorList.length; index += 1) {
    const character = selectorList[index];
    if (character === "\\") {
      index += 1;
      continue;
    }
    if (quote) {
      if (character === quote) quote = "";
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
    } else if (character === "(" || character === "[") {
      nesting += 1;
    } else if (character === ")" || character === "]") {
      nesting -= 1;
    } else if (character === "," && nesting === 0) {
      selectors.push(selectorList.slice(start, index).trim());
      start = index + 1;
    }
  }
  selectors.push(selectorList.slice(start).trim());
  return selectors;
}

function expectRuleUses(css, selector, declaration) {
  const rules = css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g);
  const declarations = [...rules]
    .filter(([, selectors]) =>
      splitSelectorList(selectors).includes(selector),
    )
    .map(([, , body]) => body);
  const declarationPattern = new RegExp(`(?:^|;)\\s*${declaration}\\s*(?:;|$)`, "s");
  expect(
    declarations.some((body) => declarationPattern.test(body)),
    `${selector} 应包含 ${declaration}`,
  ).toBe(true);
}

describe("样式断言辅助函数", () => {
  it.each(["hover", "active", "focus-visible"])("匹配分组中的 %s 完整选择器", (state) => {
    const css = `
      .control:hover,
      .control:active,
      .control:focus-visible {
        background: transparent;
      }
    `;
    expectRuleUses(css, `.control:${state}`, "background: transparent");
  });

  it.each([
    ":is(.control:hover, .control:not(.other, .another))",
    '[data-label="a, b"] .control',
    String.raw`.control\,other`,
  ])("保留复杂选择器中的逗号：%s", (selector) => {
    const css = `${selector}, .other { background: transparent; }`;
    expectRuleUses(css, selector, "background: transparent");
  });

  it.each([
    ["其他控件", ".other, .another { background: transparent; }"],
    ["父级作用域", ".scope .control { background: transparent; }"],
    ["相似类名", ".other-control { background: transparent; }"],
    ["其他状态", ".control:hover { background: transparent; }"],
    ["伪元素", ".control::after { background: transparent; }"],
    ["注释中的规则", "/* .control { background: transparent; } */"],
    ["其他属性", ".control { --background: transparent; }"],
    ["其他规则的声明", ".control { color: inherit; } .other { background: transparent; }"],
    ["伪类参数", ":is(.other, .control, .another) { background: transparent; }"],
    ["属性值", '[data-label="other, .control, another"] { background: transparent; }'],
  ])("不会误匹配%s", (_, css) => {
    expect(() => expectRuleUses(css, ".control", "background: transparent")).toThrow(
      ".control 应包含 background: transparent",
    );
  });
});

describe("主题样式契约", () => {
  it("会话搜索框聚焦无蓝框且保留细边框与其他控件焦点指示", () => {
    expectRuleUses(baseCss, ".session-search-row .text-input:focus-visible", "outline: none");
    expectRuleUses(baseCss, ".search-box", "border: 1px solid var\\(--border\\)");
    expectRuleUses(baseCss, ".search-box .text-input", "border: 0");
    const globalFocusRule = baseCss.match(/button:focus-visible,[^{}]*\{[^}]*\}/)?.[0] ?? "";
    for (const selector of ["input", "button", "select", "textarea", '[role="separator"]']) {
      expect(globalFocusRule).toContain(`${selector}:focus-visible`);
    }
    expect(globalFocusRule).toContain("outline: 2px solid var(--focus-ring)");
  });

  it("轻量叶子按钮点击区随标题栏高度且所有状态无边框背景或阴影", () => {
    expectRuleUses(baseCss, ".lightweight-control", "width: 46px");
    expectRuleUses(baseCss, ".lightweight-control", "height: 100%");
    expectRuleUses(baseCss, ".lightweight-control", "border: 0");
    expectRuleUses(baseCss, ".lightweight-control", "background: transparent");
    for (const state of ["hover", "active", "focus", "focus-visible"]) {
      expectRuleUses(baseCss, `.lightweight-control:${state}`, "border: 0");
      expectRuleUses(baseCss, `.lightweight-control:${state}`, "outline: 0");
      expectRuleUses(baseCss, `.lightweight-control:${state}`, "background: transparent");
    }
    expectRuleUses(baseCss, ".lightweight-control:disabled", "opacity: 1");
    const leafRules = baseCss.match(/[^{}]*\.lightweight-control[^{}]*\{[^}]*\}/g) ?? [];
    expect(leafRules.length).toBeGreaterThan(2);
    expect(leafRules.join("\n")).not.toMatch(/box-shadow|drop-shadow|filter:/);
  });

  it("应用外壳和页面根节点只使用语义背景", () => {
    expect(baseCss).toContain("--app-shell-bg: #f7f9fb;");
    expect(baseCss).toContain("--page-bg: #f7f9fb;");
    expectRuleUses(baseCss, ".app-shell", "background: var\\(--app-shell-bg\\)");
    expectRuleUses(baseCss, ".sessions-page", "background: var\\(--page-bg\\)");
    expectRuleUses(baseCss, ".workspace-grid", "background: var\\(--page-bg\\)");
    expectRuleUses(settingsCss, ".settings-page", "background: var\\(--page-bg\\)");
    expectRuleUses(settingsCss, ".settings-content", "background: var\\(--page-bg\\)");
    expectRuleUses(
      settingsCss,
      ".settings-sidebar",
      "background: var\\(--settings-sidebar-bg\\)",
    );
    expectRuleUses(
      settingsCss,
      ".settings-panel",
      "background: var\\(--settings-panel-bg\\)",
    );
  });

  it("亮色主工作区使用独立分层背景和常驻模块分隔线", () => {
    for (const declaration of [
      "--titlebar-bg: #f8fafd;",
      "--workspace-tabs-bg: #ebeff4;",
      "--workspace-sidebar-bg: #f2f5f8;",
      "--workspace-files-bg: #f4f6f9;",
      "--workspace-status-bg: #f0f3f7;",
      "--workspace-divider: #d1d8e2;",
      "--workspace-panel-divider: #d1d8e2;",
      "--workspace-resize-divider: #d1d8e2;",
      "--terminal-bg: #f6f8fa;",
      "--terminal-overlay: #f6f8fa;",
    ]) {
      expect(baseCss).toContain(declaration);
    }
    for (const declaration of [
      "--workspace-tabs-bg: var(--workspace-surface);",
      "--workspace-sidebar-bg: var(--workspace-surface);",
      "--workspace-files-bg: var(--workspace-surface);",
      "--workspace-status-bg: var(--workspace-surface);",
      "--workspace-panel-divider: transparent;",
      "--workspace-resize-divider: transparent;",
    ]) {
      expect(baseCss).toContain(declaration);
    }
    expectRuleUses(
      baseCss,
      ".session-sidebar",
      "background: var\\(--workspace-sidebar-bg\\)",
    );
    expectRuleUses(
      sessionsCss,
      ".session-tabs",
      "background: var\\(--workspace-tabs-bg\\)",
    );
    expectRuleUses(
      sessionsCss,
      ".files-panel",
      "background: var\\(--workspace-files-bg\\)",
    );
    expectRuleUses(
      sessionsCss,
      ".file-head",
      "background: var\\(--workspace-files-bg\\)",
    );
    expectRuleUses(
      sessionsCss,
      ".status-panel",
      "background: var\\(--workspace-status-bg\\)",
    );
    expectRuleUses(
      sessionsCss,
      ".status-panel",
      "border-top: 1px solid var\\(--workspace-panel-divider\\)",
    );
    expectRuleUses(
      sessionsCss,
      ".sessions-page > .resize-handle-vertical",
      "background: linear-gradient\\(to right, transparent 1px, var\\(--workspace-resize-divider\\) 1px 3px, transparent 3px\\)",
    );
    expectRuleUses(
      sessionsCss,
      ".workspace-grid > .resize-handle-vertical",
      "background: linear-gradient\\(to right, transparent 1px, var\\(--workspace-resize-divider\\) 1px 3px, transparent 3px\\)",
    );
  });

  it("交互控件不再依赖固定暗色中性色", () => {
    expect(sessionsCss).not.toContain("background: #111820;");
    expectRuleUses(
      sessionsCss,
      ".command-history-item.active",
      "background: var\\(--surface-hover\\)",
    );
    expectRuleUses(
      settingsCss,
      ".settings-auto-update-toggle",
      "background: var\\(--switch-bg\\)",
    );
  });

  it("全局滚动条固定为八像素且保持透明轨道", () => {
    expect(baseCss).toContain("--scrollbar-size: 8px;");
    expectRuleUses(
      baseCss,
      "*::-webkit-scrollbar",
      "width: var\\(--scrollbar-size\\)",
    );
    expectRuleUses(
      baseCss,
      "*::-webkit-scrollbar",
      "height: var\\(--scrollbar-size\\)",
    );
    expectRuleUses(baseCss, "*::-webkit-scrollbar-track", "background: transparent");
    expectRuleUses(baseCss, "*::-webkit-scrollbar-corner", "background: transparent");
    expectRuleUses(
      baseCss,
      "*::-webkit-scrollbar-thumb",
      "background: var\\(--scrollbar-thumb\\)",
    );
    expect(baseCss).toMatch(
      /@supports not selector\(::-webkit-scrollbar\)\s*\{[\s\S]*scrollbar-color: var\(--scrollbar-thumb\) transparent;[\s\S]*scrollbar-width: thin;/,
    );
    expect(sessionsCss).toContain(".session-tabs::-webkit-scrollbar");
    expect(sessionsCss).toContain("display: none;");
  });

  it("文件表头分隔线默认透明且交互时高亮并与列间距居中对齐", () => {
    expectRuleUses(sessionsCss, ".file-table", "--file-column-gap: 0px");
    expectRuleUses(sessionsCss, ".file-row", "column-gap: var\\(--file-column-gap\\)");
    expectRuleUses(
      sessionsCss,
      ".file-column-resizer.resize-handle-vertical",
      "right: -4px",
    );
    expectRuleUses(
      sessionsCss,
      ".file-column-resizer.resize-handle-vertical",
      "width: 8px",
    );
    expectRuleUses(
      sessionsCss,
      ".file-column-resizer.resize-handle-vertical::after",
      "left: 4px",
    );
    expectRuleUses(
      sessionsCss,
      ".file-column-resizer.resize-handle-vertical::after",
      "width: 1px",
    );
    expectRuleUses(
      sessionsCss,
      ".file-column-resizer.resize-handle-vertical::after",
      "background: transparent",
    );
    for (const state of ["hover", "active", "focus-visible"]) {
      expectRuleUses(
        sessionsCss,
        `.file-column-resizer.resize-handle-vertical:${state}::after`,
        "background: var\\(--resize-highlight\\)",
      );
    }
  });

  it("文件表头与数据列共享左侧内容留白", () => {
    expectRuleUses(sessionsCss, ".file-table", "--file-column-content-inset: 6px");
    expectRuleUses(
      sessionsCss,
      ".file-row > :not(:first-child)",
      "padding-left: var\\(--file-column-content-inset\\)",
    );
  });
});
