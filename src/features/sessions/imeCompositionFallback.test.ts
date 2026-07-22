import { describe, expect, it } from "vitest";
import { createImeCompositionFallback } from "./imeCompositionFallback";

describe("createImeCompositionFallback", () => {
  const plainShift = {
    altKey: false,
    code: "ShiftLeft",
    ctrlKey: false,
    key: "Shift",
    keyCode: 16,
    metaKey: false,
  };
  const finalInput = {
    data: "abcde",
    inputType: "insertText",
    isComposing: false,
  };

  it("按真实 WebView2 顺序接管五字符最终输入一次", () => {
    const fallback = createImeCompositionFallback();

    fallback.handleKeyDown(plainShift);

    expect(fallback.takeFinalInput(finalInput)).toBe("abcde");
    expect(fallback.takeFinalInput(finalInput)).toBeNull();
    fallback.handleKeyUp(plainShift);
  });

  it("原生组合结束先到达时不接管", () => {
    const fallback = createImeCompositionFallback();

    fallback.compositionStart();
    fallback.handleKeyDown(plainShift);
    fallback.compositionEnd();

    expect(fallback.takeFinalInput(finalInput)).toBeNull();
  });

  it("忽略空数据、组合中输入和错误输入类型", () => {
    const fallback = createImeCompositionFallback();

    fallback.handleKeyDown(plainShift);
    expect(
      fallback.takeFinalInput({ data: "", inputType: "insertText", isComposing: false }),
    ).toBeNull();
    expect(fallback.takeFinalInput({ ...finalInput, isComposing: true })).toBeNull();
    expect(
      fallback.takeFinalInput({
        data: "abcde",
        inputType: "insertCompositionText",
        isComposing: false,
      }),
    ).toBeNull();

    expect(fallback.takeFinalInput(finalInput)).toBe("abcde");
  });

  it("普通大写和带修饰键的 Shift 不触发兜底", () => {
    const fallback = createImeCompositionFallback();

    fallback.handleKeyDown({ ...plainShift, ctrlKey: true });
    expect(fallback.takeFinalInput(finalInput)).toBeNull();

    fallback.handleKeyDown(plainShift);
    fallback.handleKeyDown({ ...plainShift, code: "KeyA", key: "A", keyCode: 65 });
    expect(fallback.takeFinalInput(finalInput)).toBeNull();
  });

  it("兼容 code 和 keyCode 识别 Shift", () => {
    const fallback = createImeCompositionFallback();

    fallback.handleKeyDown({ ...plainShift, key: "Unidentified", keyCode: 0 });
    expect(fallback.takeFinalInput(finalInput)).toBe("abcde");

    fallback.handleKeyDown({ ...plainShift, code: "", key: "Unidentified" });
    expect(fallback.takeFinalInput(finalInput)).toBe("abcde");
  });

  it("Shift 松开、重置和销毁会清理状态", () => {
    const fallback = createImeCompositionFallback();

    fallback.handleKeyDown(plainShift);
    fallback.handleKeyUp(plainShift);
    expect(fallback.takeFinalInput(finalInput)).toBeNull();

    fallback.handleKeyDown(plainShift);
    fallback.reset();
    expect(fallback.takeFinalInput(finalInput)).toBeNull();

    fallback.handleKeyDown(plainShift);
    fallback.dispose();
    expect(fallback.takeFinalInput(finalInput)).toBeNull();
  });
});
