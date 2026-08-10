// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useMcpPromptCopy } from "./useMcpPromptCopy";

const mocks = vi.hoisted(() => ({ getMcpAgentPrompt: vi.fn(), writeText: vi.fn() }));

vi.mock("../../shared/api/client", () => ({ api: { getMcpAgentPrompt: mocks.getMcpAgentPrompt } }));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: mocks.writeText }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

describe("useMcpPromptCopy", () => {
  it("卸载后丢弃复制结果并释放处理中状态", async () => {
    const request = deferred<string>();
    mocks.getMcpAgentPrompt.mockReturnValue(request.promise);
    mocks.writeText.mockResolvedValue(undefined);
    const setTooltip = vi.fn();
    const { result, unmount } = renderHook(() => useMcpPromptCopy(setTooltip));
    const target = document.createElement("button");

    let copy!: Promise<void>;
    act(() => { copy = result.current.copy("http", target); });
    unmount();
    request.resolve("prompt");
    await copy;

    expect(setTooltip).not.toHaveBeenCalled();
  });
});
