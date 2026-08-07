// @vitest-environment jsdom

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import ReleaseNotesMarkdown from "./ReleaseNotesMarkdown";

describe("更新说明 Markdown", () => {
  it("不渲染链接、图片和 HTML", () => {
    const { container } = render(
      <ReleaseNotesMarkdown
        content={'[链接](https://example.com) ![图片](https://example.com/a.png) <script>alert("x")</script>'}
      />,
    );

    expect(container.querySelector("a")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).toContain("链接");
  });
});
