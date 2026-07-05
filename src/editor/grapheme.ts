import { EditorSelection, EditorState, type Extension, type Text, type Transaction } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

type SegmentRecord = { segment: string; index: number };
type SegmenterLike = {
  segment(input: string): Iterable<SegmentRecord>;
};

const segmenter: SegmenterLike | null = (() => {
  const ctor = (Intl as unknown as {
    Segmenter?: new (locale: string | undefined, options: { granularity: "grapheme" }) => SegmenterLike;
  }).Segmenter;
  return ctor ? new ctor(undefined, { granularity: "grapheme" }) : null;
})();

export type GraphemeBoundary = {
  from: number;
  to: number;
};

export function graphemeBoundaries(text: string): GraphemeBoundary[] {
  if (!text) return [];
  if (/[\u1780-\u17ff]/u.test(text)) return khmerAwareGraphemeBoundaries(text);
  return unicodeGraphemeBoundaries(text);
}

function unicodeGraphemeBoundaries(text: string): GraphemeBoundary[] {
  if (!segmenter) {
    const boundaries: GraphemeBoundary[] = [];
    let offset = 0;
    for (const char of text) {
      const next = offset + char.length;
      boundaries.push({ from: offset, to: next });
      offset = next;
    }
    return boundaries;
  }

  const starts = [...segmenter.segment(text)].map(segment => segment.index);
  const boundaries: GraphemeBoundary[] = [];
  for (let index = 0; index < starts.length; index += 1) {
    boundaries.push({
      from: starts[index],
      to: starts[index + 1] ?? text.length
    });
  }
  return boundaries;
}

function khmerAwareGraphemeBoundaries(text: string): GraphemeBoundary[] {
  const raw = unicodeGraphemeBoundaries(text);
  const merged: GraphemeBoundary[] = [];
  for (const boundary of raw) {
    const previous = merged[merged.length - 1];
    const segment = text.slice(boundary.from, boundary.to);
    const previousSegment = previous ? text.slice(previous.from, previous.to) : "";
    if (
      previous
      && (
        previousSegment.endsWith("\u17D2")
        || startsWithKhmerDependentMark(segment)
      )
    ) {
      previous.to = boundary.to;
    } else {
      merged.push({ ...boundary });
    }
  }
  return merged;
}

function startsWithKhmerDependentMark(text: string): boolean {
  const first = text.codePointAt(0);
  return first !== undefined && (
    (first >= 0x17B6 && first <= 0x17D3)
    || first === 0x17DD
  );
}

export function previousGraphemeBoundary(doc: Text, position: number): number {
  const line = doc.lineAt(Math.max(0, Math.min(position, doc.length)));
  const local = position - line.from;
  let previous = 0;
  for (const boundary of graphemeBoundaries(line.text)) {
    if (boundary.to >= local) {
      return line.from + (local <= boundary.from ? previous : boundary.from);
    }
    previous = boundary.to;
  }
  return line.from + previous;
}

export function nextGraphemeBoundary(doc: Text, position: number): number {
  const line = doc.lineAt(Math.max(0, Math.min(position, doc.length)));
  const local = position - line.from;
  for (const boundary of graphemeBoundaries(line.text)) {
    if (boundary.from <= local && local < boundary.to) return line.from + boundary.to;
    if (local < boundary.from) return line.from + boundary.from;
  }
  return line.to;
}

export function deletePreviousGrapheme(view: EditorView): boolean {
  return deleteByCodePoint(view, "backward");
}

export function deleteNextGrapheme(view: EditorView): boolean {
  return deleteByCodePoint(view, "forward");
}

export function movePreviousGrapheme(view: EditorView): boolean {
  return moveByGrapheme(view, "backward", false);
}

export function moveNextGrapheme(view: EditorView): boolean {
  return moveByGrapheme(view, "forward", false);
}

export function selectPreviousGrapheme(view: EditorView): boolean {
  return moveByGrapheme(view, "backward", true);
}

export function selectNextGrapheme(view: EditorView): boolean {
  return moveByGrapheme(view, "forward", true);
}

export function snapPositionToGraphemeBoundary(doc: Text, position: number): number {
  const line = doc.lineAt(Math.max(0, Math.min(position, doc.length)));
  const local = position - line.from;
  for (const boundary of graphemeBoundaries(line.text)) {
    if (local <= boundary.from) return line.from + boundary.from;
    if (boundary.from < local && local < boundary.to) {
      const midpoint = boundary.from + ((boundary.to - boundary.from) / 2);
      return line.from + (local < midpoint ? boundary.from : boundary.to);
    }
  }
  return Math.max(line.from, Math.min(position, line.to));
}

export const graphemeSelectionBoundaryFilter: Extension = EditorState.transactionFilter.of((transaction: Transaction) => {
  if (!transaction.selection || transaction.docChanged) return transaction;
  const snapped = snapSelectionToGraphemeBoundaries(transaction.newDoc, transaction.selection);
  if (snapped.eq(transaction.selection)) return transaction;
  return {
    selection: snapped,
    scrollIntoView: transaction.scrollIntoView
  };
});

