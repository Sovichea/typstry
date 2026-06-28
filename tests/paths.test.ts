import { describe, expect, test } from "bun:test";
import { fileNameFromPath, filePathFromUri, filePathKey, filePathToUri } from "../src/platform/paths";

describe("platform paths", () => {
  test("round-trips Windows paths and encodes spaces", () => {
    const path = "C:\\Work Files\\report.typ";
    const uri = filePathToUri(path);

    expect(uri).toBe("file:///C:/Work%20Files/report.typ");
    expect(filePathFromUri(uri)).toBe("C:/Work Files/report.typ");
  });

  test("round-trips Unix paths without adding a fourth slash", () => {
    const path = "/home/user/Work Files/report.typ";
    const uri = filePathToUri(path);

    expect(uri).toBe("file:///home/user/Work%20Files/report.typ");
    expect(filePathFromUri(uri)).toBe(path);
  });

  test("preserves case sensitivity for Unix and folds Windows keys", () => {
    expect(filePathKey("/work/Main.typ")).not.toBe(filePathKey("/work/main.typ"));
    expect(filePathKey("C:\\Work\\Main.typ")).toBe(filePathKey("c:/work/main.typ"));
  });

  test("extracts file names with either separator", () => {
    expect(fileNameFromPath("C:\\Work\\main.typ")).toBe("main.typ");
    expect(fileNameFromPath("/work/main.typ")).toBe("main.typ");
  });
});
