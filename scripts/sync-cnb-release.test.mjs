import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rewriteCnbUpdateManifest, syncCnbRelease } from "./sync-cnb-release.mjs";

describe("CNB 更新元数据", () => {
  it("保留签名并把所有平台下载地址改为 CNB Release", () => {
    const manifest = rewriteCnbUpdateManifest(
      {
        version: "1.2.0",
        notes: "说明",
        platforms: {
          "windows-x86_64": {
            signature: "signed-value",
            url: "https://github.com/359956085/FsTTY/releases/download/v1.2.0/FsTTY_1.2.0_x64-setup.exe",
          },
        },
      },
      "359956085/FsTTY",
      "v1.2.0",
    );
    expect(manifest.platforms["windows-x86_64"]).toEqual({
      signature: "signed-value",
      url: "https://cnb.cool/359956085/FsTTY/-/releases/download/v1.2.0/FsTTY_1.2.0_x64-setup.exe",
    });
  });

  it("拒绝第三方下载域名和缺失签名", () => {
    expect(() =>
      rewriteCnbUpdateManifest(
        { version: "1.2.0", platforms: { "windows-x86_64": { signature: "x", url: "https://evil.example/app.exe" } } },
        "359956085/FsTTY",
        "v1.2.0",
      ),
    ).toThrow("非预期下载域名");
    expect(() =>
      rewriteCnbUpdateManifest(
        { version: "1.2.0", platforms: { "windows-x86_64": { url: "https://github.com/359956085/FsTTY/releases/download/v1.2.0/app.exe" } } },
        "359956085/FsTTY",
        "v1.2.0",
      ),
    ).toThrow("缺少签名");
  });

  it("拒绝非正式版本标签", () => {
    expect(() => rewriteCnbUpdateManifest({ version: "1", platforms: {} }, "a/b", "latest")).toThrow(
      "发布标签无效",
    );
  });

  it("创建版本和固定元数据版本并上传可重跑附件", async () => {
    const directory = await mkdtemp(join(tmpdir(), "fstty-cnb-test-"));
    try {
      await writeFile(join(directory, "app.exe"), "installer");
      await writeFile(
        join(directory, "latest.json"),
        JSON.stringify({
          version: "1.2.0",
          platforms: {
            "windows-x86_64": {
              signature: "signed-value",
              url: "https://github.com/359956085/FsTTY/releases/download/v1.2.0/app.exe",
            },
          },
        }),
      );
      const calls = [];
      let releaseIndex = 0;
      const fetchImpl = async (url, options = {}) => {
        calls.push({ url: String(url), method: options.method ?? "GET" });
        if (String(url).includes("/releases/tags/")) {
          return new Response("", { status: 404 });
        }
        if (String(url).endsWith("/-/releases") && options.method === "POST") {
          releaseIndex += 1;
          return Response.json({ id: `release-${releaseIndex}` }, { status: 201 });
        }
        if (String(url).endsWith("/asset-upload-url")) {
          return Response.json(
            {
              upload_url: `https://upload.cnb.test/${calls.length}`,
              verify_url: `/verify/${calls.length}`,
            },
            { status: 201 },
          );
        }
        if (String(url).startsWith("https://upload.cnb.test/")) {
          return new Response("", { status: 200 });
        }
        if (String(url).startsWith("https://api.cnb.cool/verify/")) {
          return new Response("", { status: 200 });
        }
        if (String(url).endsWith("/updater/latest.json")) {
          return Response.json({ version: "1.2.0" });
        }
        if (options.method === "HEAD") {
          return new Response("", { status: 302 });
        }
        throw new Error(`未处理请求：${options.method ?? "GET"} ${url}`);
      };
      const changelog = `## [1.2.0] - 2026-08-06
<!-- release-notes:zh-CN:start -->
- 中文说明
<!-- release-notes:zh-CN:end -->
<!-- release-notes:en-US:start -->
- English notes
<!-- release-notes:en-US:end -->`;

      const result = await syncCnbRelease({
        repo: "359956085/FsTTY",
        tag: "v1.2.0",
        commit: "abc123",
        assetsDirectory: directory,
        changelog,
        token: "secret",
        fetchImpl,
      });

      expect(result.manifestUrl).toContain("/updater/latest.json");
      expect(calls.filter((call) => call.method === "PUT")).toHaveLength(3);
      expect(calls.filter((call) => call.url.endsWith("/-/releases") && call.method === "POST")).toHaveLength(2);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
