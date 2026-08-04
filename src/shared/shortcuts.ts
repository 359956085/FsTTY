import type { ShortcutBinding, ShortcutSettings } from "./api/types";

export type ShortcutAction = keyof ShortcutSettings;
export type ShortcutValidationError = "modifierRequired" | "reserved" | "unsupported";

export const SHORTCUT_ACTIONS: ShortcutAction[] = [
  "terminalCopy",
  "terminalPaste",
  "commandHistory",
  "commandHistorySearch",
];

export const DEFAULT_SHORTCUTS: ShortcutSettings = {
  terminalCopy: { code: "KeyC", ctrl: true, alt: false, shift: false },
  terminalPaste: { code: "KeyV", ctrl: true, alt: false, shift: false },
  commandHistory: { code: "KeyH", ctrl: true, alt: false, shift: true },
  commandHistorySearch: { code: "KeyF", ctrl: true, alt: false, shift: false },
};

interface ShortcutEvent {
  altKey: boolean;
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

export function shortcutFromEvent(event: ShortcutEvent): ShortcutBinding | null {
  if (event.metaKey || isModifierCode(event.code)) return null;
  return {
    code: event.code,
    ctrl: event.ctrlKey,
    alt: event.altKey,
    shift: event.shiftKey,
  };
}

export function matchesShortcut(event: ShortcutEvent, shortcut: ShortcutBinding) {
  return (
    !event.metaKey &&
    event.code === shortcut.code &&
    event.ctrlKey === shortcut.ctrl &&
    event.altKey === shortcut.alt &&
    event.shiftKey === shortcut.shift
  );
}

export function validateShortcut(shortcut: ShortcutBinding): ShortcutValidationError | null {
  if (!shortcut.ctrl && !shortcut.alt) return "modifierRequired";
  if (!isSupportedCode(shortcut.code)) return "unsupported";
  if (isReservedShortcut(shortcut)) return "reserved";
  return null;
}

export function findShortcutConflict(
  shortcuts: ShortcutSettings,
  action: ShortcutAction,
  next: ShortcutBinding,
): ShortcutAction | null {
  return (
    SHORTCUT_ACTIONS.find(
      (candidate) => candidate !== action && shortcutsEqual(shortcuts[candidate], next),
    ) ?? null
  );
}

export function formatShortcut(shortcut: ShortcutBinding) {
  const parts: string[] = [];
  if (shortcut.ctrl) parts.push("Ctrl");
  if (shortcut.alt) parts.push("Alt");
  if (shortcut.shift) parts.push("Shift");
  parts.push(formatCode(shortcut.code));
  return parts.join("+");
}

export function shortcutsEqual(left: ShortcutBinding, right: ShortcutBinding) {
  return (
    left.code === right.code &&
    left.ctrl === right.ctrl &&
    left.alt === right.alt &&
    left.shift === right.shift
  );
}

function isModifierCode(code: string) {
  return [
    "AltLeft",
    "AltRight",
    "ControlLeft",
    "ControlRight",
    "MetaLeft",
    "MetaRight",
    "ShiftLeft",
    "ShiftRight",
  ].includes(code);
}

function isSupportedCode(code: string) {
  if (/^Key[A-Z]$/.test(code) || /^Digit[0-9]$/.test(code) || /^F(?:[1-9]|1[0-2])$/.test(code)) {
    return true;
  }
  return [
    "Minus",
    "Equal",
    "BracketLeft",
    "BracketRight",
    "Backslash",
    "Semicolon",
    "Quote",
    "Comma",
    "Period",
    "Slash",
    "Backquote",
    "Space",
    "Home",
    "End",
    "PageUp",
    "PageDown",
    "Insert",
    "Delete",
  ].includes(code);
}

function isReservedShortcut(shortcut: ShortcutBinding) {
  return (
    (shortcut.alt && !shortcut.ctrl && shortcut.code === "F4") ||
    (shortcut.ctrl && shortcut.alt && shortcut.code === "Delete")
  );
}

function formatCode(code: string) {
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  const labels: Record<string, string> = {
    Backquote: "`",
    Backslash: "\\",
    BracketLeft: "[",
    BracketRight: "]",
    Comma: ",",
    Delete: "Delete",
    End: "End",
    Equal: "=",
    Home: "Home",
    Insert: "Insert",
    Minus: "-",
    PageDown: "PageDown",
    PageUp: "PageUp",
    Period: ".",
    Quote: "'",
    Semicolon: ";",
    Slash: "/",
    Space: "Space",
  };
  return labels[code] ?? code;
}
