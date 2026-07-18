export type DocumentScript = {
  id: string;
  label: string;
  unicodeProperty: string;
  pattern: RegExp;
  preferredFamilies: readonly string[];
};

export type DocumentTypography = {
  primary: DocumentPrimaryFont | null;
  baseSizePt: number;
  embedded: DocumentEmbeddedFont[];
};

export type DocumentPrimaryFont = {
  script: string;
  family: string;
};

export type DocumentEmbeddedFont = {
  script: string;
  family: string;
  scale: number;
};

export type TypographyEdit = { from: number; to: number; insert: string };
export type TypographyScaleChange = "unchanged" | "apply" | "confirm";

export function typographyScaleChange(previousScale: number, nextScale: number): TypographyScaleChange {
  if (Math.abs(previousScale - nextScale) <= 0.0001) return "unchanged";
  return Math.abs(nextScale - 1) <= 0.0001 ? "apply" : "confirm";
}

const blockStart = "// typsastra:typography:start";
const blockEnd = "// typsastra:typography:end";

export const latinDocumentScript: DocumentScript = {
  id: "latin",
  label: "Latin",
  unicodeProperty: "Latin",
  pattern: /\p{Script=Latin}/gu,
  preferredFamilies: ["Calibri", "MiSans Latin", "Noto Sans"]
};

export const documentScripts: readonly DocumentScript[] = [
  { id: "khmer", label: "Khmer", unicodeProperty: "Khmer", pattern: /[\u1780-\u17ff\u19e0-\u19ff]/gu, preferredFamilies: ["MiSans Khmer", "Noto Sans Khmer"] },
  { id: "arabic", label: "Arabic", unicodeProperty: "Arabic", pattern: /[\u0600-\u06ff\u0750-\u077f\u08a0-\u08ff]/gu, preferredFamilies: ["MiSans Arabic", "Noto Sans Arabic"] },
  { id: "thai", label: "Thai", unicodeProperty: "Thai", pattern: /[\u0e00-\u0e7f]/gu, preferredFamilies: ["MiSans Thai", "Noto Sans Thai"] },
  { id: "lao", label: "Lao", unicodeProperty: "Lao", pattern: /[\u0e80-\u0eff]/gu, preferredFamilies: ["MiSans Lao", "Noto Sans Lao"] },
  { id: "myanmar", label: "Myanmar", unicodeProperty: "Myanmar", pattern: /[\u1000-\u109f\ua9e0-\ua9ff\uaa60-\uaa7f]/gu, preferredFamilies: ["MiSans Myanmar", "Noto Sans Myanmar"] },
  { id: "devanagari", label: "Devanagari", unicodeProperty: "Devanagari", pattern: /[\u0900-\u097f\ua8e0-\ua8ff]/gu, preferredFamilies: ["MiSans Devanagari", "Noto Sans Devanagari"] },
  { id: "bengali", label: "Bengali", unicodeProperty: "Bengali", pattern: /[\u0980-\u09ff]/gu, preferredFamilies: ["Noto Sans Bengali"] },
  { id: "gurmukhi", label: "Gurmukhi", unicodeProperty: "Gurmukhi", pattern: /[\u0a00-\u0a7f]/gu, preferredFamilies: ["MiSans Gurmukhi", "Noto Sans Gurmukhi"] },
  { id: "gujarati", label: "Gujarati", unicodeProperty: "Gujarati", pattern: /[\u0a80-\u0aff]/gu, preferredFamilies: ["MiSans Gujarati", "Noto Sans Gujarati"] },
  { id: "tamil", label: "Tamil", unicodeProperty: "Tamil", pattern: /[\u0b80-\u0bff]/gu, preferredFamilies: ["Noto Sans Tamil"] },
  { id: "telugu", label: "Telugu", unicodeProperty: "Telugu", pattern: /[\u0c00-\u0c7f]/gu, preferredFamilies: ["Noto Sans Telugu"] },
  { id: "kannada", label: "Kannada", unicodeProperty: "Kannada", pattern: /[\u0c80-\u0cff]/gu, preferredFamilies: ["Noto Sans Kannada"] },
  { id: "malayalam", label: "Malayalam", unicodeProperty: "Malayalam", pattern: /[\u0d00-\u0d7f]/gu, preferredFamilies: ["Noto Sans Malayalam"] },
  { id: "sinhala", label: "Sinhala", unicodeProperty: "Sinhala", pattern: /[\u0d80-\u0dff]/gu, preferredFamilies: ["Noto Sans Sinhala"] },
  { id: "tibetan", label: "Tibetan", unicodeProperty: "Tibetan", pattern: /[\u0f00-\u0fff]/gu, preferredFamilies: ["MiSans Tibetan", "Noto Sans Tibetan"] },
  { id: "hebrew", label: "Hebrew", unicodeProperty: "Hebrew", pattern: /[\u0590-\u05ff]/gu, preferredFamilies: ["Noto Sans Hebrew"] },
  { id: "armenian", label: "Armenian", unicodeProperty: "Armenian", pattern: /[\u0530-\u058f]/gu, preferredFamilies: ["Noto Sans Armenian"] },
  { id: "georgian", label: "Georgian", unicodeProperty: "Georgian", pattern: /[\u10a0-\u10ff\u1c90-\u1cbf]/gu, preferredFamilies: ["Noto Sans Georgian"] },
  { id: "ethiopic", label: "Ethiopic", unicodeProperty: "Ethiopic", pattern: /[\u1200-\u137f]/gu, preferredFamilies: ["Noto Sans Ethiopic"] },
  { id: "han", label: "Han", unicodeProperty: "Han", pattern: /[\u3400-\u4dbf\u4e00-\u9fff]/gu, preferredFamilies: ["Noto Sans SC", "Noto Sans CJK SC"] },
  { id: "hiragana", label: "Japanese", unicodeProperty: "Hiragana", pattern: /[\u3040-\u30ff]/gu, preferredFamilies: ["Noto Sans JP"] },
  { id: "hangul", label: "Korean", unicodeProperty: "Hangul", pattern: /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/gu, preferredFamilies: ["Noto Sans KR"] }
];

