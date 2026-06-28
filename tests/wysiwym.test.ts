import { describe, expect, test } from "bun:test";
import { renderTypstInlineFormatting, splitTypstBlocks } from "../src/wysiwym/adapter";

describe("WYSIWYM conversion", () => {
  test("splits headings and multiline constructs into stable blocks", () => {
    const source = "= Heading\n\nBody line\ncontinued\n\n#table(\n  columns: 2,\n  [A], [B],\n)\n\n```typ\n#let x = 1\n```";

    expect(splitTypstBlocks(source)).toEqual([
      "= Heading",
      "Body line\ncontinued",
      "#table(\n  columns: 2,\n  [A], [B],\n)",
      "```typ\n#let x = 1\n```"
    ]);
  });

  test("escapes source HTML before rendering inline formatting", () => {
    const html = renderTypstInlineFormatting("<unsafe> *bold* _italic_");

    expect(html).toContain("&lt;unsafe&gt;");
    expect(html).toContain('class="wysiwym-bold">bold</span>');
    expect(html).toContain('class="wysiwym-italic">italic</span>');
    expect(html).not.toContain("<unsafe>");
  });
});
