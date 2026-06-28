function encodePath(path: string): string {
  return path
    .split("/")
    .map((part, index) => index === 0 && /^[A-Za-z]:$/.test(part) ? part : encodeURIComponent(part))
    .join("/");
}

export function filePathToUri(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const uncMatch = normalized.match(/^\/\/([^/]+)(\/.*)?$/);
  if (uncMatch) {
    return `file://${uncMatch[1]}${encodePath(uncMatch[2] ?? "/")}`;
  }
  if (/^[A-Za-z]:\//.test(normalized)) {
    return `file:///${encodePath(normalized)}`;
  }
  if (normalized.startsWith("/")) {
    return `file://${encodePath(normalized)}`;
  }
  return `file:///${encodePath(normalized)}`;
}

export function filePathFromUri(uri: string): string {
  if (!uri.startsWith("file://")) return uri;

  const parsed = new URL(uri);
  const pathname = decodeURIComponent(parsed.pathname);
  if (parsed.hostname) {
    return `//${parsed.hostname}${pathname}`;
  }
  return /^\/[A-Za-z]:\//.test(pathname) ? pathname.slice(1) : pathname;
}

export function filePathKey(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/$/, "");
  const isWindowsPath = /^[A-Za-z]:\//.test(normalized) || normalized.startsWith("//");
  return isWindowsPath ? normalized.toLowerCase() : normalized;
}

export function fileNameFromPath(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || path;
}
