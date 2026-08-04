import { hasControlCharacter } from "../../shared/validation/text";

export function decodeBase64(value: string) {
  const binary = window.atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export function isValidRemotePath(path: string) {
  return (
    path.startsWith("/") &&
    new TextEncoder().encode(path).byteLength <= 4096 &&
    !hasControlCharacter(path)
  );
}

export function quoteShellPath(path: string) {
  return `'${path.replace(/'/g, "'\\''")}'`;
}

export function splitUtf8(value: string, maxBytes: number) {
  const encoder = new TextEncoder();
  const chunks: string[] = [];
  let current = "";
  let currentBytes = 0;
  for (const character of value) {
    const bytes = encoder.encode(character).byteLength;
    if (current && currentBytes + bytes > maxBytes) {
      chunks.push(current);
      current = "";
      currentBytes = 0;
    }
    current += character;
    currentBytes += bytes;
  }
  if (current) {
    chunks.push(current);
  }
  return chunks;
}
