import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function affectsBuild(paths) {
  // Unknown inputs are treated as build inputs; only known documentation is excluded.
  return paths.some(file => file && !/^(?:README\.md$|README\.en-US\.md$|CHANGELOG\.md$|doc\/|docs\/|\.rustcodegraph\/)/.test(file));
}

export function shouldWarm(before, { cwd = resolve(import.meta.dirname, ".."), git = spawnSync } = {}) {
  if (!/^[a-f\d]{40}$/i.test(before ?? "") || /^0+$/.test(before)) return true;
  try {
    const diff = git("git", ["diff", "--name-only", "-z", before, "HEAD"], {
      cwd, encoding: "utf8", timeout: 10_000, maxBuffer: 8 * 1024 * 1024,
    });
    if (diff.error || diff.status !== 0 || typeof diff.stdout !== "string") return true;
    return affectsBuild(diff.stdout.split("\0"));
  } catch {
    return true;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const output = `warm=${shouldWarm(process.env.BEFORE_COMMIT)}\n`;
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, output);
  else process.stdout.write(output);
}
