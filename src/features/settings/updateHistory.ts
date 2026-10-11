import { selectLocalizedReleaseNotes } from "./releaseNotes";

export interface UpdateHistoryEntry {
  date: string;
  notes: string;
  version: string;
}

const VERSION_HEADING = /^## \[((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-beta\.[1-9]\d*)?)\] - (\d{4}-\d{2}-\d{2})[ \t]*$/gm;

function compareVersions(left: string, right: string) {
  const [leftBase, leftBeta] = left.split("-beta.");
  const [rightBase, rightBeta] = right.split("-beta.");
  const leftParts = leftBase.split(".").map(BigInt);
  const rightParts = rightBase.split(".").map(BigInt);
  for (let index = 0; index < 3; index += 1) {
    const difference = rightParts[index] - leftParts[index];
    if (difference !== 0n) {
      return difference > 0n ? 1 : -1;
    }
  }
  if (leftBeta === undefined) return rightBeta === undefined ? 0 : -1;
  if (rightBeta === undefined) return 1;
  const difference = BigInt(rightBeta) - BigInt(leftBeta);
  return difference === 0n ? 0 : difference > 0n ? 1 : -1;
}

export function parseUpdateHistory(changelog: string, language: string): UpdateHistoryEntry[] {
  const headings = [...changelog.matchAll(VERSION_HEADING)];
  return headings
    .map((heading) => {
      const contentStart = (heading.index ?? 0) + heading[0].length;
      const nextSection = changelog.slice(contentStart).search(/^## /m);
      const contentEnd = nextSection < 0 ? changelog.length : contentStart + nextSection;
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
