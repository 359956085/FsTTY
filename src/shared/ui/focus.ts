export function isFocusAvailable(element: HTMLElement | null | undefined): element is HTMLElement {
  if (!element?.isConnected || element.matches(":disabled") || element.closest("[hidden], [inert], [aria-hidden='true']")) return false;
  for (let current: HTMLElement | null = element; current; current = current.parentElement) {
    const style = getComputedStyle(current);
    if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") return false;
  }
  return true;
}

export function isComposingKey(event: { isComposing?: boolean; keyCode?: number }) {
  return event.isComposing || event.keyCode === 229;
}

export function isContextMenuKey(event: { key: string; shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean }) {
  return event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey);
}

export function contextMenuPosition(target: HTMLElement, pointer?: { clientX: number; clientY: number }) {
  if (pointer && (pointer.clientX !== 0 || pointer.clientY !== 0)) return { x: pointer.clientX, y: pointer.clientY };
  const rect = target.getBoundingClientRect();
  return { x: rect.left, y: rect.bottom };
}

export function neighboringKeys(keys: readonly string[], anchor: string) {
  const index = keys.indexOf(anchor);
  return index < 0 ? [] : [...keys.slice(index + 1), ...keys.slice(0, index).reverse()];
}
