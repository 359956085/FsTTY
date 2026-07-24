export function normalizeReleaseVersion(version: string) {
  return version.trim().replace(/^v/i, "");
}

function parseReleaseVersion(version: string) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(normalizeReleaseVersion(version));
  if (!match) {
    return null;
  }
  const parts = match.slice(1).map(Number);
  return parts.every(Number.isSafeInteger) ? parts : null;
}

export function compareReleaseVersions(left: string, right: string) {
  const leftParts = parseReleaseVersion(left);
  const rightParts = parseReleaseVersion(right);
  if (!leftParts || !rightParts) {
    return null;
  }
  for (let index = 0; index < leftParts.length; index += 1) {
    const difference = leftParts[index] - rightParts[index];
    if (difference !== 0) {
      return Math.sign(difference);
    }
  }
  return 0;
}

export function shouldSuppressUpdate(
  source: "manual" | "automatic",
  availableVersion: string,
  ignoredVersion: string | null,
) {
  if (source !== "automatic" || !ignoredVersion) {
    return false;
  }
  const comparison = compareReleaseVersions(availableVersion, ignoredVersion);
  return comparison === null
    ? normalizeReleaseVersion(availableVersion) === normalizeReleaseVersion(ignoredVersion)
    : comparison <= 0;
}
