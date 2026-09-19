import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  powershellAuthenticodeArgs,
  readAuthenticodeSettings,
  tauriAuthenticodeConfig,
} from "./authenticode.mjs";

const thumbprint = "0123456789abcdef0123456789abcdef01234567";
const timestampUrl = "https://timestamp.example.com/";

describe("Windows Authenticode 发布配置", () => {
  it("非发布构建不要求代码签名", () => {
    expect(readAuthenticodeSettings({})).toBeNull();
  });

  it.each([
    [{ FSTTY_REQUIRE_AUTHENTICODE: "1" }, "证书指纹"],
    [{ FSTTY_REQUIRE_AUTHENTICODE: "1", FSTTY_AUTHENTICODE_THUMBPRINT: "1234", FSTTY_AUTHENTICODE_TIMESTAMP_URL: timestampUrl }, "证书指纹"],
    [{ FSTTY_REQUIRE_AUTHENTICODE: "1", FSTTY_AUTHENTICODE_THUMBPRINT: thumbprint }, "时间戳地址"],
    [{ FSTTY_REQUIRE_AUTHENTICODE: "1", FSTTY_AUTHENTICODE_THUMBPRINT: thumbprint, FSTTY_AUTHENTICODE_TIMESTAMP_URL: "file:///tmp/time" }, "HTTP(S)"],
    [{ FSTTY_REQUIRE_AUTHENTICODE: "1", FSTTY_AUTHENTICODE_THUMBPRINT: thumbprint, FSTTY_AUTHENTICODE_TIMESTAMP_URL: "https://user:pass@example.com" }, "无凭据"],
  ])("拒绝无效发布配置：%j", (environment, message) => {
    expect(() => readAuthenticodeSettings(environment)).toThrow(message);
  });

  it("生成无 shell 拼接的 Tauri 签名命令", () => {
    const root = resolve("C:/work/FsTTY");
    const settings = readAuthenticodeSettings({
      FSTTY_REQUIRE_AUTHENTICODE: "1",
      FSTTY_AUTHENTICODE_THUMBPRINT: thumbprint,
      FSTTY_AUTHENTICODE_TIMESTAMP_URL: timestampUrl,
    });
    expect(settings).toEqual({ thumbprint: thumbprint.toUpperCase(), timestampUrl });

    const command = tauriAuthenticodeConfig(root, settings);
    expect(command.cmd).toBe("powershell.exe");
    expect(command.args).toContain("%1");
    expect(command.args).toContain(settings.thumbprint);
    expect(command.args).toContain(timestampUrl);
    expect(command.args).toContain(resolve(root, "scripts/authenticode.ps1"));
    expect(command.args.join(" ")).not.toContain("cmd.exe");
  });

  it("校验命令不会再次签名", () => {
    const settings = { thumbprint: thumbprint.toUpperCase(), timestampUrl };
    const args = powershellAuthenticodeArgs("C:/work/FsTTY", "C:/out/app.exe", settings, true);
    expect(args).toContain("-VerifyOnly");
    expect(args).not.toContain("-TimestampUrl");
  });
});
