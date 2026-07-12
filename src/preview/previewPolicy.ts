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

export function allowsStandalonePreview(contents: string): boolean {
  const firstLine = contents.replace(/^\uFEFF/, "").split(/\r?\n/, 1)[0];
  return firstLine === "// @standalone-preview" || firstLine === "//@standalone-preview";
}

export function previewRefreshStyle(renderMode: PreviewRefreshStyle): PreviewRefreshStyle {
  return renderMode;
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
  return { key, taskId: `typstella-preview-${(hash >>> 0).toString(16)}` };
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
