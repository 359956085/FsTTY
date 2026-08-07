import { selectLocalizedReleaseNotes } from "./releaseNotes";

export interface UpdateHistoryEntry {
  date: string;
  notes: string;
  version: string;
}

const VERSION_HEADING = /^## \[(\d+\.\d+\.\d+)\] - (\d{4}-\d{2}-\d{2})[ \t]*$/gm;

function compareVersions(left: string, right: string) {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (rightParts[index] ?? 0) - (leftParts[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

export function parseUpdateHistory(changelog: string, language: string): UpdateHistoryEntry[] {
  const headings = [...changelog.matchAll(VERSION_HEADING)];
  return headings
    .map((heading, index) => {
      const contentStart = (heading.index ?? 0) + heading[0].length;
      const contentEnd = headings[index + 1]?.index ?? changelog.length;
      const notes = selectLocalizedReleaseNotes(
        changelog.slice(contentStart, contentEnd),
        language,
      );
      return {
        date: heading[2] ?? "",
        notes: notes ?? "",
        version: heading[1] ?? "",
      };
    })
    .filter((entry) => entry.version && entry.notes)
    .sort((left, right) => compareVersions(left.version, right.version));
}
