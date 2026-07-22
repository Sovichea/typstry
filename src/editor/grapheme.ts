import { EditorSelection, EditorState, type Extension, type Text, type Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { editingPolicyRegistry } from "./editingPolicies/registry";

function getTemporaryEditingBoundary(state: EditorState): number | null {
  return editingPolicyRegistry.temporaryBoundary(state);
}

export type GraphemeBoundary = {
  from: number;
  to: number;
};

export function graphemeBoundaries(text: string, temporaryBoundary: number | null = null): GraphemeBoundary[] {
  return editingPolicyRegistry.boundaries(text, temporaryBoundary);
}

export function previousGraphemeBoundary(
  doc: Text,
  position: number,
  temporaryBoundary: number | null = null,
  selection = false
): number {
  const line = doc.lineAt(Math.max(0, Math.min(position, doc.length)));
  const local = position - line.from;
  const localTemporaryBoundary = temporaryBoundary === null ? null : temporaryBoundary - line.from;
  let previous = 0;
  for (const boundary of graphemeBoundaries(line.text, localTemporaryBoundary)) {
    if (boundary.to >= local) {
      const unicodeBoundary = local <= boundary.from ? previous : boundary.from;
      return line.from + editingPolicyRegistry.movementBoundary(
        line.text,
        local,
        "backward",
        unicodeBoundary,
        selection
      );
    }
    previous = boundary.to;
  }
  return line.from + previous;
}

export function nextGraphemeBoundary(
  doc: Text,
  position: number,
  temporaryBoundary: number | null = null,
  selection = false
): number {
  const line = doc.lineAt(Math.max(0, Math.min(position, doc.length)));
  const local = position - line.from;
  const localTemporaryBoundary = temporaryBoundary === null ? null : temporaryBoundary - line.from;
  for (const boundary of graphemeBoundaries(line.text, localTemporaryBoundary)) {
    if (boundary.from <= local && local < boundary.to) {
      return line.from + editingPolicyRegistry.movementBoundary(
        line.text,
        local,
        "forward",
        boundary.to,
        selection
      );
    }
    if (local < boundary.from) {
      return line.from + editingPolicyRegistry.movementBoundary(
        line.text,
        local,
        "forward",
        boundary.from,
        selection
      );
    }
  }
  return line.to;
}

export function deletePreviousGrapheme(view: EditorView): boolean {
  return deleteByPolicy(view, "backward");
}

export function deleteNextGrapheme(view: EditorView): boolean {
  return deleteByPolicy(view, "forward");
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
      return line.from + (local <= midpoint ? boundary.from : boundary.to);
    }
  }
  return Math.max(line.from, Math.min(position, line.to));
}

