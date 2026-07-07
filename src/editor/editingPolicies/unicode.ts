import type { EditingRange } from "./types";

type SegmentRecord = { segment: string; index: number };
type SegmenterLike = { segment(input: string): Iterable<SegmentRecord> };

const segmenter: SegmenterLike | null = (() => {
  const ctor = (Intl as unknown as {
    Segmenter?: new (locale: string | undefined, options: { granularity: "grapheme" }) => SegmenterLike;
  }).Segmenter;
  return ctor ? new ctor(undefined, { granularity: "grapheme" }) : null;
})();

export function unicodeGraphemeBoundaries(text: string): EditingRange[] {
  if (!text) return [];
  if (!segmenter) {
    const boundaries: EditingRange[] = [];
    let offset = 0;
    for (const char of text) {
      const next = offset + char.length;
      boundaries.push({ from: offset, to: next });
      offset = next;
    }
    return boundaries;
  }

  const starts = [...segmenter.segment(text)].map(segment => segment.index);
  return starts.map((from, index) => ({ from, to: starts[index + 1] ?? text.length }));
}

export function previousCodePointOffset(text: string, offset: number): number {
  const position = Math.max(0, Math.min(offset, text.length));
  if (position > 1 && isLowSurrogate(text.charCodeAt(position - 1)) && isHighSurrogate(text.charCodeAt(position - 2))) {
    return position - 2;
  }
  return Math.max(0, position - 1);
}

export function codePointAtOffset(text: string, offset: number): number | null {
  if (offset < 0 || offset >= text.length) return null;
  return text.codePointAt(offset) ?? null;
}

function isHighSurrogate(value: number): boolean {
  return value >= 0xD800 && value <= 0xDBFF;
}

function isLowSurrogate(value: number): boolean {
  return value >= 0xDC00 && value <= 0xDFFF;
}
