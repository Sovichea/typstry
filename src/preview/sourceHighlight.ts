import type { Text } from "@codemirror/state";

export const PREVIEW_HIGHLIGHT_PREFIX = '#text(fill:rgb("#fe0102"))[';
export const PREVIEW_HIGHLIGHT_SUFFIX = "]";

export type PreviewHighlightMapping = {
  lineNumber: number;
  lineFrom: number;
  originalStart: number;
  originalEnd: number;
  highlightedStart: number;
  highlightedEnd: number;
  wrapperEnd: number;
  highlightedLineText: string;
};

export type HighlightedPreviewSource = {
  text: string;
  scrollLine: number;
  scrollCharacter: number;
  mapping: PreviewHighlightMapping;
};

type SourceRange = { from: number; to: number };

export function buildHighlightedPreviewSource(
  doc: Text,
  cursor: number,
  encodeCharacter: (text: string, offset: number) => number
): HighlightedPreviewSource | null {
  const range = wordRangeAtCursor(doc, cursor);
  if (!range || !isPreviewHighlightableRange(doc, range)) return null;

  const text = doc.toString();
  const line = doc.lineAt(range.from);
  const cursorInWord = Math.max(0, Math.min(cursor - range.from, range.to - range.from));
  const originalStart = range.from - line.from;
  const originalEnd = range.to - line.from;
  const linePrefix = line.text.slice(0, originalStart);
  const word = line.text.slice(originalStart, originalEnd);
  const highlightedLinePrefix = `${linePrefix}${PREVIEW_HIGHLIGHT_PREFIX}${line.text.slice(originalStart, originalStart + cursorInWord)}`;
  const highlightedLineText = `${linePrefix}${PREVIEW_HIGHLIGHT_PREFIX}${word}${PREVIEW_HIGHLIGHT_SUFFIX}${line.text.slice(originalEnd)}`;

  return {
    text: `${text.slice(0, range.from)}${PREVIEW_HIGHLIGHT_PREFIX}${text.slice(range.from, range.to)}${PREVIEW_HIGHLIGHT_SUFFIX}${text.slice(range.to)}`,
    scrollLine: line.number - 1,
    scrollCharacter: encodeCharacter(highlightedLinePrefix, highlightedLinePrefix.length),
    mapping: {
      lineNumber: line.number,
      lineFrom: line.from,
      originalStart,
      originalEnd,
      highlightedStart: originalStart + PREVIEW_HIGHLIGHT_PREFIX.length,
      highlightedEnd: originalStart + PREVIEW_HIGHLIGHT_PREFIX.length + word.length,
      wrapperEnd: originalEnd + PREVIEW_HIGHLIGHT_PREFIX.length + PREVIEW_HIGHLIGHT_SUFFIX.length,
      highlightedLineText
    }
  };
}

export function originalOffsetFromHighlightedOffset(mapping: PreviewHighlightMapping, highlightedOffset: number): number {
  if (highlightedOffset < mapping.originalStart) return highlightedOffset;
  if (highlightedOffset < mapping.highlightedStart) return mapping.originalStart;
  if (highlightedOffset <= mapping.highlightedEnd) {
    return mapping.originalStart + highlightedOffset - mapping.highlightedStart;
  }
  if (highlightedOffset <= mapping.wrapperEnd) return mapping.originalEnd;
  return highlightedOffset - PREVIEW_HIGHLIGHT_PREFIX.length - PREVIEW_HIGHLIGHT_SUFFIX.length;
}

export function findPreviewTextMatchInSourceLine(
  sourceLine: string,
  previewText: string,
  previewOffset: number
): { sourceOffset: number } | null {
  const text = previewText.replace(/\s+/g, " ");
  const offset = Math.max(0, Math.min(previewOffset, text.length));
  const sourceLineForSearch = sourceLine.replace(/\s+/g, " ");

  const direct = findPreviewSnippetInSourceLine(sourceLineForSearch, text, offset);
  if (direct) return direct;

  const before = text.slice(Math.max(0, offset - 24), offset).trimStart();
  const after = text.slice(offset, Math.min(text.length, offset + 48)).trimEnd();
  const around = `${before}${after}`;
  return findPreviewSnippetInSourceLine(sourceLineForSearch, around, Math.min(before.length, around.length));
}

function findPreviewSnippetInSourceLine(sourceLine: string, snippet: string, snippetOffset: number): { sourceOffset: number } | null {
  const trimmedSnippet = snippet.trim();
  if (trimmedSnippet.length < 2) return null;

  let index = sourceLine.indexOf(trimmedSnippet);
  if (index !== -1) {
    const leadingTrim = snippet.length - snippet.trimStart().length;
    return { sourceOffset: index + Math.max(0, snippetOffset - leadingTrim) };
  }

  for (let size = Math.min(32, trimmedSnippet.length); size >= 3; size--) {
    const start = Math.max(0, Math.min(snippetOffset, trimmedSnippet.length) - Math.floor(size / 2));
    const probe = trimmedSnippet.slice(start, start + size);
    if (probe.length < 3) continue;
    index = sourceLine.indexOf(probe);
    if (index !== -1) return { sourceOffset: index + Math.floor(probe.length / 2) };
  }

  return null;
}

