// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveSessionDropTarget } from "./sessionDragDrop";

afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(document, "elementFromPoint");
  document.body.replaceChildren();
});

describe("会话拖放目标", () => {
  it("按会话行中点判断插入方向", () => {
    const row = document.createElement("div");
    row.dataset.sessionIndex = "2";
    row.dataset.sessionGroupName = "prod";
    document.body.append(row);
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: () => row,
    });
    vi.spyOn(row, "getBoundingClientRect").mockReturnValue({
      top: 100,
      height: 40,
    } as DOMRect);

    expect(
      resolveSessionDropTarget(10, 110, {
        kind: "session",
        sessionId: "source",
        groupName: "test",
        sessionIndex: 0,
      }),
    ).toEqual({
      kind: "session",
      groupName: "prod",
      sessionIndex: 2,
      edge: "before",
    });
  });
});
