import { describe, expect, it } from "vitest";
import {
  createRemoteRightDragState,
  shouldOpenLocalTerminalContextMenu,
} from "./terminalContextMenu";

const REMOTE_MOUSE_TRACKING_MODES = ["x10", "vt200", "drag", "any"] as const;

describe("shouldOpenLocalTerminalContextMenu", () => {
  it("opens the local menu when remote mouse tracking is disabled", () => {
    expect(shouldOpenLocalTerminalContextMenu("none", false)).toBe(true);
    expect(shouldOpenLocalTerminalContextMenu("none", true)).toBe(true);
  });

  it.each(REMOTE_MOUSE_TRACKING_MODES)(
    "keeps %s right clicks in the remote application",
    (mode) => {
      expect(shouldOpenLocalTerminalContextMenu(mode, false)).toBe(false);
    },
  );

  it.each(REMOTE_MOUSE_TRACKING_MODES)(
    "opens the local menu for Shift+right-click in %s mode",
    (mode) => {
      expect(shouldOpenLocalTerminalContextMenu(mode, true)).toBe(true);
    },
  );
});

describe("createRemoteRightDragState", () => {
  it.each(["drag", "any"] as const)(
    "passes through valid right-button movement in %s mode",
    (mode) => {
      const state = createRemoteRightDragState();
      state.begin({
        button: 2,
        enabled: true,
        mouseTrackingMode: mode,
        shiftKey: false,
      });

      expect(state.getMoveAction(mode, 2, false)).toEqual({
        kind: "passthrough",
      });
    },
  );

  it("rearms xterm listeners once when drag mode changes to any", () => {
    const state = createRemoteRightDragState();
    state.begin({
      button: 2,
      enabled: true,
      mouseTrackingMode: "drag",
      shiftKey: false,
    });

    expect(state.getMoveAction("any", 2, false)).toEqual({
      kind: "rearmAndRedispatchRightDrag",
    });
    expect(state.getMoveAction("any", 2, false)).toEqual({
      kind: "passthrough",
    });
  });

  it("does not rearm when a gesture starts in any mode", () => {
    const state = createRemoteRightDragState();
    state.begin({
      button: 2,
      enabled: true,
      mouseTrackingMode: "any",
      shiftKey: false,
    });

    expect(state.getMoveAction("any", 2, false)).toEqual({
      kind: "passthrough",
    });
  });

  it("rearms listeners before pointerup when no movement was received", () => {
    const state = createRemoteRightDragState();
    state.begin({
      button: 2,
      enabled: true,
      mouseTrackingMode: "drag",
      pointerId: 7,
      shiftKey: false,
    });

    expect(state.getPointerUpAction("any", 7)).toEqual({
      kind: "rearmListeners",
    });
    expect(state.getPointerUpAction("any", 7)).toEqual({ kind: "continue" });
    expect(state.getPointerUpAction("any", 8)).toEqual({ kind: "ignore" });
  });

  it.each(["drag", "any"] as const)(
    "repairs a missing right-button bit in %s mode",
    (mode) => {
      const state = createRemoteRightDragState();
      state.begin({
        button: 2,
        enabled: true,
        mouseTrackingMode: mode,
        shiftKey: false,
      });

      expect(state.getMoveAction(mode, 0, false)).toEqual({
        kind: "repairRightDrag",
      });
      expect(state.getMoveAction(mode, undefined, false)).toEqual({
        kind: "repairRightDrag",
      });
    },
  );

  it("ignores synthetic movement to prevent recursive repair", () => {
    const state = createRemoteRightDragState();
    state.begin({
      button: 2,
      enabled: true,
      mouseTrackingMode: "drag",
      shiftKey: false,
    });

    expect(state.getMoveAction("any", 2, true)).toEqual({ kind: "ignore" });
    expect(state.getMoveAction("any", 2, false)).toEqual({
      kind: "rearmAndRedispatchRightDrag",
    });
  });

  it("does not repair movement in protocols without move support", () => {
    const state = createRemoteRightDragState();
    state.begin({
      button: 2,
      enabled: true,
      mouseTrackingMode: "vt200",
      shiftKey: false,
    });

    expect(state.getMoveAction("vt200", 0, false)).toEqual({ kind: "ignore" });
    expect(state.getMoveAction("x10", 0, false)).toEqual({ kind: "ignore" });
  });

  it.each([
    ["the terminal is inactive", { enabled: false, button: 2, shiftKey: false, mode: "any" }],
    ["remote mouse tracking is disabled", { enabled: true, button: 2, shiftKey: false, mode: "none" }],
    ["Shift forces local handling", { enabled: true, button: 2, shiftKey: true, mode: "any" }],
    ["another mouse button starts the drag", { enabled: true, button: 0, shiftKey: false, mode: "any" }],
  ] as const)("does not start when %s", (_name, input) => {
    const state = createRemoteRightDragState();
    state.begin({
      button: input.button,
      enabled: input.enabled,
      mouseTrackingMode: input.mode,
      shiftKey: input.shiftKey,
    });

    expect(state.getMoveAction("drag", 0, false)).toEqual({ kind: "ignore" });
  });

  it("clears the drag state on end", () => {
    const state = createRemoteRightDragState();
    state.begin({
      button: 2,
      enabled: true,
      mouseTrackingMode: "drag",
      shiftKey: false,
    });
    state.end();

    expect(state.getMoveAction("drag", 0, false)).toEqual({ kind: "ignore" });
  });

  it("passes through one valid native right-button release", () => {
    const state = createRemoteRightDragState();
    state.begin({
      button: 2,
      enabled: true,
      mouseTrackingMode: "any",
      pointerId: 7,
      shiftKey: false,
    });

    expect(state.getNativeReleaseAction(2, true)).toEqual({ kind: "ignore" });
    expect(state.getNativeReleaseAction(2, false)).toEqual({ kind: "passthrough" });
    expect(state.getNativeReleaseAction(2, false)).toEqual({ kind: "ignore" });
    expect(state.getFallbackReleaseAction(7)).toEqual({ kind: "ignore" });
  });

  it("requests fallback when native mouseup has the wrong button", () => {
    const state = createRemoteRightDragState();
    state.begin({
      button: 2,
      enabled: true,
      mouseTrackingMode: "any",
      pointerId: 7,
      shiftKey: false,
    });

    expect(state.getNativeReleaseAction(0, false)).toEqual({
      kind: "repairRightRelease",
    });
    expect(state.getFallbackReleaseAction(7)).toEqual({
      kind: "redispatch",
      button: 2,
      buttons: 0,
    });
  });

  it("uses one fallback release when native mouseup is missing", () => {
    const state = createRemoteRightDragState();
    state.begin({
      button: 2,
      enabled: true,
      mouseTrackingMode: "any",
      pointerId: 7,
      shiftKey: false,
    });

    expect(state.getFallbackReleaseAction(8)).toEqual({ kind: "ignore" });
    expect(state.getFallbackReleaseAction(7)).toEqual({
      kind: "redispatch",
      button: 2,
      buttons: 0,
    });
    expect(state.getFallbackReleaseAction(7)).toEqual({ kind: "ignore" });
  });

  it("only cancels the active pointer", () => {
    const state = createRemoteRightDragState();
    state.begin({
      button: 2,
      enabled: true,
      mouseTrackingMode: "drag",
      pointerId: 7,
      shiftKey: false,
    });

    state.cancelPointer(8);
    expect(state.getMoveAction("drag", 0, false)).toEqual({
      kind: "repairRightDrag",
    });
    state.cancelPointer(7);
    expect(state.getMoveAction("drag", 0, false)).toEqual({ kind: "ignore" });
    expect(state.getFallbackReleaseAction()).toEqual({ kind: "ignore" });
  });
});