function wordRangeAtCursor(doc: Text, cursor: number): SourceRange | null {
  if (!doc.length) return null;

  const line = doc.lineAt(Math.min(cursor, doc.length));
  const lineText = line.text;
  let index = Math.max(0, Math.min(cursor - line.from, lineText.length));

  if (index === lineText.length || !isWordChar(lineText[index])) {
    const previousIndex = previousCodePointIndex(lineText, index);
    if (previousIndex === null || !isWordChar(lineText[previousIndex])) return null;
    index = previousIndex;
  }

  let start = index;
  while (true) {
    const previousIndex = previousCodePointIndex(lineText, start);
    if (previousIndex === null || !isWordChar(lineText[previousIndex])) break;
    start = previousIndex;
  }

  let end = index;
  while (end < lineText.length && isWordChar(lineText[end])) {
    end += lineText.codePointAt(end)! > 0xffff ? 2 : 1;
  }

  return end > start ? { from: line.from + start, to: line.from + end } : null;
}

function isPreviewHighlightableRange(doc: Text, range: SourceRange): boolean {
  const line = doc.lineAt(range.from);
  if (range.to > line.to) return false;

  const start = range.from - line.from;
  const end = range.to - line.from;
  if (isInsideExcludedInlineRegion(line.text, start)) return false;
  return !isTypstCodeSyntaxRange(line.text, start, end);
}

function isInsideExcludedInlineRegion(lineText: string, index: number): boolean {
  let inRaw = false;
  let inMath = false;
  let inBlockComment = false;

  for (let i = 0; i < index; i++) {
    const char = lineText[i];
    const next = lineText[i + 1];
    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (!inRaw && !inMath && char === "/" && next === "/") return true;
    if (!inRaw && !inMath && char === "/" && next === "*") {
      inBlockComment = true;
      i++;
      continue;
    }
    if (!inMath && char === "`") {
      inRaw = !inRaw;
      continue;
    }
    if (!inRaw && char === "$") inMath = !inMath;
  }

  return inRaw || inMath || inBlockComment;
}

function isTypstCodeSyntaxRange(lineText: string, start: number, end: number): boolean {
  for (let hash = 0; hash < start; hash++) {
    if (lineText[hash] !== "#") continue;
    const span = typstCodeExpressionSpan(lineText, hash);
    if (span && start < span.to && end > span.from) return true;
  }
  return false;
}

function typstCodeExpressionSpan(lineText: string, hash: number): SourceRange | null {
  let index = skipInlineWhitespace(lineText, hash + 1);
  const expressionStart = index;
  if (index >= lineText.length) return { from: hash, to: Math.min(hash + 1, lineText.length) };
  if (!isWordChar(lineText[index])) return { from: hash, to: Math.min(index + 1, lineText.length) };

  const nameStart = index;
  while (index < lineText.length && isWordChar(lineText[index])) {
    index += lineText.codePointAt(index)! > 0xffff ? 2 : 1;
  }

  const name = lineText.slice(nameStart, index);
  if (isLineCodeKeyword(name)) return { from: expressionStart, to: typstKeywordExpressionEnd(lineText, index, name) };

  let expressionEnd = index;
  const afterName = skipInlineWhitespace(lineText, index);
  if (lineText[afterName] === "(") expressionEnd = matchingDelimiterEnd(lineText, afterName, "(", ")") ?? lineText.length;
  return { from: expressionStart, to: expressionEnd };
}

function typstKeywordExpressionEnd(lineText: string, index: number, keyword: string): number {
  if (keyword !== "set" && keyword !== "show") return lineText.length;

  let cursor = skipInlineWhitespace(lineText, index);
  while (cursor < lineText.length && isWordChar(lineText[cursor])) {
    cursor += lineText.codePointAt(cursor)! > 0xffff ? 2 : 1;
  }
  cursor = skipInlineWhitespace(lineText, cursor);
  return lineText[cursor] === "(" ? matchingDelimiterEnd(lineText, cursor, "(", ")") ?? lineText.length : lineText.length;
}

function matchingDelimiterEnd(lineText: string, openIndex: number, open: string, close: string): number | null {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = openIndex; i < lineText.length; i++) {
    const char = lineText[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === open) depth++;
    else if (char === close && --depth === 0) return i + 1;
  }
  return null;
}

function skipInlineWhitespace(text: string, index: number): number {
  let cursor = index;
  while (cursor < text.length && /\s/.test(text[cursor])) cursor++;
  return cursor;
}

function isLineCodeKeyword(name: string): boolean {
  return /^(let|set|show|import|include|if|else|for|while|break|continue|return)$/.test(name);
}

function previousCodePointIndex(text: string, index: number): number | null {
  if (index <= 0) return null;
  const previous = index - 1;
  return previous > 0 && /[\uDC00-\uDFFF]/.test(text[previous]) ? previous - 1 : previous;
}

function isWordChar(char: string | undefined): boolean {
  return !!char && /[\p{L}\p{N}\p{M}_-]/u.test(char);
}
