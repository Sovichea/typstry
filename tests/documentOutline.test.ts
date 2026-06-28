import { describe, expect, test } from "bun:test";
import { parseDocumentOutline } from "../src/outline/documentOutline";

describe("document outline", () => {
  test("builds a nested heading tree with source positions", () => {
    const source = "= Introduction <intro>\nText\n== Details\n=== Deep dive\n= Conclusion\n";
    const outline = parseDocumentOutline(source);

    expect(outline.map(heading => heading.title)).toEqual(["Introduction", "Conclusion"]);
    expect(outline[0].children[0].title).toBe("Details");
    expect(outline[0].children[0].children[0].title).toBe("Deep dive");
    expect(outline[0].textFrom).toBe(2);
    expect(outline[0].children[0].line).toBe(3);
  });

  test("ignores headings inside comments and fenced raw blocks", () => {
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

    expect(parseDocumentOutline(source).map(heading => heading.title)).toEqual(["Real heading"]);
  });

  test("keeps duplicate headings independently addressable", () => {
    const outline = parseDocumentOutline("= Same\n= Same\n");

    expect(outline).toHaveLength(2);
    expect(outline[0].id).not.toBe(outline[1].id);
    expect(outline[1].from).toBe(7);
  });
});
