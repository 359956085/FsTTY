import { describe, expect, it } from "vitest";
import { createTerminalLoginInputController } from "./terminalLoginPrompt";

describe("terminalLoginPrompt", () => {
  it("账号输入正常回显并提交", () => {
    const controller = createTerminalLoginInputController();
    controller.start("username");
    expect(controller.handle("用").echo).toBe("用");
    expect(controller.handle("户\b名\r")).toEqual({
      kind: "submit",
      prompt: "username",
      value: "用名",
      echo: "户\b \b名\r\n",
    });
  });

  it("密码输入不回显", () => {
    const controller = createTerminalLoginInputController();
    controller.start("password");
    expect(controller.handle("秘密").echo).toBe("");
    expect(controller.handle("\r")).toEqual({
      kind: "submit",
      prompt: "password",
      value: "秘密",
      echo: "\r\n",
    });
  });

  it("Escape 和 Ctrl+C 取消输入并清空内容", () => {
    const controller = createTerminalLoginInputController();
    controller.start("password");
    controller.handle("secret");
    expect(controller.handle("\u001b").kind).toBe("cancel");
    expect(controller.getPrompt()).toBeNull();

    controller.start("username");
    controller.handle("root");
    expect(controller.handle("\u0003").kind).toBe("cancel");
    expect(controller.getPrompt()).toBeNull();
  });

  it("未启动提示时忽略输入", () => {
    const controller = createTerminalLoginInputController();
    expect(controller.handle("root\r")).toEqual({ kind: "pending", echo: "" });
  });
});
