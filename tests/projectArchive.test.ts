import { describe, expect, test } from "bun:test";
import {
  parseTypstellaProjectManifest,
  TYPSTELLA_PROJECT_FORMAT,
  TYPSTELLA_PROJECT_SCHEMA_VERSION
} from "../src/projectArchive";

const digest = "a".repeat(64);

function manifest(): unknown {
  return {
    format: TYPSTELLA_PROJECT_FORMAT,
    schemaVersion: TYPSTELLA_PROJECT_SCHEMA_VERSION,
    createdBy: { application: "Typstella", version: "1.0.0" },
    project: { name: "ការស្រាវជ្រាវ", main: "main.typ" },
    toolchain: {
      typstVersion: "0.13.1",
      tinymistVersion: "0.13.10",
      compatibility: "exact"
    },
    renderEnvironment: { fontsPackaged: false },
    fonts: [],
    integrity: { algorithm: "sha256", files: { "main.typ": digest } }
  };
}

describe("Typstella project manifest", () => {
  test("parses the locked schema-v1 fixture", async () => {
    const fixture = await Bun.file(
      new URL("./fixtures/projectArchive/manifest-v1.json", import.meta.url)
    ).json();
    const parsed = parseTypstellaProjectManifest(fixture);
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.project.name).toBe("ការស្រាវជ្រាវ");
  });

  test("parses the supported Unicode manifest", () => {
    const parsed = parseTypstellaProjectManifest(manifest());
    expect(parsed.project.name).toBe("ការស្រាវជ្រាវ");
    expect(parsed.project.main).toBe("main.typ");
    expect(parsed.toolchain.typstVersion).toBe("0.13.1");
  });

  test("rejects unknown format and schema versions", () => {
    expect(() => parseTypstellaProjectManifest({ ...(manifest() as object), format: "example" }))
      .toThrow("Unsupported project format");
    expect(() => parseTypstellaProjectManifest({ ...(manifest() as object), schemaVersion: 2 }))
      .toThrow("Unsupported Typstella project schema version");
  });

  test("rejects unsafe paths and missing main integrity", () => {
    const unsafe = manifest() as any;
    unsafe.project.main = "../main.typ";
    expect(() => parseTypstellaProjectManifest(unsafe)).toThrow("safe relative archive path");

    const missing = manifest() as any;
    missing.integrity.files = { "chapter.typ": digest };
    expect(() => parseTypstellaProjectManifest(missing)).toThrow("missing from integrity.files");
  });

  test("rejects malformed hashes", () => {
    const value = manifest() as any;
    value.integrity.files["main.typ"] = "not-a-hash";
    expect(() => parseTypstellaProjectManifest(value)).toThrow("SHA-256 digest");
  });
});
