import { describe, expect, test } from "bun:test";
import { fileExtension, isBinaryImagePath, isSupportedInAppPath } from "../src/platform/fileTypes";

describe("file types", () => {
  test("recognizes supported editor and image formats case-insensitively", () => {
    expect(isSupportedInAppPath("C:\\docs\\main.TYP")).toBe(true);
    expect(isSupportedInAppPath("/docs/references.bib")).toBe(true);
    expect(isSupportedInAppPath("/docs/figure.PNG")).toBe(true);
    expect(isBinaryImagePath("/docs/figure.PNG")).toBe(true);
  });

  test("rejects formats that should be opened externally", () => {
    expect(isSupportedInAppPath("/docs/output.pdf")).toBe(false);
    expect(isSupportedInAppPath("/docs/archive.zip")).toBe(false);
    expect(isSupportedInAppPath("/docs/no-extension")).toBe(false);
  });

  test("extracts only a file-name extension", () => {
    expect(fileExtension("C:\\folder.with.dot\\main.typ")).toBe("typ");
  });
});