export function snapSelectionToGraphemeBoundaries(doc: Text, selection: EditorSelection): EditorSelection {
  const ranges = selection.ranges.map(range => {
    const anchor = snapPositionToGraphemeBoundary(doc, range.anchor);
    const head = snapPositionToGraphemeBoundary(doc, range.head);
    return anchor === head ? EditorSelection.cursor(anchor) : EditorSelection.range(anchor, head);
  });
  return EditorSelection.create(ranges, selection.mainIndex);
}

function deleteByCodePoint(view: EditorView, direction: "backward" | "forward"): boolean {
  const selection = view.state.selection;
  if (!selection.main.empty) return false;
  const position = snapPositionToGraphemeBoundary(view.state.doc, selection.main.head);
  const range = codePointDeletionRange(view.state.doc, position, direction);
  if (!range) return false;
  view.dispatch({
    changes: range,
    selection: { anchor: range.from },
    scrollIntoView: true,
    userEvent: direction === "backward" ? "delete.backward" : "delete.forward"
  });
  return true;
}

export function codePointDeletionRange(doc: Text, position: number, direction: "backward" | "forward"): GraphemeBoundary | null {
  const line = doc.lineAt(Math.max(0, Math.min(position, doc.length)));
  const local = position - line.from;
  if (direction === "backward") {
    if (local <= 0) return null;
    const khmerSubscriptFrom = previousKhmerSubscriptPairOffset(line.text, local);
    if (khmerSubscriptFrom !== null) {
      return { from: line.from + khmerSubscriptFrom, to: line.from + local };
    }
    const from = previousCodePointOffset(line.text, local);
    return { from: line.from + from, to: line.from + local };
  }
  if (local >= line.length) return null;
  const khmerSubscriptTo = nextKhmerSubscriptPairOffset(line.text, local);
  if (khmerSubscriptTo !== null) {
    return { from: line.from + local, to: line.from + khmerSubscriptTo };
  }
  const to = nextCodePointOffset(line.text, local);
  return { from: line.from + local, to: line.from + to };
}

function moveByGrapheme(view: EditorView, direction: "backward" | "forward", extend: boolean): boolean {
  const selection = view.state.selection;
  const nextSelection = moveSelectionByGrapheme(view.state.doc, selection, direction, extend);
  if (nextSelection.eq(selection)) return false;
  view.dispatch({
    selection: nextSelection,
    scrollIntoView: true,
    userEvent: "select"
  });
  return true;
}

export function moveSelectionByGrapheme(
  doc: Text,
  selection: EditorSelection,
  direction: "backward" | "forward",
  extend: boolean
): EditorSelection {
  const ranges = selection.ranges.map(range => {
    const head = snapPositionToGraphemeBoundary(doc, range.head);
    const target = direction === "backward"
      ? previousGraphemeBoundary(doc, head)
      : nextGraphemeBoundary(doc, head);
    if (extend) {
      const anchor = snapPositionToGraphemeBoundary(doc, range.anchor);
      return anchor === target ? EditorSelection.cursor(target) : EditorSelection.range(anchor, target);
    }
    return EditorSelection.cursor(target);
  });
  return EditorSelection.create(ranges, selection.mainIndex);
}

function previousCodePointOffset(text: string, offset: number): number {
  const position = Math.max(0, Math.min(offset, text.length));
  if (position > 1 && isLowSurrogate(text.charCodeAt(position - 1)) && isHighSurrogate(text.charCodeAt(position - 2))) {
    return position - 2;
  }
  return Math.max(0, position - 1);
}

function nextCodePointOffset(text: string, offset: number): number {
  const position = Math.max(0, Math.min(offset, text.length));
  if (position + 1 < text.length && isHighSurrogate(text.charCodeAt(position)) && isLowSurrogate(text.charCodeAt(position + 1))) {
    return position + 2;
  }
  return Math.min(text.length, position + 1);
}

function previousKhmerSubscriptPairOffset(text: string, offset: number): number | null {
  const consonantFrom = previousCodePointOffset(text, offset);
  if (!isKhmerConsonantAt(text, consonantFrom)) return null;
  const coengFrom = previousCodePointOffset(text, consonantFrom);
  return text.slice(coengFrom, consonantFrom) === "\u17D2" ? coengFrom : null;
}

function nextKhmerSubscriptPairOffset(text: string, offset: number): number | null {
  if (text.slice(offset, offset + 1) !== "\u17D2") return null;
  const consonantTo = nextCodePointOffset(text, offset + 1);
  return isKhmerConsonantAt(text, offset + 1) ? consonantTo : null;
}

function isKhmerConsonantAt(text: string, offset: number): boolean {
  const value = text.codePointAt(offset);
  return value !== undefined && value >= 0x1780 && value <= 0x17A2;
}

function isHighSurrogate(value: number): boolean {
  return value >= 0xD800 && value <= 0xDBFF;
}

function isLowSurrogate(value: number): boolean {
  return value >= 0xDC00 && value <= 0xDFFF;
}
