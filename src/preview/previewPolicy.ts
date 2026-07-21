import { filePathKey } from "../platform/paths";

export type PreviewTarget = {
  rootPath: string | null;
  mainPath: string | null;
  imported: boolean;
  standalone: boolean;
  disabled: boolean;
};

export type PreviewRefreshStyle = "on-type" | "on-save";

export type ResearchDocumentIdentity = {
  workspaceKey: string;
  mainKey: string;
  sourceKey: string;
  cacheKey: string;
};

export function researchDocumentIdentity(
  workspacePath: string,
  mainPath: string | null,
  sourcePath: string
): ResearchDocumentIdentity {
  const workspaceKey = filePathKey(workspacePath);
  const mainKey = filePathKey(mainPath ?? sourcePath);
  const sourceKey = filePathKey(sourcePath);
  return {
    workspaceKey,
    mainKey,
    sourceKey,
    cacheKey: `${workspaceKey}::${mainKey}`
  };
}

export function allowsStandalonePreview(_contents: string): boolean {
  // Disabled for v1.0: independent preview roots currently make Tinymist
  // forward-sync task routing unreliable. Revisit under V1X-P.1.
  return false;
}

export function previewRefreshStyle(renderMode: PreviewRefreshStyle): PreviewRefreshStyle {
  return renderMode;
}

export function previewLspMainPath(target: Pick<PreviewTarget, "rootPath" | "mainPath" | "standalone">): string | null {
  return target.standalone ? target.rootPath : (target.mainPath ?? target.rootPath);
}

export function participatesInPreviewCompilation(
  activePath: string | null,
  pinnedMainPath: string | null,
  importedByMain: boolean
): boolean {
  return importedByMain || (
    !!activePath
    && !!pinnedMainPath
    && filePathKey(activePath) === filePathKey(pinnedMainPath)
  );
}

export function tinymistPreviewSourceColumn(lineText: string, utf16Offset: number): number {
  const offset = Math.max(0, Math.min(utf16Offset, lineText.length));
  return [...lineText.slice(0, offset)].length;
}

function likelyRenderedSourceCharacter(character: string): boolean {
  return !"#[]{}()=*_+-/`".includes(character)
    && /[\p{L}\p{M}\p{N}\p{S}]/u.test(character);
}

export function tinymistPreviewPreferredSourceColumn(
  lineText: string,
  utf16Offset: number
): number {
  const target = Math.max(0, Math.min(utf16Offset, lineText.length));
  const characters: Array<{ character: string; start: number; end: number }> = [];
  let offset = 0;
  for (const character of lineText) {
    const start = offset;
    offset += character.length;
    characters.push({ character, start, end: offset });
  }

  const previous = [...characters].reverse().find(entry => entry.end <= target);
  if (previous && likelyRenderedSourceCharacter(previous.character)) {
    return tinymistPreviewSourceColumn(lineText, target);
  }

  const next = characters.find(entry => entry.start >= target && likelyRenderedSourceCharacter(entry.character));
  if (next) return tinymistPreviewSourceColumn(lineText, next.end);

  const nearest = characters
    .filter(entry => likelyRenderedSourceCharacter(entry.character))
    .sort((left, right) => {
      const leftDistance = Math.min(Math.abs(left.start - target), Math.abs(left.end - target));
      const rightDistance = Math.min(Math.abs(right.start - target), Math.abs(right.end - target));
      return leftDistance - rightDistance || left.start - right.start;
    })[0];
  return tinymistPreviewSourceColumn(lineText, nearest?.end ?? target);
}

export function tinymistPreviewNearbySourceColumns(
  lineText: string,
  utf16Offset: number,
  limit = 12
): number[] {
  const target = Math.max(0, Math.min(utf16Offset, lineText.length));
  const boundaries = [0];
  let offset = 0;
  for (const character of lineText) {
    offset += character.length;
    boundaries.push(offset);
  }
  return boundaries
    .sort((left, right) => {
      const distance = Math.abs(left - target) - Math.abs(right - target);
      return distance || right - left;
    })
    .slice(0, Math.max(1, limit))
    .map(boundary => tinymistPreviewSourceColumn(lineText, boundary));
}

// Retained for render-cache offset tests and migrations. Tinymist's preview
// control plane does not consume these byte-oriented values.
export function tinymistPreviewByteColumn(lineText: string, utf16Offset: number): number {
  const offset = Math.max(0, Math.min(utf16Offset, lineText.length));
  return new TextEncoder().encode(lineText.slice(0, offset)).length;
}

export function tinymistPreviewNearbyByteColumns(
  lineText: string,
  utf16Offset: number,
  limit = 12
): number[] {
  const target = Math.max(0, Math.min(utf16Offset, lineText.length));
  const boundaries = [0];
  let offset = 0;
  for (const character of lineText) {
    offset += character.length;
    boundaries.push(offset);
  }
  return boundaries
    .sort((left, right) => {
      const distance = Math.abs(left - target) - Math.abs(right - target);
      return distance || right - left;
    })
    .slice(0, Math.max(1, limit))
    .map(boundary => tinymistPreviewByteColumn(lineText, boundary));
}

export function usesTemplateAwareStandaloneRoot(
  activePath: string,
  previewRootPath: string | null,
  standalone: boolean
): boolean {
  if (!standalone || !previewRootPath) return false;
  return filePathKey(activePath) !== filePathKey(previewRootPath)
    && /\.typsastra-preview\.typ$/i.test(previewRootPath.replace(/\\/g, "/"));
}

export function previewSessionIdentity(
  rootPath: string,
  style: PreviewRefreshStyle,
  document?: Pick<ResearchDocumentIdentity, "workspaceKey" | "mainKey">
): { key: string; taskId: string } {
  const owner = document
    ? `${document.workspaceKey}::${document.mainKey}`
    : filePathKey(rootPath);
  const key = `${owner}::${filePathKey(rootPath)}::${style}`;
  let hash = 0x811c9dc5;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return { key, taskId: `typsastra-preview-${(hash >>> 0).toString(16)}` };
}

export function tinymistPreviewArguments(
  path: string,
  taskId: string,
  refreshStyle: PreviewRefreshStyle,
  partialRendering = true
): string[] {
  const args = [
    "--task-id", taskId,
    "--not-primary",
    "--data-plane-host=127.0.0.1:0",
  ];
  if (partialRendering) args.push("--partial-rendering", "true");
  args.push("--refresh-style", refreshStyle, path);
  return args;
}

export function supportsResponsivePartialRendering(userAgent: string): boolean {
  // Tinymist viewport patches are currently expensive in WebKitGTK and cause
  // visible multi-second redraws while scrolling long documents.
  return !/Linux/i.test(userAgent);
}

export function sourceMapPreviewTaskId(taskId: string): string {
  return taskId.endsWith("-source-map") ? taskId : `${taskId}-source-map`;
}

export function staleSourceMapTaskIds(taskId: string, registeredTaskId: string | null): string[] {
  return [...new Set([registeredTaskId, taskId, sourceMapPreviewTaskId(taskId)]
    .filter((value): value is string => Boolean(value)))];
}