export const typographyScripts: readonly DocumentScript[] = [latinDocumentScript, ...documentScripts];

function countMatches(text: string, pattern: RegExp): number {
  pattern.lastIndex = 0;
  return [...text.matchAll(pattern)].length;
}

export function detectDocumentScript(text: string): DocumentScript | null {
  return detectDocumentScripts(text)[0] ?? null;
}

export function detectDocumentScripts(text: string): DocumentScript[] {
  return documentScripts
    .map(script => ({ script, count: countMatches(text, script.pattern) }))
    .filter(candidate => candidate.count > 0)
    .sort((left, right) => right.count - left.count)
    .map(candidate => candidate.script);
}

export function detectTypographyScripts(text: string): DocumentScript[] {
  return typographyScripts
    .map(script => ({ script, count: countMatches(text, script.pattern) }))
    .filter(candidate => candidate.count > 0)
    .sort((left, right) => right.count - left.count)
    .map(candidate => candidate.script);
}

export function preferredInstalledFamily(script: DocumentScript, families: readonly string[]): string | null {
  for (const preferred of script.preferredFamilies) {
    const match = families.find(family => family.localeCompare(preferred, undefined, { sensitivity: "accent" }) === 0);
    if (match) return match;
  }
  return null;
}

function escapeTypstString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function unescapeTypstString(value: string): string {
  return value.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}

function decimal(value: number): string {
  return Number(value.toFixed(2)).toString();
}

export function renderTypographyBlock(config: DocumentTypography): string {
  const lines = [blockStart];
  const primary = config.primary ? {
    family: config.primary.family,
    script: config.primary.script
  } : null;
  const embedded = config.embedded.map(font => ({
    family: font.family,
    script: font.script,
    scale: Math.max(0.5, Math.min(2, font.scale))
  }));
  if (primary || embedded.length > 0) {
    lines.push(`// typsastra:font-roles ${JSON.stringify({ primary, embedded })}`);
  }
  const fonts = [...new Set([primary?.family, ...embedded.map(font => font.family)]
    .filter((font): font is string => !!font))];
  if (fonts.length > 0) {
    const fontValue = fonts.length === 1
      ? `"${escapeTypstString(fonts[0])}"`
      : `(${fonts.map(font => `"${escapeTypstString(font)}"`).join(", ")})`;
    lines.push(`#set text(font: ${fontValue}, size: ${decimal(config.baseSizePt)}pt)`);
  }
  lines.push(blockEnd, "");
  return lines.join("\n");
}

