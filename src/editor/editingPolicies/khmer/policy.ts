import { getTemporaryKhmerBoundary, khmerCompositionBoundaryState } from "./composition";
import type { EditingRange, ScriptEditingPolicy } from "../types";
import { codePointAtOffset, previousCodePointOffset } from "../unicode";

const COENG = "\u17D2";

export const khmerEditingPolicy: ScriptEditingPolicy = {
  id: "khmer",
  scripts: ["Khmr"],
  editorExtensions: [khmerCompositionBoundaryState],
  temporaryBoundary: getTemporaryKhmerBoundary,

  ownsCodePoint(codePoint) {
    return codePoint >= 0x1780 && codePoint <= 0x17FF;
  },

  shouldMergeBoundary(text, boundary) {
    const previousFrom = previousCodePointOffset(text, boundary);
    const left = codePointAtOffset(text, previousFrom);
    const right = codePointAtOffset(text, boundary);
    if (left === null || right === null || !this.ownsCodePoint(left) || !this.ownsCodePoint(right)) return false;
    return text.slice(previousFrom, boundary) === COENG || isKhmerDependentMark(right);
  },

  backwardDeletionRange(text, offset): EditingRange | null {
    if (offset <= 0) return null;
    const consonantFrom = previousCodePointOffset(text, offset);
    if (isKhmerConsonant(codePointAtOffset(text, consonantFrom))) {
      const coengFrom = previousCodePointOffset(text, consonantFrom);
      if (text.slice(coengFrom, consonantFrom) === COENG) return { from: coengFrom, to: offset };
    }
    return { from: previousCodePointOffset(text, offset), to: offset };
  },

  forwardDeletionRange(_text, offset, nextBoundary): EditingRange | null {
    return nextBoundary > offset ? { from: offset, to: nextBoundary } : null;
  }
};

function isKhmerDependentMark(codePoint: number): boolean {
  return (codePoint >= 0x17B6 && codePoint <= 0x17D3) || codePoint === 0x17DD;
}

function isKhmerConsonant(codePoint: number | null): boolean {
  return codePoint !== null && codePoint >= 0x1780 && codePoint <= 0x17A2;
}
