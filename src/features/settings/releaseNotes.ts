const RELEASE_NOTE_LANGUAGES = ["zh-CN", "en-US"] as const;

type ReleaseNoteLanguage = (typeof RELEASE_NOTE_LANGUAGES)[number];

function normalizeReleaseNoteLanguage(language: string): ReleaseNoteLanguage {
  return language.toLowerCase().startsWith("en") ? "en-US" : "zh-CN";
}

function extractLanguageBlock(body: string, language: ReleaseNoteLanguage) {
  const startMarker = `<!-- release-notes:${language}:start -->`;
  const endMarker = `<!-- release-notes:${language}:end -->`;
  const start = body.indexOf(startMarker);
  const end = body.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end < start) {
    return null;
  }

  const content = body.slice(start + startMarker.length, end).trim();
  const lines = content.split(/\r?\n/);
  if (/^#{1,6}\s+(简体中文|English)\s*$/i.test(lines[0] ?? "")) {
    lines.shift();
  }
  return lines.join("\n").trim() || null;
}

export function selectLocalizedReleaseNotes(body: string | undefined, language: string) {
  const normalizedBody = body?.trim();
  if (!normalizedBody) {
    return null;
  }

  const hasLanguageMarkers = RELEASE_NOTE_LANGUAGES.some((item) =>
    normalizedBody.includes(`<!-- release-notes:${item}:start -->`),
  );
  if (!hasLanguageMarkers) {
    // 旧版更新说明没有语言标记，必须原样兼容。
    return normalizedBody;
  }

  const preferredLanguage = normalizeReleaseNoteLanguage(language);
  const fallbackLanguage = preferredLanguage === "zh-CN" ? "en-US" : "zh-CN";
  return (
    extractLanguageBlock(normalizedBody, preferredLanguage) ??
    extractLanguageBlock(normalizedBody, fallbackLanguage)
  );
}