export function parseTypographyBlock(text: string): DocumentTypography | null {
  const start = text.indexOf(blockStart);
  const end = start >= 0 ? text.indexOf(blockEnd, start) : -1;
  if (start < 0 || end < 0) return null;
  const block = text.slice(start, end);
  const roleMetadata = /\/\/ typsastra:font-roles (\{[^\r\n]+\})/.exec(block);
  const metadata = /\/\/ typsastra:font-fallbacks (\[[^\r\n]+\])/.exec(block);
  const legacyMetadata = /\/\/ typsastra:complex-font (\{[^\r\n]+\})/.exec(block);
  const validScript = (script: unknown): script is string =>
    typeof script === "string" && typographyScripts.some(candidate => candidate.id === script);
  const parseEmbedded = (value: unknown): DocumentEmbeddedFont[] => !Array.isArray(value) ? [] : value.flatMap(item => {
    if (!item || typeof item !== "object") return [];
    const candidate = item as Partial<DocumentEmbeddedFont>;
    if (typeof candidate.family !== "string" || !validScript(candidate.script)) return [];
    return [{
      family: candidate.family,
      script: candidate.script,
      scale: typeof candidate.scale === "number" && Number.isFinite(candidate.scale)
        ? Math.max(0.5, Math.min(2, candidate.scale))
        : 1
    }];
  });
  let explicitPrimary: DocumentPrimaryFont | null | undefined;
  let fallbacks: DocumentEmbeddedFont[] = [];
  try {
    if (roleMetadata) {
      const roles = JSON.parse(roleMetadata[1]) as { primary?: unknown; embedded?: unknown };
      if (roles.primary === null) explicitPrimary = null;
      else if (roles.primary && typeof roles.primary === "object") {
        const candidate = roles.primary as Partial<DocumentPrimaryFont>;
        explicitPrimary = typeof candidate.family === "string" && validScript(candidate.script)
          ? { family: candidate.family, script: candidate.script }
          : null;
      }
      fallbacks = parseEmbedded(roles.embedded);
    } else {
      const raw: unknown = metadata ? JSON.parse(metadata[1]) : legacyMetadata ? [JSON.parse(legacyMetadata[1])] : [];
      fallbacks = parseEmbedded(raw);
    }
  } catch { return null; }
  const stack = block.match(/#set text\(font: \(([^\r\n]+)\), size: (-?\d+(?:\.\d+)?)pt\)/);
  const single = block.match(/#set text\(font: "((?:\\.|[^"])*)", size: (-?\d+(?:\.\d+)?)pt\)/);
  const legacyComplex = block.match(/#show regex\("\\p\{([^}]+)\}\+"\): set text\(font: "((?:\\.|[^"])*)", size: 1em ([+-]) (\d+(?:\.\d+)?)pt\)/);
  if (!stack && !single && !legacyComplex) return null;
  const legacyScript = legacyComplex
    ? documentScripts.find(candidate => candidate.unicodeProperty === legacyComplex[1])
    : null;
  const baseSizePt = Number(stack?.[2] ?? single?.[2] ?? 11);
  const stackFonts = stack
    ? [...stack[1].matchAll(/"((?:\\.|[^"])*)"/g)].map(match => unescapeTypstString(match[1]))
    : [];
  const legacyAdjustment = legacyComplex
    ? Number(legacyComplex[4]) * (legacyComplex[3] === "-" ? -1 : 1)
    : 0;
  if (fallbacks.length === 0 && legacyComplex && legacyScript) {
    fallbacks = [{
      family: unescapeTypstString(legacyComplex[2]),
      script: legacyScript.id,
      scale: Math.max(0.5, Math.min(2, (baseSizePt + legacyAdjustment) / baseSizePt))
    }];
  }
  if (fallbacks.length === 0 && stackFonts.length > 1) {
    fallbacks = [{ family: stackFonts[1], script: documentScripts[0].id, scale: 1 }];
  }
  const firstFont = stackFonts[0] ?? (single ? unescapeTypstString(single[1]) : null);
  let primary = explicitPrimary;
  if (primary === undefined && firstFont) {
    const matchingFallback = fallbacks.find(font => font.family === firstFont);
    primary = matchingFallback
      ? { script: matchingFallback.script, family: firstFont }
      : { script: "latin", family: firstFont };
    if (matchingFallback) fallbacks = fallbacks.filter(font => font !== matchingFallback);
  }
  if (primary === undefined) primary = null;
  const embedded = fallbacks.filter(font => font.script !== primary?.script);
  if (!primary && embedded.length === 0) return null;
  return { primary, baseSizePt, embedded };
}

export function typographyEdit(text: string, config: DocumentTypography): TypographyEdit {
  const insert = renderTypographyBlock(config);
  const start = text.indexOf(blockStart);
  if (start >= 0) {
    const endMarker = text.indexOf(blockEnd, start);
    if (endMarker >= 0) {
      let to = endMarker + blockEnd.length;
      if (text.slice(to, to + 2) === "\r\n") to += 2;
      else if (text[to] === "\n") to += 1;
      return { from: start, to, insert };
    }
  }

  const bomOffset = text.startsWith("\uFEFF") ? 1 : 0;
  const from = bomOffset;
  return { from, to: from, insert };
}
