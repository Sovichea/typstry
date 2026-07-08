export function findPreviewTextMatchInSourceLine(
  sourceLine: string,
  previewText: string,
  previewOffset: number,
  preferredSourceOffset?: number
): { sourceOffset: number } | null {
  const normalizedPreview = normalizeWhitespaceWithMap(previewText);
  const text = normalizedPreview.text;
  const offset = normalizedOffsetAt(normalizedPreview.normalizedOffsets, previewOffset);
  const normalizedSource = normalizeWhitespaceWithMap(sourceLine);

  const preferredNormalizedOffset = preferredSourceOffset === undefined
    ? undefined
    : normalizedOffsetAt(normalizedSource.normalizedOffsets, preferredSourceOffset);
  const direct = findPreviewSnippetInSourceLine(normalizedSource.text, normalizedSource.sourceOffsets, text, offset, preferredNormalizedOffset);
  if (direct) return direct;

  const before = text.slice(Math.max(0, offset - 24), offset).trimStart();
  const after = text.slice(offset, Math.min(text.length, offset + 48)).trimEnd();
  const around = `${before}${after}`;
  return findPreviewSnippetInSourceLine(
    normalizedSource.text,
    normalizedSource.sourceOffsets,
    around,
    Math.min(before.length, around.length),
    preferredNormalizedOffset
  );
}

export function findPreviewTextMatchInSource(
  source: string,
  previewText: string,
  previewOffset: number,
  preferredSourceOffset = 0
): { sourceOffset: number } | null {
  let lineFrom = 0;
  let best: { sourceOffset: number; distance: number } | null = null;
  for (const line of source.split("\n")) {
    const match = findPreviewTextMatchInSourceLine(
      line,
      previewText,
      previewOffset,
      Math.max(0, Math.min(line.length, preferredSourceOffset - lineFrom))
    );
    if (match) {
      const sourceOffset = lineFrom + match.sourceOffset;
      const distance = Math.abs(sourceOffset - preferredSourceOffset);
      if (!best || distance < best.distance) best = { sourceOffset, distance };
    }
    lineFrom += line.length + 1;
  }
  return best ? { sourceOffset: best.sourceOffset } : null;
}

export type RankedPreviewTextMatch = { sourceOffset: number; score: number };

export function findRankedPreviewTextMatchInSource(
  source: string,
  previewText: string,
  previewOffset: number,
  preferredSourceOffset = 0
): RankedPreviewTextMatch | null {
  const preview = normalizeWhitespaceWithMap(previewText);
  const clicked = normalizedOffsetAt(preview.normalizedOffsets, previewOffset);
  const probes: Array<{ text: string; click: number }> = [];
  for (const size of [96, 72, 56, 40, 32, 24, 16, 12, 8]) {
    const start = Math.max(0, Math.min(preview.text.length - size, clicked - Math.floor(size / 2)));
    const raw = preview.text.slice(start, start + size);
    const leading = raw.length - raw.trimStart().length;
    const text = raw.trim();
    if (text.length >= 8) probes.push({ text, click: Math.max(0, clicked - start - leading) });
  }

  let lineFrom = 0;
  let best: { sourceOffset: number; score: number; distance: number } | null = null;
  for (const line of source.split("\n")) {
    const normalizedLine = normalizeWhitespaceWithMap(line);
    for (const probe of probes) {
      for (let index = normalizedLine.text.indexOf(probe.text); index !== -1; index = normalizedLine.text.indexOf(probe.text, index + 1)) {
        const sourceOffset = lineFrom + originalOffsetAt(normalizedLine.sourceOffsets, index + Math.min(probe.click, probe.text.length));
        const distance = Math.abs(sourceOffset - preferredSourceOffset);
        if (!best || probe.text.length > best.score || (probe.text.length === best.score && distance < best.distance)) {
          best = { sourceOffset, score: probe.text.length, distance };
        }
      }
    }
    lineFrom += line.length + 1;
  }
  return best ? { sourceOffset: best.sourceOffset, score: best.score } : null;
}

