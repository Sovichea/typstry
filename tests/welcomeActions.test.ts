import { describe, expect, test } from "bun:test";

describe("welcome project actions", () => {
  test("offers the same Typsastra project import entry point as the File menu", async () => {
    const html = await Bun.file(new URL("../index.html", import.meta.url)).text();
    expect(html).toContain('id="action-import-project"');
    expect(html).toContain('id="welcome-import-project"');
    expect(html).toContain("Import Typsastra Project");
    expect(html).toContain(".typsastra");
  });
});
