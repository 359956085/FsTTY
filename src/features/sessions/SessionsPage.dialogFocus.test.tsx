// @vitest-environment jsdom
import { createRef, useState, type ComponentProps } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "../../shared/api/types";
import { DEFAULT_SHORTCUTS } from "../../shared/shortcuts";
import { SessionsPage } from "./SessionsPage";

const state = vi.hoisted(() => ({ hideRow: false }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("../../shared/platform", () => ({ usesWindowsCredentialBroker: () => true }));
vi.mock("../../shared/i18n", () => ({ default: { t: (key: string) => key } }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ confirm: vi.fn(), open: vi.fn() }));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: vi.fn() }));
vi.mock("../lightweight/useLightweightRestore", () => ({ useLightweightRestore: () => ({ error: null }) }));
vi.mock("./FilesPane", () => ({ FilesPane: () => null }));
vi.mock("./DeviceStatusPanel", () => ({ DeviceStatusPanel: () => null }));
vi.mock("./TerminalPane", () => ({ TerminalPane: () => null }));
vi.mock("./useSessionConnections", async (importOriginal) => ({
  ...await importOriginal<typeof import("./useSessionConnections")>(),
  useSessionConnections: () => ({ runtimes: {}, pruneRuntimes: vi.fn() }),
}));
vi.mock("./useSessionsPageState", () => ({ useSessionsPageState: useStateFixture }));

const session: Session = {
  id: "server", name: "Production", host: "example.test", port: 22, username: "test",
  group: "Servers", tags: [], auth: { kind: "password" }, credentialState: "stored", loginSavePrompted: false,
};
function useStateFixture() {
  const [dialogState, setDialogState] = useState<{ mode: "create" | "edit"; session?: Session } | null>(null);
  return {
    sessionsReady: true, loading: false, error: null, activeTabId: null, openSessionTabs: [],
    groups: state.hideRow ? [] : [{ name: "Servers", sessions: [session] }], sessions: [session],
    collapsedGroupNames: [], favoriteSessionIds: [], filter: "all", query: "", listMutationPending: false,
    dialogState, setDialogState, saveSession: async () => setDialogState(null),
  };
}
const props: ComponentProps<typeof SessionsPage> = {
  paneLayout: {
    rootRef: createRef(), layout: { leftWidth: 260, rightWidth: 460, leftCollapsed: false, rightCollapsed: false },
    adjustResize: vi.fn(), beginResize: vi.fn(), toggleLeftCollapsed: vi.fn(), toggleRightCollapsed: vi.fn(),
  },
  allowRemoteClipboardWrite: true, shortcuts: DEFAULT_SHORTCUTS, theme: "dark", terminalColorScheme: "default", visible: true,
};
beforeEach(() => { state.hideRow = false; });
afterEach(cleanup);

describe("会话弹窗入口焦点", () => {
  it.each([0, 1])("新建入口 %i 关闭后回到实际按钮", (index) => {
    render(<SessionsPage {...props} />);
    const opener = screen.getAllByRole("button", { name: "sessions.new" })[index];
    fireEvent.click(opener);
    expect(document.activeElement).toBe(screen.getByLabelText(/sessions.host/));
    fireEvent.change(document.activeElement!, { target: { value: "unsaved.test" } });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
    fireEvent.click(opener);
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("编辑菜单卸载后返回会话行", () => {
    render(<SessionsPage {...props} />);
    const row = screen.getByText("Production").closest("button");
    fireEvent.contextMenu(row!);
    const edit = screen.getByRole("menuitem", { name: "sessions.edit" });
    edit.focus();
    fireEvent.click(edit);
    expect(edit.isConnected).toBe(false);
    expect(document.activeElement).toBe(screen.getByLabelText(/sessions.host/));
    fireEvent.click(screen.getByRole("button", { name: "sessions.close" }));
    expect(document.activeElement).toBe(row);
  });

  it("编辑期间会话行消失时回到标签栏新建入口", () => {
    const { rerender } = render(<SessionsPage {...props} />);
    const fallback = screen.getAllByRole("button", { name: "sessions.new" })[1];
    fireEvent.contextMenu(screen.getByText("Production"));
    fireEvent.click(screen.getByRole("menuitem", { name: "sessions.edit" }));
    state.hideRow = true;
    rerender(<SessionsPage {...props} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(document.activeElement).toBe(fallback);
  });

  it("保存成功关闭后返回编辑行", async () => {
    render(<SessionsPage {...props} />);
    const row = screen.getByText("Production").closest("button");
    fireEvent.contextMenu(row!);
    fireEvent.click(screen.getByRole("menuitem", { name: "sessions.edit" }));
    fireEvent.click(screen.getByRole("button", { name: "sessions.save" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(row);
  });
});