function findPreviewSnippetInSourceLine(
  sourceLine: string,
  sourceOffsets: readonly number[],
  snippet: string,
  snippetOffset: number,
  preferredSourceOffset?: number
): { sourceOffset: number } | null {
  const trimmedSnippet = snippet.trim();
  if (trimmedSnippet.length < 2) return null;

  let index = bestMatchIndex(sourceLine, trimmedSnippet, preferredSourceOffset);
  if (index !== -1) {
    const leadingTrim = snippet.length - snippet.trimStart().length;
    return { sourceOffset: originalOffsetAt(sourceOffsets, index + Math.max(0, snippetOffset - leadingTrim)) };
  }

  for (let size = Math.min(32, trimmedSnippet.length); size >= 3; size--) {
    const start = Math.max(0, Math.min(snippetOffset, trimmedSnippet.length) - Math.floor(size / 2));
    const probe = trimmedSnippet.slice(start, start + size);
    if (probe.length < 3) continue;
    index = bestMatchIndex(sourceLine, probe, preferredSourceOffset);
    if (index !== -1) return { sourceOffset: originalOffsetAt(sourceOffsets, index + Math.floor(probe.length / 2)) };
  }

  return null;
}

function bestMatchIndex(sourceLine: string, probe: string, preferredSourceOffset: number | undefined): number {
  if (preferredSourceOffset === undefined) return sourceLine.indexOf(probe);
  let bestIndex = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let index = sourceLine.indexOf(probe); index !== -1; index = sourceLine.indexOf(probe, index + 1)) {
    const distance = Math.abs((index + Math.floor(probe.length / 2)) - preferredSourceOffset);
    if (distance < bestDistance) {
      bestIndex = index;
      bestDistance = distance;
    }
  }
  return bestIndex;
}

function normalizeWhitespaceWithMap(source: string): { text: string; sourceOffsets: number[]; normalizedOffsets: number[] } {
  let text = "";
  const sourceOffsets: number[] = [];
  const normalizedOffsets: number[] = [];
  let inWhitespace = false;

  for (let index = 0; index < source.length;) {
    const codePoint = source.codePointAt(index);
    const char = String.fromCodePoint(codePoint ?? source.charCodeAt(index));
    const width = char.length;
    if (/[\u00ad\u200b\u200c\u200d\ufeff]/u.test(char)) {
      for (let cursor = 0; cursor < width; cursor += 1) normalizedOffsets[index + cursor] = text.length;
    } else if (/\s/u.test(char)) {
      if (!inWhitespace) {
        const normalizedIndex = text.length;
        text += " ";
        sourceOffsets.push(index);
        for (let cursor = 0; cursor < width; cursor += 1) normalizedOffsets[index + cursor] = normalizedIndex;
        inWhitespace = true;
      } else {
        for (let cursor = 0; cursor < width; cursor += 1) normalizedOffsets[index + cursor] = text.length - 1;
      }
    } else {
      const normalizedIndex = text.length;
      text += char;
      sourceOffsets.push(index);
      for (let cursor = 0; cursor < width; cursor += 1) normalizedOffsets[index + cursor] = normalizedIndex + cursor;
      inWhitespace = false;
    }
    index += width;
  }

  sourceOffsets.push(source.length);
  normalizedOffsets[source.length] = text.length;
  return { text, sourceOffsets, normalizedOffsets };
}

function originalOffsetAt(sourceOffsets: readonly number[], normalizedOffset: number): number {
  const index = Math.max(0, Math.min(normalizedOffset, sourceOffsets.length - 1));
  return sourceOffsets[index] ?? 0;
}

function normalizedOffsetAt(normalizedOffsets: readonly number[], originalOffset: number): number {
  const index = Math.max(0, Math.min(originalOffset, normalizedOffsets.length - 1));
  return normalizedOffsets[index] ?? 0;
}
