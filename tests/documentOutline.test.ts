import { describe, expect, test } from "bun:test";
import { parseDocumentOutline } from "../src/outline/documentOutline";

describe("document outline", () => {
  test("builds a nested heading tree with source positions", async () => {
    const source = "= Introduction <intro>\nText\n== Details\n=== Deep dive\n= Conclusion\n";
    const outline = await parseDocumentOutline("main.typ", source, "", async () => null);

    expect(outline.map(heading => heading.title)).toEqual(["Introduction", "Conclusion"]);
    expect(outline[0].children[0].title).toBe("Details");
    expect(outline[0].children[0].children[0].title).toBe("Deep dive");
    expect(outline[0].textFrom).toBe(2);
    expect(outline[0].children[0].line).toBe(3);
  });

  test("ignores headings inside comments and fenced raw blocks", async () => {
    const source = [
      "// = Comment heading",
      "/*",
      "= Block comment heading",
      "*/",
      "```typ",
      "= Raw heading",
      "```",
      "= Real heading"
    ].join("\n");

    expect((await parseDocumentOutline("main.typ", source, "", async () => null)).map(heading => heading.title)).toEqual(["Real heading"]);
  });

  test("keeps duplicate headings independently addressable", async () => {
    const outline = await parseDocumentOutline("main.typ", "= Same\n= Same\n", "", async () => null);

    expect(outline).toHaveLength(2);
    expect(outline[0].id).not.toBe(outline[1].id);
    expect(outline[1].from).toBe(7);
  });
});
