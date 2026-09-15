// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionFormDialog } from "./SessionFormDialog";
import type { CreateSessionPayload, UpdateSessionPayload } from "../../shared/api/types";

vi.mock("../../shared/platform", () => ({ usesWindowsCredentialBroker: () => true }));
vi.mock("react-i18next", () => {
  const t = (key: string) => key;
  return { useTranslation: () => ({ t }) };
});
vi.mock("@tauri-apps/plugin-dialog", () => ({ confirm: vi.fn(), open: vi.fn() }));
afterEach(cleanup);
describe("Windows 会话安全表单", () => {
  it("普通 WebView 不包含密码或私钥输入框，保存只提交认证目标", async () => {
    const save = vi.fn<(payload: CreateSessionPayload | UpdateSessionPayload) => Promise<void>>().mockResolvedValue(undefined);
    const { container } = render(<SessionFormDialog mode="create" groupOptions={[]} onClose={vi.fn()} onSave={save} />);
    expect(container.querySelector('input[type="password"]')).toBeNull();
    expect(container.querySelector("textarea")).toBeNull();
    expect(screen.getByText("security.secretInputHint")).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/sessions.host/), { target: { value: "test.example" } });
    fireEvent.change(screen.getByLabelText(/sessions.username/), { target: { value: "test" } });
    fireEvent.click(screen.getByRole("button", { name: "sessions.save" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const payload = save.mock.calls[0][0];
    expect(payload.host).toBe("test.example");
    expect(payload.username).toBe("test");
    expect(payload.credential).toEqual({ mode: "preserve" });
    expect(payload.auth).toEqual({ kind: "password" });
    expect(JSON.stringify(payload)).not.toContain("privateKeyContent");
  });
});
