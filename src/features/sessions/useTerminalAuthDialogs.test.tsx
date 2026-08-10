// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useTerminalAuthDialogs } from "./useTerminalAuthDialogs";

describe("useTerminalAuthDialogs", () => {
  it("切换并取消凭据提示时清理输入和错误", () => {
    const { result } = renderHook(() => useTerminalAuthDialogs());
    act(() => {
      result.current.setCredentialPrompt("privateKeyPassphrase");
      result.current.setCredentialValue("secret");
      result.current.setDialogError("failed");
      result.current.setCredentialSubmitting(true);
    });
    act(() => result.current.cancelCredentialPrompt());
    expect(result.current.credentialPrompt).toBeNull();
    expect(result.current.credentialValue).toBe("");
    expect(result.current.dialogError).toBeNull();
    expect(result.current.credentialSubmitting).toBe(false);
  });

  it("统一清理终端登录和保存提示", () => {
    const { result } = renderHook(() => useTerminalAuthDialogs());
    act(() => {
      result.current.setTerminalLoginPrompt("username");
      result.current.setLoginSavePrompt("both");
      result.current.setLoginSaveError("failed");
      result.current.setLoginSaveSubmitting(true);
    });
    act(() => result.current.clearLoginPrompts());
    expect(result.current.terminalLoginPrompt).toBeNull();
    expect(result.current.loginSavePrompt).toBeNull();
    expect(result.current.loginSaveError).toBeNull();
    expect(result.current.loginSaveSubmitting).toBe(false);
  });
});