export const graphemeSelectionBoundaryFilter: Extension = EditorState.transactionFilter.of((transaction: Transaction) => {
  if (!transaction.selection || transaction.docChanged) return transaction;
  const temporaryBoundary = getTemporaryEditingBoundary(transaction.startState);
  const selectionKeepsTemporaryBoundary = temporaryBoundary !== null
    && transaction.selection.main.empty
    && transaction.selection.main.head === temporaryBoundary;
  const snapped = snapSelectionToGraphemeBoundaries(
    transaction.newDoc,
    transaction.selection,
    selectionKeepsTemporaryBoundary ? temporaryBoundary : null,
    transaction.isUserEvent("select.pointer")
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
  temporaryBoundary: number | null = null,
  pointerSelection = false
): EditorSelection {
  const ranges = selection.ranges.map(range => {
    if (!range.empty) {
      const forward = range.anchor < range.head;
      const anchor = snapSelectionEndpoint(
        doc,
        range.anchor,
        forward ? "backward" : "forward",
        temporaryBoundary
      );
      const head = snapSelectionEndpoint(
        doc,
        range.head,
        forward ? "forward" : "backward",
        temporaryBoundary
      );
      return anchor === head
        ? EditorSelection.cursor(anchor, range.assoc, range.bidiLevel ?? undefined, range.goalColumn)
        : EditorSelection.range(anchor, head, range.goalColumn, range.bidiLevel ?? undefined, range.assoc);
    }
    const snap = pointerSelection ? snapPointerPositionToGraphemeBoundary : snapPositionToGraphemeBoundary;
    const anchor = snap(doc, range.anchor, temporaryBoundary);
    const head = snap(doc, range.head, temporaryBoundary);
    return anchor === head
      ? EditorSelection.cursor(anchor, range.assoc, range.bidiLevel ?? undefined, range.goalColumn)
      : EditorSelection.range(anchor, head, range.goalColumn, range.bidiLevel ?? undefined, range.assoc);
  });
  return EditorSelection.create(ranges, selection.mainIndex);
}

function snapPointerPositionToGraphemeBoundary(
  doc: Text,
  position: number,
  temporaryBoundary: number | null = null
): number {
  const line = doc.lineAt(Math.max(0, Math.min(position, doc.length)));
  const local = position - line.from;
  const localTemporaryBoundary = temporaryBoundary === null ? null : temporaryBoundary - line.from;
  for (const boundary of graphemeBoundaries(line.text, localTemporaryBoundary)) {
    if (boundary.from < local && local < boundary.to
      && boundary.from === 0
      && line.text.slice(boundary.from, boundary.to).includes("\u17D2")) {
      return line.from;
    }
  }
  return snapPositionToGraphemeBoundary(doc, position, temporaryBoundary);
}

function snapSelectionEndpoint(
  doc: Text,
  position: number,
  direction: "backward" | "forward",
  temporaryBoundary: number | null
): number {
  const clamped = Math.max(0, Math.min(position, doc.length));
  const line = doc.lineAt(clamped);
  const local = clamped - line.from;
  const localTemporaryBoundary = temporaryBoundary === null ? null : temporaryBoundary - line.from;
  for (const boundary of graphemeBoundaries(line.text, localTemporaryBoundary)) {
    if (local === boundary.from || local === boundary.to) return clamped;
    if (boundary.from < local && local < boundary.to) {
      return line.from + (direction === "backward" ? boundary.from : boundary.to);
    }
  }
  return clamped;
}

function deleteByPolicy(view: EditorView, direction: "backward" | "forward"): boolean {
  const selection = view.state.selection;
  const temporaryBoundary = getTemporaryEditingBoundary(view.state);
  const ranges = deletionRangesForSelection(view.state.doc, selection, direction, temporaryBoundary);
  if (!ranges) return false;
  view.dispatch({
    changes: ranges,
    scrollIntoView: true,
    userEvent: direction === "backward" ? "delete.backward" : "delete.forward"
  });
  return true;
}

export function deletionRangesForSelection(
  doc: Text,
  selection: EditorSelection,
  direction: "backward" | "forward",
  temporaryBoundary: number | null = null
): GraphemeBoundary[] | null {
  if (selection.ranges.some(range => !range.empty)) return null;
  const ranges: GraphemeBoundary[] = [];
  for (const selectionRange of selection.ranges) {
    const position = snapPositionToGraphemeBoundary(doc, selectionRange.head, temporaryBoundary);
    const deletion = codePointDeletionRange(doc, position, direction, temporaryBoundary);
    if (!deletion) return null;
    ranges.push(deletion);
  }
  ranges.sort((left, right) => left.from - right.from || left.to - right.to);
  const merged: GraphemeBoundary[] = [];
  for (const range of ranges) {
    const previous = merged[merged.length - 1];
    if (previous && range.from <= previous.to) previous.to = Math.max(previous.to, range.to);
    else merged.push({ ...range });
  }
  return merged;
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
    const range = editingPolicyRegistry.backwardDeletionRange(line.text, local);
    return range ? { from: line.from + range.from, to: line.from + range.to } : null;
  }
  if (local >= line.length) return null;
  const localTemporaryBoundary = temporaryBoundary === null ? null : temporaryBoundary - line.from;
  const range = editingPolicyRegistry.forwardDeletionRange(line.text, local, localTemporaryBoundary);
  return range ? { from: line.from + range.from, to: line.from + range.to } : null;
}

function moveByGrapheme(view: EditorView, direction: "backward" | "forward", extend: boolean): boolean {
  const selection = view.state.selection;
  const nextSelection = moveSelectionByGrapheme(
    view.state.doc,
    selection,
    direction,
    extend,
    getTemporaryEditingBoundary(view.state)
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
      ? previousGraphemeBoundary(doc, head, temporaryBoundary, extend)
      : nextGraphemeBoundary(doc, head, temporaryBoundary, extend);
    if (extend) {
      const anchor = snapPositionToGraphemeBoundary(doc, range.anchor, temporaryBoundary);
      return anchor === target ? EditorSelection.cursor(target) : EditorSelection.range(anchor, target);
    }
    return EditorSelection.cursor(target);
  });
  return EditorSelection.create(ranges, selection.mainIndex);
}
