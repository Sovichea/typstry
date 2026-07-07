import { StateField, type EditorState, type Extension, type Transaction } from "@codemirror/state";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import type { Rect } from "@codemirror/view";
import { showInvisibleCharacters } from "../../invisibles";
import { codePointAtOffset, previousCodePointOffset } from "../unicode";

class KhmerCompositionBoundaryWidget extends WidgetType {
  constructor(private readonly visible: boolean) {
    super();
  }

  eq(other: KhmerCompositionBoundaryWidget): boolean {
    return this.visible === other.visible;
  }

  toDOM(): HTMLElement {
    const boundary = document.createElement("span");
    boundary.className = this.visible
      ? "cm-khmer-composition-boundary cm-khmer-composition-boundary-visible"
      : "cm-khmer-composition-boundary";
    boundary.textContent = "\u200C";
    boundary.setAttribute("aria-hidden", "true");
    return boundary;
  }

  ignoreEvent(): boolean {
    return true;
  }

  coordsAt(dom: HTMLElement): Rect {
    const rect = dom.getBoundingClientRect();
    return {
      left: rect.right,
      right: rect.right,
      top: rect.top,
      bottom: rect.bottom
    };
  }
}

function boundaryDecoration(visible: boolean): Decoration {
  return Decoration.widget({
    widget: new KhmerCompositionBoundaryWidget(visible),
    side: -1
  });
}

const boundaryState = StateField.define<number | null>({
  create: () => null,
  update(value, transaction) {
    if (!transaction.docChanged) return value;
    const insertedBoundary = insertedTrailingCoengBoundary(transaction);
    if (insertedBoundary !== null) return insertedBoundary;
    if (value === null) return null;
    const mappedBoundary = transaction.changes.mapPos(value, 1);
    return isValidCompositionBoundary(transaction.newDoc.sliceString(0), mappedBoundary)
      ? mappedBoundary
      : null;
  },
  provide: field => EditorView.decorations.compute(
    [field, showInvisibleCharacters],
    state => {
      const boundary = state.field(field);
      return boundary === null
        ? Decoration.none
        : Decoration.set([boundaryDecoration(state.facet(showInvisibleCharacters)).range(boundary)]);
    }
  )
});

export const khmerCompositionBoundaryState: Extension = boundaryState;

export function getTemporaryKhmerBoundary(state: EditorState): number | null {
  return state.field(boundaryState, false) ?? null;
}

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
  return isValidCompositionBoundary(transaction.newDoc.sliceString(0), boundary) ? boundary : null;
}

function isValidCompositionBoundary(text: string, boundary: number): boolean {
  const coengFrom = previousCodePointOffset(text, boundary);
  if (text.slice(coengFrom, boundary) !== "\u17D2") return false;
  const baseFrom = previousCodePointOffset(text, coengFrom);
  const base = codePointAtOffset(text, baseFrom);
  const next = codePointAtOffset(text, boundary);
  return isKhmerConsonant(base) && isKhmerConsonant(next);
}

function isKhmerConsonant(codePoint: number | null): boolean {
  return codePoint !== null && codePoint >= 0x1780 && codePoint <= 0x17A2;
}
