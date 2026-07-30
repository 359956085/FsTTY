import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import ReleaseNotesMarkdown from "./ReleaseNotesMarkdown";

describe("更新说明 Markdown", () => {
  it("渲染基础 Markdown 和 GFM", () => {
    const html = renderToStaticMarkup(
      <ReleaseNotesMarkdown
        content={"## 标题\n\n- 列表\n\n**粗体**和`代码`\n\n| 项目 | 状态 |\n| --- | --- |\n| 更新 | 完成 |"}
      />,
    );

    expect(html).toContain("<h2>标题</h2>");
    expect(html).toContain("<li>列表</li>");
    expect(html).toContain("<strong>粗体</strong>");
    expect(html).toContain("<code>代码</code>");
    expect(html).toContain("<table>");
  });

  it("忽略原始 HTML、链接和图片", () => {
    const html = renderToStaticMarkup(
      <ReleaseNotesMarkdown
        content={
          '<script>alert("xss")</script>\n\n[链接](https://example.com)\n\n![图片](https://example.com/a.png)'
        }
      />,
    );

    expect(html).not.toContain("<script");
    expect(html).not.toContain("<a");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("href=");
    expect(html).not.toContain("src=");
    expect(html).toContain("链接");
  });
});
