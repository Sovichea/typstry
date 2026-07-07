import { EditorSelection, EditorState, StateField, type Extension, type Text, type Transaction } from "@codemirror/state";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";

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

export function graphemeBoundaries(text: string, temporaryBoundary: number | null = null): GraphemeBoundary[] {
  if (!text) return [];
  const boundaries = /[\u1780-\u17ff]/u.test(text)
    ? khmerAwareGraphemeBoundaries(text)
    : unicodeGraphemeBoundaries(text);
  return splitAtTemporaryBoundary(boundaries, temporaryBoundary);
}

function splitAtTemporaryBoundary(boundaries: GraphemeBoundary[], position: number | null): GraphemeBoundary[] {
  if (position === null) return boundaries;
  const split: GraphemeBoundary[] = [];
  for (const boundary of boundaries) {
    if (boundary.from < position && position < boundary.to) {
      split.push({ from: boundary.from, to: position }, { from: position, to: boundary.to });
    } else {
      split.push(boundary);
    }
  }
  return split;
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

export function previousGraphemeBoundary(doc: Text, position: number, temporaryBoundary: number | null = null): number {
  const line = doc.lineAt(Math.max(0, Math.min(position, doc.length)));
  const local = position - line.from;
  const localTemporaryBoundary = temporaryBoundary === null ? null : temporaryBoundary - line.from;
  let previous = 0;
  for (const boundary of graphemeBoundaries(line.text, localTemporaryBoundary)) {
    if (boundary.to >= local) {
      return line.from + (local <= boundary.from ? previous : boundary.from);
    }
    previous = boundary.to;
  }
  return line.from + previous;
}

export function nextGraphemeBoundary(doc: Text, position: number, temporaryBoundary: number | null = null): number {
  const line = doc.lineAt(Math.max(0, Math.min(position, doc.length)));
  const local = position - line.from;
  const localTemporaryBoundary = temporaryBoundary === null ? null : temporaryBoundary - line.from;
  for (const boundary of graphemeBoundaries(line.text, localTemporaryBoundary)) {
    if (boundary.from <= local && local < boundary.to) return line.from + boundary.to;
    if (local < boundary.from) return line.from + boundary.from;
  }
  return line.to;
}

export function deletePreviousGrapheme(view: EditorView): boolean {
  return deleteByCodePoint(view, "backward");
}

export function deleteNextGrapheme(view: EditorView): boolean {
  const selection = view.state.selection;
  if (!selection.main.empty) return false;
  const temporaryBoundary = getTemporaryKhmerBoundary(view.state);
  const position = snapPositionToGraphemeBoundary(view.state.doc, selection.main.head, temporaryBoundary);
  const range = codePointDeletionRange(view.state.doc, position, "forward", temporaryBoundary);
  if (!range) return false;
  view.dispatch({
    changes: range,
    selection: { anchor: range.from },
    scrollIntoView: true,
    userEvent: "delete.forward"
  });
  return true;
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

export function snapPositionToGraphemeBoundary(doc: Text, position: number, temporaryBoundary: number | null = null): number {
  const line = doc.lineAt(Math.max(0, Math.min(position, doc.length)));
  const local = position - line.from;
  const localTemporaryBoundary = temporaryBoundary === null ? null : temporaryBoundary - line.from;
  for (const boundary of graphemeBoundaries(line.text, localTemporaryBoundary)) {
    if (local <= boundary.from) return line.from + boundary.from;
    if (boundary.from < local && local < boundary.to) {
      const midpoint = boundary.from + ((boundary.to - boundary.from) / 2);
      return line.from + (local < midpoint ? boundary.from : boundary.to);
    }
  }
  return Math.max(line.from, Math.min(position, line.to));
}

class KhmerCompositionBoundaryWidget extends WidgetType {
  eq(): boolean {
    return true;
  }

  toDOM(): HTMLElement {
    const boundary = document.createElement("span");
    boundary.className = "cm-khmer-composition-boundary";
    boundary.textContent = "\u200C";
    boundary.setAttribute("aria-hidden", "true");
    return boundary;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

const khmerCompositionBoundaryDecoration = Decoration.widget({
  widget: new KhmerCompositionBoundaryWidget(),
  side: 1
});

const temporaryKhmerBoundaryState = StateField.define<number | null>({
  create: () => null,
  update(value, transaction) {
    if (transaction.docChanged) return insertedTrailingCoengBoundary(transaction);
    if (!transaction.selection) return value;
    const selection = transaction.newSelection.main;
    return selection.empty && selection.head === value ? value : null;
  },
  provide: field => EditorView.decorations.from(field, boundary => boundary === null
    ? Decoration.none
    : Decoration.set([khmerCompositionBoundaryDecoration.range(boundary)]))
});

export const khmerCompositionBoundaryState: Extension = temporaryKhmerBoundaryState;

function insertedTrailingCoengBoundary(transaction: Transaction): number | null {
  let boundary: number | null = null;
  let changedRangeCount = 0;
  transaction.changes.iterChanges((_fromA, _toA, _fromB, toB, inserted) => {
    changedRangeCount += 1;
    if (inserted.sliceString(0).endsWith("\u17D2")) boundary = toB;
  });
  if (changedRangeCount !== 1 || boundary === null) return null;
  const selection = transaction.newSelection.main;
  if (!selection.empty || selection.head !== boundary) return null;
  return isKhmerConsonantAt(transaction.newDoc.sliceString(0), boundary) ? boundary : null;
}

function getTemporaryKhmerBoundary(state: EditorState): number | null {
  return state.field(temporaryKhmerBoundaryState, false) ?? null;
}

export const graphemeSelectionBoundaryFilter: Extension = EditorState.transactionFilter.of((transaction: Transaction) => {
  if (!transaction.selection || transaction.docChanged) return transaction;
  const temporaryBoundary = getTemporaryKhmerBoundary(transaction.startState);
  const selectionKeepsTemporaryBoundary = temporaryBoundary !== null
    && transaction.selection.main.empty
    && transaction.selection.main.head === temporaryBoundary;
  const snapped = snapSelectionToGraphemeBoundaries(
    transaction.newDoc,
    transaction.selection,
    selectionKeepsTemporaryBoundary ? temporaryBoundary : null
  );
  if (snapped.eq(transaction.selection)) return transaction;
  return {
    selection: snapped,
    scrollIntoView: transaction.scrollIntoView
  };
});

export function snapSelectionToGraphemeBoundaries(
  doc: Text,
  selection: EditorSelection,
  temporaryBoundary: number | null = null
): EditorSelection {
  const ranges = selection.ranges.map(range => {
    const anchor = snapPositionToGraphemeBoundary(doc, range.anchor, temporaryBoundary);
    const head = snapPositionToGraphemeBoundary(doc, range.head, temporaryBoundary);
    return anchor === head ? EditorSelection.cursor(anchor) : EditorSelection.range(anchor, head);
  });
  return EditorSelection.create(ranges, selection.mainIndex);
}

function deleteByCodePoint(view: EditorView, direction: "backward" | "forward"): boolean {
  const selection = view.state.selection;
  if (!selection.main.empty) return false;
  const temporaryBoundary = getTemporaryKhmerBoundary(view.state);
  const position = snapPositionToGraphemeBoundary(view.state.doc, selection.main.head, temporaryBoundary);
  const range = codePointDeletionRange(view.state.doc, position, direction, temporaryBoundary);
  if (!range) return false;
  view.dispatch({
    changes: range,
    selection: { anchor: range.from },
    scrollIntoView: true,
    userEvent: direction === "backward" ? "delete.backward" : "delete.forward"
  });
  return true;
}

export function codePointDeletionRange(
  doc: Text,
  position: number,
  direction: "backward" | "forward",
  temporaryBoundary: number | null = null
): GraphemeBoundary | null {
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
  const to = nextGraphemeBoundary(doc, position, temporaryBoundary);
  return to > position ? { from: position, to } : null;
}

function moveByGrapheme(view: EditorView, direction: "backward" | "forward", extend: boolean): boolean {
  const selection = view.state.selection;
  const nextSelection = moveSelectionByGrapheme(
    view.state.doc,
    selection,
    direction,
    extend,
    getTemporaryKhmerBoundary(view.state)
  );
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
  extend: boolean,
  temporaryBoundary: number | null = null
): EditorSelection {
  const ranges = selection.ranges.map(range => {
    const head = snapPositionToGraphemeBoundary(doc, range.head, temporaryBoundary);
    const target = direction === "backward"
      ? previousGraphemeBoundary(doc, head, temporaryBoundary)
      : nextGraphemeBoundary(doc, head, temporaryBoundary);
    if (extend) {
      const anchor = snapPositionToGraphemeBoundary(doc, range.anchor, temporaryBoundary);
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

function previousKhmerSubscriptPairOffset(text: string, offset: number): number | null {
  const consonantFrom = previousCodePointOffset(text, offset);
  if (!isKhmerConsonantAt(text, consonantFrom)) return null;
  const coengFrom = previousCodePointOffset(text, consonantFrom);
  return text.slice(coengFrom, consonantFrom) === "\u17D2" ? coengFrom : null;
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
