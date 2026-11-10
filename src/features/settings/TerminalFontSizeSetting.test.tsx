// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "../../shared/i18n";
import { TerminalFontSizeSetting } from "./TerminalFontSizeSetting";

afterEach(cleanup);
describe("font size setting", () => {
  it.each(["zh-CN", "en-US"])("supports keyboard, blur, validation and external updates: %s", async (language) => {
    await i18n.changeLanguage(language);
    const onChange = vi.fn();
    const view = render(<TerminalFontSizeSetting value={13} onChange={onChange} />);
    const input = screen.getByRole("spinbutton", { name: i18n.t("settings.terminalFontSize") });
    fireEvent.change(input, { target: { value: "17" } });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenLastCalledWith(17);
    fireEvent.change(input, { target: { value: "32" } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenLastCalledWith(32);
    onChange.mockClear();
    for (const value of ["", "7", "33", "12.5"]) {
      fireEvent.change(input, { target: { value } });
      fireEvent.blur(input);
      expect(input.getAttribute("aria-invalid")).toBe("true");
      expect(screen.getByRole("alert").textContent).toBe(i18n.t("settings.terminalFontSizeInvalid"));
    }
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Escape" });
    expect((input as HTMLInputElement).value).toBe("13");
    view.rerender(<TerminalFontSizeSetting value={20} onChange={onChange} saving />);
    expect((input as HTMLInputElement).value).toBe("20");
    expect(input.getAttribute("aria-busy")).toBe("true");
    expect((input as HTMLInputElement).disabled).toBe(false);
  });
});
