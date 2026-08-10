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

function expectRuleUses(css, selector, declaration) {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rule = new RegExp(`${escapedSelector}\\s*\\{[^}]*${declaration}`, "s");
  expect(css).toMatch(rule);
}

describe("主题样式契约", () => {
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
});
