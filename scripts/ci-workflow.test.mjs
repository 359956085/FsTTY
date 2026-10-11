import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { affectsBuild } from "./ci-changes.mjs";

const quality = readFileSync(new URL("../.github/workflows/quality.yml", import.meta.url), "utf8").replaceAll("\r\n", "\n");
const release = readFileSync(new URL("../.github/workflows/release-windows.yml", import.meta.url), "utf8").replaceAll("\r\n", "\n");

// Inspect relevant job/step constraints, without fixing names or complete command lists.
function job(workflow, id) {
  const block = workflow.match(new RegExp(`^  ${id}:\\n[\\s\\S]*?(?=^  [\\w-]+:|$(?![\\s\\S]))`, "m"));
  if (!block) throw new Error(`Missing job: ${id}`);
  return block[0];
}
const steps = block => block.split(/\n {6}- /).slice(1);

describe("CI 执行和发布安全约束", () => {
  it("main 自动检查跳过文档，手动运行仍完整检查", () => {
    const triggers = quality.slice(quality.indexOf("\non:"), quality.indexOf("\nconcurrency:"));
    expect(triggers).toMatch(/push:\n\s+branches:.*main/);
    expect(triggers).not.toContain("pull_request:");
    expect(triggers).toMatch(/^ {2}workflow_dispatch:/m);
    const ignore = triggers.match(/paths-ignore:\n((?:\s+- [^\n]+\n)+)/)?.[1];
    expect(ignore).toBeTruthy();
    for (const pattern of ignore.matchAll(/- ['"]?([^'"\n]+)['"]?/g)) {
      expect(affectsBuild([pattern[1].replace("**", "sample.md")])).toBe(false);
    }
    expect(job(quality, "verify")).not.toMatch(/^ {4}if:/m);
    expect(job(quality, "verify")).toContain("./.github/actions/rust-audit");
    expect(job(quality, "verify")).toContain("npm run verify:all");
  });

  it("取消旧推送，手动运行及发布不被新推送取消", () => {
    expect(quality).toMatch(/group:.*github\.ref.*github\.event_name/);
    expect(quality).toMatch(/cancel-in-progress:.*github\.event_name == 'push'/);
    expect(release).toMatch(/cancel-in-progress:\s*false/);
  });

  it("预热等待检查成功，不打包或接触发布密钥", () => {
    const warm = job(quality, "warm");
    expect(warm).toMatch(/needs:\s*(?:verify|\[verify\])/);
    expect(warm).toMatch(/if:.*github\.event_name == 'push'.*needs\.verify\.outputs\.warm == 'true'/);
    expect(warm).not.toMatch(/always\(\)|continue-on-error|secrets\.|ci-build\.mjs (?:bundle|sign)/);
    expect(job(quality, "verify")).toContain("node scripts/ci-changes.mjs");
  });

  it("发布等待检查与构建，无签名产物隔离，私钥仅用于正式签名步骤", () => {
    const publish = job(release, "publish");
    const needs = publish.match(/needs:\s*\[([^\]]+)\]/)?.[1].split(",").map(value => value.trim());
    expect(needs).toEqual(expect.arrayContaining(["verify", "build"]));
    expect(publish).toMatch(/if:.*outputs\.mode == 'release'/);
    expect(publish).not.toMatch(/always\(\)|continue-on-error|windows-validation|secrets\.TAURI_SIGNING_PRIVATE_KEY/);
    expect(job(release, "prepare")).toContain("npm run check:release");
    expect(job(release, "verify")).toContain("./.github/actions/rust-audit");
    for (const workflowStep of steps(job(release, "build"))) {
      if (/secrets\.|ci-build\.mjs sign|release-artifacts\.mjs collect(?:\s|$)|path: artifacts\/windows-release\//.test(workflowStep)) {
        expect(workflowStep).toMatch(/if:.*outputs\.mode == 'release'/);
      }
      if (workflowStep.includes("secrets.TAURI_SIGNING_PRIVATE_KEY")) {
        expect(workflowStep).toMatch(/ci-build\.mjs sign\s*$/m);
      }
      if (/collect-validation|path: artifacts\/windows-validation\//.test(workflowStep)) {
        expect(workflowStep).toMatch(/if:.*outputs\.mode == 'validation'/);
      }
    }
    for (const id of ["prepare", "verify"]) expect(job(release, id)).not.toContain("secrets.");
  });

  it("本地与 CI 使用相同的固定 Rust 工具链和检查组件", () => {
    const local = readFileSync(new URL("../rust-toolchain.toml", import.meta.url), "utf8");
    const setup = readFileSync(new URL("../.github/actions/windows-build-setup/action.yml", import.meta.url), "utf8");
    const version = local.match(/^channel = "([^"]+)"/m)?.[1];
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(setup).toContain(`toolchain: ${version}`);
    for (const component of ["rustfmt", "clippy"]) {
      expect(local).toContain(component);
      expect(setup).toContain(component);
    }
  });
});
