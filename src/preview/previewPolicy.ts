import { filePathKey } from "../platform/paths";

export type PreviewTarget = {
  rootPath: string | null;
  mainPath: string | null;
  imported: boolean;
  standalone: boolean;
  disabled: boolean;
};

export type PreviewRefreshStyle = "on-type" | "on-save";

export function allowsStandalonePreview(contents: string): boolean {
  const firstLine = contents.replace(/^\uFEFF/, "").split(/\r?\n/, 1)[0];
  return firstLine === "// @standalone-preview" || firstLine === "//@standalone-preview";
}

export function previewRefreshStyle(renderMode: PreviewRefreshStyle): PreviewRefreshStyle {
  return renderMode;
}

export function previewSessionIdentity(rootPath: string, style: PreviewRefreshStyle): { key: string; taskId: string } {
  const key = `${filePathKey(rootPath)}::${style}`;
  let hash = 0x811c9dc5;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return { key, taskId: `typstry-preview-${(hash >>> 0).toString(16)}` };
}

export function tinymistPreviewArguments(
  path: string,
  taskId: string,
  refreshStyle: PreviewRefreshStyle
): string[] {
  return [
    "--task-id", taskId,
    "--not-primary",
    "--data-plane-host=127.0.0.1:0",
    "--partial-rendering", "true",
    "--refresh-style", refreshStyle,
    path
  ];
}
