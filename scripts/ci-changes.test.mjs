import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { affectsBuild, shouldWarm } from "./ci-changes.mjs";

const directories = [];
afterEach(() => directories.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true })));

describe("日常构建变更判断", () => {
  it("仅已知文档和索引变更不预热，代码和未知输入保守预热", () => {
    expect(affectsBuild(["README.md", "README.en-US.md", "CHANGELOG.md", "doc/guide.md", "docs/release.md", ".rustcodegraph/index.json"])).toBe(false);
    for (const file of ["src/App.tsx", "src-tauri/Cargo.lock", "public/icon.png", "scripts/new-feature.mjs", ".github/workflows/quality.yml", "package-lock.json", "vitest.config.ts", "rust-toolchain.toml", "future-build-input.dat", "public/README.md"]) {
      expect(affectsBuild(["docs/guide.md", file])).toBe(true);
    }
  });

  it("无法可靠获取差异时预热，不将读取失败当作文档变更", () => {
    for (const before of [undefined, "", "0".repeat(40), "main", "--help"]) {
      expect(shouldWarm(before, { git: () => { throw new Error("不应调用 git"); } })).toBe(true);
    }
    for (const result of [{ status: 128 }, { status: null, error: new Error("timeout") }, { status: 0, stdout: null }]) {
      expect(shouldWarm("a".repeat(40), { git: () => result })).toBe(true);
    }
    expect(shouldWarm("a".repeat(40), { git: () => { throw new Error("git unavailable"); } })).toBe(true);
    expect(shouldWarm("a".repeat(40), { git: () => ({ status: 0, stdout: "" }) })).toBe(false);
  });

  it("独立脚本比较实际提交，写入 Actions 输出且不需要发布模块", () => {
    const directory = mkdtempSync(join(tmpdir(), "fstty-ci-diff-"));
    directories.push(directory);
    const git = (...args) => execFileSync("git", args, { cwd: directory, encoding: "utf8" }).trim();
    git("init", "--quiet");
    git("config", "user.email", "fixture@example.invalid");
    git("config", "user.name", "CI fixture");
    git("config", "core.autocrlf", "false");
    writeFileSync(join(directory, "README.md"), "Initial\n");
    git("add", "."); git("commit", "--quiet", "-m", "initial");
    const before = git("rev-parse", "HEAD");
    writeFileSync(join(directory, "README.md"), "Documentation only\n");
    git("add", "."); git("commit", "--quiet", "-m", "docs");
    expect(shouldWarm(before, { cwd: directory })).toBe(false);
    mkdirSync(join(directory, "scripts"));
    // Copy only this entry point: an accidental import of release helpers must fail here.
    const entry = join(directory, "scripts/ci-changes.mjs");
    writeFileSync(entry, readFileSync(resolve(import.meta.dirname, "ci-changes.mjs")));
    const output = join(directory, "github-output");
    const run = () => spawnSync(process.execPath, [entry], {
      cwd: tmpdir(), encoding: "utf8", timeout: 10_000,
      env: { ...process.env, BEFORE_COMMIT: before, GITHUB_OUTPUT: output },
    });
    const docs = run();
    expect(docs.status, docs.stderr).toBe(0);
    expect(readFileSync(output, "utf8")).toBe("warm=false\n");
    writeFileSync(join(directory, "future-input.dat"), "Build input\n");
    git("add", "future-input.dat"); git("commit", "--quiet", "-m", "code");
    expect(shouldWarm(before, { cwd: directory })).toBe(true);
    expect(shouldWarm("f".repeat(40), { cwd: directory })).toBe(true);

    const result = run();
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(output, "utf8")).toBe("warm=false\nwarm=true\n");
  }, 15_000);
});
