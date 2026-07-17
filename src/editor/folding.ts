import type { EditorState } from "@codemirror/state";

export type EditorFoldRange = {
  from: number;
  to: number;
};

const nonFunctionWords = new Set([
  "let",
  "set",
  "show",
  "import",
  "include",
  "if",
  "else",
  "for",
  "while",
  "break",
  "continue",
  "return"
]);

export function typstFunctionFoldService(state: EditorState, lineStart: number, lineEnd: number): EditorFoldRange | null {
  return findTypstFoldRange(state.doc.toString(), lineStart, lineEnd);
}

function findTypstFoldRange(text: string, lineStart: number, lineEnd: number): EditorFoldRange | null {
  const letDeclarationRange = findTypstLetFunctionFoldRange(text, lineStart, lineEnd);
  if (letDeclarationRange) return letDeclarationRange;

  const lineText = text.slice(lineStart, lineEnd);
  const functionPattern = /#?([A-Za-z_][\w.-]*)\s*([\[\(\{])/g;
  let match: RegExpExecArray | null;

  while ((match = functionPattern.exec(lineText)) !== null) {
    const matchStart = lineStart + match.index;
    const name = match[1];
    const opener = match[2];
    const openerOffset = lineStart + match.index + match[0].lastIndexOf(opener);

    if (nonFunctionWords.has(name)) continue;
    if (!isFunctionFoldCandidate(text, lineStart, matchStart)) continue;

    let closeOffset = findMatchingDelimiter(text, openerOffset, opener, matchingDelimiter(opener));
    if (closeOffset !== null && opener === "(") {
      const contentOpenOffset = skipInlineWhitespace(text, closeOffset + 1);
      if (text[contentOpenOffset] === "[") {
        const contentCloseOffset = findMatchingDelimiter(text, contentOpenOffset, "[", "]");
        if (contentCloseOffset !== null) closeOffset = contentCloseOffset;
      }
    }
    if (closeOffset === null || closeOffset <= lineEnd) continue;
    if (lineNumberAt(text, closeOffset) - lineNumberAt(text, matchStart) + 1 <= 3) continue;

    return {
      from: lineEnd,
      to: closeOffset + 1
    };
  }

  return null;
}

function findTypstLetFunctionFoldRange(text: string, lineStart: number, lineEnd: number): EditorFoldRange | null {
  const lineText = text.slice(lineStart, lineEnd);
  const declaration = /#let\s+[A-Za-z_][\w.-]*\s*\(/.exec(lineText);
  if (!declaration) return null;

  const parameterOpenOffset = lineStart + declaration.index + declaration[0].lastIndexOf("(");
  const parameterCloseOffset = findMatchingDelimiter(text, parameterOpenOffset, "(", ")");
  if (parameterCloseOffset === null) return null;

  let cursor = skipInlineWhitespace(text, parameterCloseOffset + 1);
  if (text[cursor] !== "=") return null;
  cursor = skipInlineWhitespace(text, cursor + 1);

  const bodyOpen = text[cursor];
  if (bodyOpen !== "{" && bodyOpen !== "[") return null;

  const bodyCloseOffset = findMatchingDelimiter(text, cursor, bodyOpen, matchingDelimiter(bodyOpen));
  if (bodyCloseOffset === null || bodyCloseOffset <= lineEnd) return null;

  return {
    from: lineEnd,
    to: bodyCloseOffset + 1
  };
}

function isFunctionFoldCandidate(text: string, lineStart: number, matchStart: number): boolean {
  if (text[matchStart] === "#") return true;

  const previous = matchStart > 0 ? text[matchStart - 1] : "";
  if (previous && /[\w.-]/.test(previous)) return false;

  const linePrefix = text.slice(lineStart, matchStart).trimEnd();
  if (/[([{,=:]$/.test(linePrefix)) return true;
  if (/^#?(?:let|set|show|if|for|while|return)\b/.test(linePrefix.trimStart())) return true;

  return isInsideUnclosedTypstCodeExpression(text.slice(0, matchStart));
}

function skipInlineWhitespace(text: string, from: number): number {
  let cursor = from;
  while (cursor < text.length && text[cursor] !== "\n" && /\s/.test(text[cursor])) {
    cursor++;
  }
  return cursor;
}

function lineNumberAt(text: string, offset: number): number {
  let line = 1;
  const end = Math.max(0, Math.min(offset, text.length));

  for (let index = 0; index < end; index++) {
    if (text[index] === "\n") line++;
  }

  return line;
}

function matchingDelimiter(opener: string): string {
  if (opener === "(") return ")";
  if (opener === "[") return "]";
  return "}";
}

function findMatchingDelimiter(text: string, openerOffset: number, opener: string, closer: string): number | null {
  let depth = 0;
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;
  let inRawBlock = false;

  for (let index = openerOffset; index < text.length; index++) {
    const char = text[index];
    const next = text[index + 1];
    const lineStart = index === 0 || text[index - 1] === "\n";

    if (lineStart && text.startsWith("```", index)) {
      inRawBlock = !inRawBlock;
      index += 2;
      continue;
    }

    if (inRawBlock) continue;

    if (inLineComment) {
      if (char === "\n") inLineComment = false;
      continue;
    }

    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false;
        index++;
      }
      continue;
    }

    if (inString) {
      if (char === "\"" && !isEscaped(text, index)) inString = false;
      continue;
    }

    if (char === "/" && next === "/") {
      inLineComment = true;
      index++;
      continue;
    }

    if (char === "/" && next === "*") {
      inBlockComment = true;
      index++;
      continue;
    }

    if (char === "\"" && !isEscaped(text, index)) {
      inString = true;
      continue;
    }

    if (char === opener) {
      depth++;
    } else if (char === closer) {
      depth--;
      if (depth === 0) return index;
    }
  }

  return null;
}

function isInsideUnclosedTypstCodeExpression(text: string): boolean {
  const delimiters: string[] = [];
  let inString = false;
  let hashExpression = false;

  for (let index = 0; index < text.length; index++) {
    const char = text[index];

    if (inString) {
      if (char === "\"" && !isEscaped(text, index)) inString = false;
      continue;
    }

    if (char === "\n" && delimiters.length === 0) {
      hashExpression = false;
      continue;
    }

    if (char === "\"" && !isEscaped(text, index)) {
      inString = true;
      continue;
    }

    if (char === "#" && !isEscaped(text, index)) {
      hashExpression = true;
      continue;
    }

    if (hashExpression && (char === "(" || char === "{")) {
      delimiters.push(char);
    } else if (char === ")" && delimiters[delimiters.length - 1] === "(") {
      delimiters.pop();
    } else if (char === "}" && delimiters[delimiters.length - 1] === "{") {
      delimiters.pop();
    }
  }

  return delimiters.length > 0;
}

function isEscaped(text: string, index: number): boolean {
  let slashCount = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor--) {
    slashCount++;
  }
  return slashCount % 2 === 1;
}
