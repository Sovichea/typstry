import { describe, expect, test } from "bun:test";
import { syntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { typstLanguage } from "../src/editor/typstLanguage";

type ParsedToken = {
  name: string;
  text: string;
};

function parseTokens(doc: string): ParsedToken[] {
  const state = EditorState.create({ doc, extensions: [typstLanguage] });
  const cursor = syntaxTree(state).cursor();
  const tokens: ParsedToken[] = [];

  do {
    if (cursor.name !== "Document") {
      tokens.push({ name: cursor.name, text: doc.slice(cursor.from, cursor.to) });
    }
  } while (cursor.next());

  return tokens;
}

function tokenName(tokens: ParsedToken[], text: string): string | undefined {
  return tokens.find(token => token.text === text)?.name;
}

describe("Typst stream language", () => {
  test("applies heading, strong, and emphasis tags to their content", () => {
    const tokens = parseTokens("= Heading *bold* _italic_");

    expect(tokenName(tokens, "Heading")).toContain("heading");
    expect(tokenName(tokens, "bold")).toContain("strong");
    expect(tokenName(tokens, "italic")).toContain("emphasis");
  });

  test("keeps an attached heading label out of the heading style", () => {
    const tokens = parseTokens("= Heading <intro>");

    expect(tokenName(tokens, "= ")).toBe("heading");
    expect(tokenName(tokens, "Heading")).toContain("heading");
    expect(tokenName(tokens, "<intro>")).toBe("label");
  });

  test("continues a hash expression across operators and returns to prose", () => {
    const tokens = parseTokens("#x + y and prose");

    expect(tokenName(tokens, "#")).toBe("hashVariable");
    expect(tokenName(tokens, "+")).toBe("operator");
    expect(tokenName(tokens, "x")).toBe("referenceVariable");
    expect(tokenName(tokens, "y")).toBe("referenceVariable");
    expect(tokenName(tokens, "and")).toBe("content");
    expect(tokenName(tokens, "prose")).toBe("content");
  });

  test("distinguishes math variables, numbers, and embedded code", () => {
    const tokens = parseTokens("$ x^2 + #value $");

    expect(tokenName(tokens, "x")).toBeUndefined();
    expect(tokenName(tokens, "2")).toBe("number");
    expect(tokenName(tokens, "value")).toBe("referenceVariable");
  });

  test("colors a hash like the expression it introduces", () => {
    const tokens = parseTokens('#emph[hi]\n#emoji.face\n#"hello".len()\n#let x = 1');
    const hashTokens = tokens.filter(token => token.text === "#").map(token => token.name);

    expect(hashTokens).toEqual(["hashFunction", "hashVariable", "hashString", "hashKeyword"]);
    expect(tokenName(tokens, "emph")).toBe("function");
    expect(tokenName(tokens, "emoji")).toBe("referenceVariable");
    expect(tokenName(tokens, "face")).toBe("referenceVariable");
    expect(tokenName(tokens, '"hello"')).toBe("string");
    expect(tokenName(tokens, "len")).toBe("function");
    expect(tokenName(tokens, "x")).toBeUndefined();
  });

  test("tokenizes plain, unit, percentage, and scientific numbers consistently", () => {
    const tokens = parseTokens("#let x = 1\n#let y = 1em\n#let z = 50%\n#let n = 1e5\n#let m = 1.2e-3");

    expect(tokenName(tokens, "1")).toBe("number");
    expect(tokenName(tokens, "1em")).toBe("number");
    expect(tokenName(tokens, "50%")).toBe("number");
    expect(tokenName(tokens, "1e5")).toBe("number");
    expect(tokenName(tokens, "1.2e-3")).toBe("number");
  });

  test("separates a variable receiver from a called method", () => {
    const tokens = parseTokens("#values.at(0)");

    expect(tokenName(tokens, "#")).toBe("hashVariable");
    expect(tokenName(tokens, "values")).toBe("referenceVariable");
    expect(tokenName(tokens, "at")).toBe("function");
  });

  test("highlights a fenced raw-block language on the opening line", () => {
    const tokens = parseTokens("```typ\n#let x = 1\n```");

    expect(tokenName(tokens, "typ")).toBe("string");
    expect(tokenName(tokens, "#let x = 1")).toBe("monospace");
  });

  test("does not leak strong styling past an embedded code expression", () => {
    const doc = `#let quotation = {
  ([*#render(t.total-duration)*], [*#render(lead-time-str)*])
  if timeline.len() > 0 {
    import "@preview/timeliney:0.4.0"
  }
}`;
    const tokens = parseTokens(doc);

    expect(tokenName(tokens, "if")).toBe("keyword");
    expect(tokenName(tokens, "import")).toBe("keyword");
    expect(tokenName(tokens, "timeline") ?? "").not.toContain("strong");
  });
});
