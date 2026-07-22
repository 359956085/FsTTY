interface ImeCompositionFallback {
  compositionStart: () => void;
  compositionEnd: () => void;
  handleKeyDown: (
    event: Pick<
      KeyboardEvent,
      "altKey" | "code" | "ctrlKey" | "key" | "keyCode" | "metaKey"
    >,
  ) => void;
  handleKeyUp: (event: Pick<KeyboardEvent, "code" | "key" | "keyCode">) => void;
  takeFinalInput: (
    event: Pick<InputEvent, "data" | "inputType" | "isComposing">,
  ) => string | null;
  reset: () => void;
  dispose: () => void;
}

export function createImeCompositionFallback(): ImeCompositionFallback {
  let shiftCommitPending = false;
  let finalInputHandled = false;
  let disposed = false;

  function resetState() {
    shiftCommitPending = false;
    finalInputHandled = false;
  }

  function compositionStart() {
    resetState();
  }

  function compositionEnd() {
    resetState();
  }

  function handleKeyDown(
    event: Pick<
      KeyboardEvent,
      "altKey" | "code" | "ctrlKey" | "key" | "keyCode" | "metaKey"
    >,
  ) {
    if (disposed) {
      return;
    }
    if (isShiftEvent(event) && !event.altKey && !event.ctrlKey && !event.metaKey) {
      shiftCommitPending = true;
      finalInputHandled = false;
      return;
    }
    resetState();
  }

  function handleKeyUp(event: Pick<KeyboardEvent, "code" | "key" | "keyCode">) {
    if (isShiftEvent(event)) {
      resetState();
    }
  }

  function takeFinalInput(
    event: Pick<InputEvent, "data" | "inputType" | "isComposing">,
  ) {
    if (
      disposed ||
      !shiftCommitPending ||
      finalInputHandled ||
      event.inputType !== "insertText" ||
      event.isComposing !== false ||
      !event.data
    ) {
      return null;
    }
    // WebView2 搜狗事件没有 composition 生命周期，只能以紧跟 Shift 的最终 insertText 为准。
    finalInputHandled = true;
    shiftCommitPending = false;
    return event.data;
  }

  function reset() {
    resetState();
  }

  function dispose() {
    reset();
    disposed = true;
  }

  return {
    compositionStart,
    compositionEnd,
    handleKeyDown,
    handleKeyUp,
    takeFinalInput,
    reset,
    dispose,
  };
}

function isShiftEvent(event: Pick<KeyboardEvent, "code" | "key" | "keyCode">) {
  return (
    event.key === "Shift" ||
    event.code === "ShiftLeft" ||
    event.code === "ShiftRight" ||
    event.keyCode === 16
  );
}
