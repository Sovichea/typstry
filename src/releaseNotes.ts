export type ReleaseSummary = {
  version: string;
  title: string;
  highlights: readonly string[];
  detailsUrl: string;
};

const releaseSummaries: Record<string, ReleaseSummary> = {
  "0.5.1": {
    version: "0.5.1",
    title: "Examples, multilingual tools, and safer typography",
    highlights: [
      "A versioned, guided examples workspace with task-oriented tutorials.",
      "Script-specific font assignments with drag ordering, Unicode coverage, and independent fine scaling.",
      "Deterministic document-script spellcheck and word completion.",
      "A private global scaled-font cache that is reused across projects and never exported."
    ],
    detailsUrl: "https://github.com/Sovichea/typsastra/releases/tag/v0.5.1"
  }
};

export function releaseSummaryForVersion(version: string): ReleaseSummary | null {
  return releaseSummaries[version] ?? null;
}

export function shouldShowReleaseSummary(version: string, lastSeenVersion: string | null): boolean {
  return releaseSummaryForVersion(version) !== null && lastSeenVersion !== version;
}
