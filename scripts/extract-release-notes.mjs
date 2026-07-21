import { randomUUID } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { EOL } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const RELEASE_NOTE_LANGUAGES = ["zh-CN", "en-US"];

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function validateLanguageBlock(section, language) {
  const escapedLanguage = escapeRegExp(language);
  const pattern = new RegExp(
    `<!--\\s*release-notes:${escapedLanguage}:start\\s*-->([\\s\\S]*?)<!--\\s*release-notes:${escapedLanguage}:end\\s*-->`,
    "g",
  );
  const matches = [...section.matchAll(pattern)];
  if (matches.length !== 1) {
    throw new Error(`版本更新说明必须包含且仅包含一个 ${language} 区块`);
  }
  const lines = (matches[0][1] ?? "").trim().split(/\r?\n/);
  if (/^#{1,6}\s+(简体中文|English)\s*$/i.test(lines[0] ?? "")) {
    lines.shift();
  }
  if (!lines.join("\n").trim()) {
    throw new Error(`${language} 更新说明不能为空`);
  }
}

export function extractVersionReleaseNotes(changelog, tag) {
  const tagMatch = /^v(\d+\.\d+\.\d+)$/.exec(tag.trim());
  if (!tagMatch) {
    throw new Error(`发布标签必须使用 vX.Y.Z 格式，当前值：${tag}`);
  }

  const version = tagMatch[1];
  const headingPattern = new RegExp(
    `^## \\[${escapeRegExp(version)}\\] - \\d{4}-\\d{2}-\\d{2}[ \\t]*$`,
    "gm",
  );
  const headings = [...changelog.matchAll(headingPattern)];
  if (headings.length !== 1) {
    throw new Error(`CHANGELOG.md 必须包含且仅包含一个 ${version} 版本标题`);
  }

  const heading = headings[0];
  const contentStart = (heading.index ?? 0) + heading[0].length;
  const remainingContent = changelog.slice(contentStart);
  const nextHeadingIndex = remainingContent.search(/^## /m);
  const section = (
    nextHeadingIndex >= 0 ? remainingContent.slice(0, nextHeadingIndex) : remainingContent
  ).trim();
  if (!section) {
    throw new Error(`${version} 更新说明不能为空`);
  }

  for (const language of RELEASE_NOTE_LANGUAGES) {
    validateLanguageBlock(section, language);
  }
  return section;
}

function writeGitHubOutput(notes, outputPath) {
  const delimiter = `fstty_release_notes_${randomUUID().replaceAll("-", "")}`;
  appendFileSync(outputPath, `body<<${delimiter}${EOL}${notes}${EOL}${delimiter}${EOL}`, "utf8");
}

function run() {
  const tag = process.argv[2] ?? "";
  const changelogPath = resolve(process.cwd(), "CHANGELOG.md");
  const notes = extractVersionReleaseNotes(readFileSync(changelogPath, "utf8"), tag);
  if (process.env.GITHUB_OUTPUT) {
    writeGitHubOutput(notes, process.env.GITHUB_OUTPUT);
    return;
  }
  process.stdout.write(`${notes}${EOL}`);
}

const isDirectExecution =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectExecution) {
  try {
    run();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
