export function usesWindowsCredentialBroker(): boolean {
  return typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent);
}
