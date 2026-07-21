export function hasControlCharacter(value: string, includeC1Controls = true) {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (
      codePoint <= 0x1f ||
      codePoint === 0x7f ||
      (includeC1Controls && codePoint >= 0x80 && codePoint <= 0x9f)
    ) {
      return true;
    }
  }
  return false;
}
