import { resolve } from "node:path";

const THUMBPRINT = /^[A-F0-9]{40}$/;

export function readAuthenticodeSettings(environment = process.env, required = environment.FSTTY_REQUIRE_AUTHENTICODE === "1") {
  if (!required) return null;

  const thumbprint = environment.FSTTY_AUTHENTICODE_THUMBPRINT?.trim().toUpperCase();
  if (!thumbprint || !THUMBPRINT.test(thumbprint)) {
    throw new Error("缺少或无效的 Authenticode 证书指纹");
  }

  const timestampUrl = environment.FSTTY_AUTHENTICODE_TIMESTAMP_URL?.trim();
  let parsed;
  try {
    parsed = new URL(timestampUrl);
  } catch {
    throw new Error("缺少或无效的 Authenticode 时间戳地址");
  }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error("Authenticode 时间戳地址必须是无凭据的 HTTP(S) URL");
  }

  return { thumbprint, timestampUrl };
}

export function authenticodeScript(root) {
  return resolve(root, "scripts/authenticode.ps1");
}

export function powershellAuthenticodeArgs(root, file, settings, verifyOnly = false) {
  const args = [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    authenticodeScript(root),
    "-Path",
    file,
    "-ExpectedThumbprint",
    settings.thumbprint,
  ];
  if (verifyOnly) args.push("-VerifyOnly");
  else args.push("-TimestampUrl", settings.timestampUrl);
  return args;
}

export function tauriAuthenticodeConfig(root, settings) {
  return {
    cmd: "powershell.exe",
    args: powershellAuthenticodeArgs(root, "%1", settings),
  };
}
