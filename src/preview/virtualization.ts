export function pagesToEvict(
  renderedPages: readonly number[],
  focusPage: number,
  maximumResidentPages: number
): number[] {
  if (maximumResidentPages < 1) return [...renderedPages];
  const excess = renderedPages.length - maximumResidentPages;
  if (excess <= 0) return [];
  return [...renderedPages]
    .sort((left, right) =>
      Math.abs(right - focusPage) - Math.abs(left - focusPage)
      || right - left
    )
    .slice(0, excess);
}

export function pageDimensionsChanged(
  previous: { width: number; height: number } | undefined,
  next: { width: number; height: number },
  tolerance = 0.01
): boolean {
  return !previous
    || Math.abs(previous.width - next.width) > tolerance
    || Math.abs(previous.height - next.height) > tolerance;
}

export function visiblePageIndexes(
  pageCount: number,
  pageTop: (index: number) => number,
  pageHeight: (index: number) => number,
  viewportTop: number,
  viewportHeight: number
): number[] {
  if (pageCount <= 0 || viewportHeight <= 0) return [];
  const viewportBottom = viewportTop + viewportHeight;
  let low = 0;
  let high = pageCount - 1;
  let first = pageCount;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    if (pageTop(middle) + pageHeight(middle) > viewportTop) {
      first = middle;
      high = middle - 1;
    } else {
      low = middle + 1;
    }
  }

  const visible: Array<{ index: number; pixels: number }> = [];
  for (let index = first; index < pageCount; index += 1) {
    const top = pageTop(index);
    if (top >= viewportBottom) break;
    const bottom = top + pageHeight(index);
    visible.push({
      index,
      pixels: Math.max(0, Math.min(bottom, viewportBottom) - Math.max(top, viewportTop))
    });
  }
  return visible
    .sort((left, right) => right.pixels - left.pixels || left.index - right.index)
    .map(page => page.index);
}
