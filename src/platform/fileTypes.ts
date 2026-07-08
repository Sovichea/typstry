const IMAGE_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "ico", "bmp", "avif"
]);

const TEXT_EXTENSIONS = new Set([
  "typ", "txt", "md", "markdown", "csv", "json", "yaml", "yml",
  "toml", "xml", "bib", "svg"
]);

export function fileExtension(path: string): string {
  const fileName = path.replace(/\\/g, "/").split("/").pop() ?? "";
  const dot = fileName.lastIndexOf(".");
  return dot > 0 && dot < fileName.length - 1
    ? fileName.slice(dot + 1).toLowerCase()
    : "";
}

export function isBinaryImagePath(path: string): boolean {
  return IMAGE_EXTENSIONS.has(fileExtension(path));
}

export function isSupportedInAppPath(path: string): boolean {
  const extension = fileExtension(path);
  return IMAGE_EXTENSIONS.has(extension) || TEXT_EXTENSIONS.has(extension);
}
