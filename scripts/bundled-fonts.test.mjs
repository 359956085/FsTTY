import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("offline font distribution", () => {
  it("ships the recorded upstream bytes and complete attribution", () => {
    const root = new URL("../src/assets/fonts/jetbrains-mono/", import.meta.url);
    const manifest = JSON.parse(readFileSync(new URL("manifest.json", root), "utf8"));
    let total = 0;
    for (const file of manifest.files) {
      const bytes = readFileSync(new URL(file.name, root));
      expect(bytes.length).toBe(file.bytes);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(file.sha256);
      if (file.name.endsWith(".woff2")) {
        expect(bytes.subarray(0, 4).toString()).toBe("wOF2");
        total += bytes.length;
      }
    }
    expect(total).toBe(manifest.fontBytes);
    const license = readFileSync(new URL("OFL.txt", root), "utf8");
    expect(license).toContain("Copyright 2020 The JetBrains Mono Project Authors");
    expect(license).toContain("SIL OPEN FONT LICENSE Version 1.1");
    const resources = JSON.parse(readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8")).bundle.resources;
    for (const name of ["OFL.txt", "README.md", "manifest.json"]) {
      expect(resources["../src/assets/fonts/jetbrains-mono/" + name]).toBe("third-party/jetbrains-mono/" + name);
    }
  });
});
