export type DocumentScript = {
  id: string;
  label: string;
  unicodeProperty: string;
  iso15924: string;
  pattern: RegExp;
  preferredFamilies: readonly string[];
};

export type DocumentTypography = {
  baseSizePt: number;
  fonts: DocumentScriptFont[];
};

export type DocumentScriptFont = {
  script: string;
  family: string;
  scale: number;
  language: string | null;
};

export type TypographyEdit = { from: number; to: number; insert: string };
export type TypographyScaleChange = "unchanged" | "apply" | "confirm";

export const TYPOGRAPHY_FINE_ADJUSTMENT_MIN = 0.9;
export const TYPOGRAPHY_FINE_ADJUSTMENT_MAX = 1.1;

/** Font families embedded by the local Typst compiler rather than installed by the OS. */
export const TYPST_INTERNAL_FONT_FAMILIES = [
  "Libertinus Serif",
  "New Computer Modern",
  "New Computer Modern Math",
  "DejaVu Sans Mono",
] as const;

function sameFontFamily(left: string, right: string): boolean {
  return left.localeCompare(right, undefined, { sensitivity: "accent" }) === 0;
}

export function isTypstInternalOnlyFont(family: string, systemFamilies: readonly string[]): boolean {
  return TYPST_INTERNAL_FONT_FAMILIES.some(candidate => sameFontFamily(candidate, family))
    && !systemFamilies.some(candidate => sameFontFamily(candidate, family));
}

export function typographyScaleExceedsFineAdjustment(scale: number): boolean {
  return scale < TYPOGRAPHY_FINE_ADJUSTMENT_MIN - 0.0001
    || scale > TYPOGRAPHY_FINE_ADJUSTMENT_MAX + 0.0001;
}

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
  iso15924: "Latn",
  pattern: /\p{Script=Latin}/gu,
  preferredFamilies: ["Calibri", "MiSans Latin", "Noto Sans"]
};

export const documentScripts: readonly DocumentScript[] = [
  { id: "khmer", label: "Khmer", unicodeProperty: "Khmer", iso15924: "Khmr", pattern: /[\u1780-\u17ff\u19e0-\u19ff]/gu, preferredFamilies: ["MiSans Khmer", "Noto Sans Khmer"] },
  { id: "arabic", label: "Arabic", unicodeProperty: "Arabic", iso15924: "Arab", pattern: /[\u0600-\u06ff\u0750-\u077f\u08a0-\u08ff]/gu, preferredFamilies: ["MiSans Arabic", "Noto Sans Arabic"] },
  { id: "thai", label: "Thai", unicodeProperty: "Thai", iso15924: "Thai", pattern: /[\u0e00-\u0e7f]/gu, preferredFamilies: ["MiSans Thai", "Noto Sans Thai"] },
  { id: "lao", label: "Lao", unicodeProperty: "Lao", iso15924: "Laoo", pattern: /[\u0e80-\u0eff]/gu, preferredFamilies: ["MiSans Lao", "Noto Sans Lao"] },
  { id: "myanmar", label: "Myanmar", unicodeProperty: "Myanmar", iso15924: "Mymr", pattern: /[\u1000-\u109f\ua9e0-\ua9ff\uaa60-\uaa7f]/gu, preferredFamilies: ["MiSans Myanmar", "Noto Sans Myanmar"] },
  { id: "devanagari", label: "Devanagari", unicodeProperty: "Devanagari", iso15924: "Deva", pattern: /[\u0900-\u097f\ua8e0-\ua8ff]/gu, preferredFamilies: ["MiSans Devanagari", "Noto Sans Devanagari"] },
  { id: "bengali", label: "Bengali", unicodeProperty: "Bengali", iso15924: "Beng", pattern: /[\u0980-\u09ff]/gu, preferredFamilies: ["Noto Sans Bengali"] },
  { id: "gurmukhi", label: "Gurmukhi", unicodeProperty: "Gurmukhi", iso15924: "Guru", pattern: /[\u0a00-\u0a7f]/gu, preferredFamilies: ["MiSans Gurmukhi", "Noto Sans Gurmukhi"] },
  { id: "gujarati", label: "Gujarati", unicodeProperty: "Gujarati", iso15924: "Gujr", pattern: /[\u0a80-\u0aff]/gu, preferredFamilies: ["MiSans Gujarati", "Noto Sans Gujarati"] },
  { id: "tamil", label: "Tamil", unicodeProperty: "Tamil", iso15924: "Taml", pattern: /[\u0b80-\u0bff]/gu, preferredFamilies: ["Noto Sans Tamil"] },
  { id: "telugu", label: "Telugu", unicodeProperty: "Telugu", iso15924: "Telu", pattern: /[\u0c00-\u0c7f]/gu, preferredFamilies: ["Noto Sans Telugu"] },
  { id: "kannada", label: "Kannada", unicodeProperty: "Kannada", iso15924: "Knda", pattern: /[\u0c80-\u0cff]/gu, preferredFamilies: ["Noto Sans Kannada"] },
  { id: "malayalam", label: "Malayalam", unicodeProperty: "Malayalam", iso15924: "Mlym", pattern: /[\u0d00-\u0d7f]/gu, preferredFamilies: ["Noto Sans Malayalam"] },
  { id: "sinhala", label: "Sinhala", unicodeProperty: "Sinhala", iso15924: "Sinh", pattern: /[\u0d80-\u0dff]/gu, preferredFamilies: ["Noto Sans Sinhala"] },
  { id: "tibetan", label: "Tibetan", unicodeProperty: "Tibetan", iso15924: "Tibt", pattern: /[\u0f00-\u0fff]/gu, preferredFamilies: ["MiSans Tibetan", "Noto Sans Tibetan"] },
  { id: "hebrew", label: "Hebrew", unicodeProperty: "Hebrew", iso15924: "Hebr", pattern: /[\u0590-\u05ff]/gu, preferredFamilies: ["Noto Sans Hebrew"] },
  { id: "armenian", label: "Armenian", unicodeProperty: "Armenian", iso15924: "Armn", pattern: /[\u0530-\u058f]/gu, preferredFamilies: ["Noto Sans Armenian"] },
  { id: "georgian", label: "Georgian", unicodeProperty: "Georgian", iso15924: "Geor", pattern: /[\u10a0-\u10ff\u1c90-\u1cbf]/gu, preferredFamilies: ["Noto Sans Georgian"] },
  { id: "ethiopic", label: "Ethiopic", unicodeProperty: "Ethiopic", iso15924: "Ethi", pattern: /[\u1200-\u137f]/gu, preferredFamilies: ["Noto Sans Ethiopic"] },
  { id: "han", label: "Han", unicodeProperty: "Han", iso15924: "Hani", pattern: /[\u3400-\u4dbf\u4e00-\u9fff]/gu, preferredFamilies: ["Noto Sans SC", "Noto Sans CJK SC"] },
  { id: "hiragana", label: "Japanese", unicodeProperty: "Hiragana", iso15924: "Jpan", pattern: /[\u3040-\u30ff]/gu, preferredFamilies: ["Noto Sans JP"] },
  { id: "hangul", label: "Korean", unicodeProperty: "Hangul", iso15924: "Kore", pattern: /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/gu, preferredFamilies: ["Noto Sans KR"] }
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

function normalizeLanguageTag(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const [language, region, ...extra] = value.trim().replace(/_/g, "-").split("-");
  if (extra.length > 0 || !language || !/^[a-z]{2,3}$/i.test(language)) return null;
  if (region && !/^(?:[a-z]{2}|\d{3})$/i.test(region)) return null;
  return region
    ? `${language.toLowerCase()}-${/^\d{3}$/.test(region) ? region : region.toUpperCase()}`
    : language.toLowerCase();
}

export function renderTypographyBlock(config: DocumentTypography): string {
  const lines = [blockStart];
  const fonts = documentScriptMetadata(config.fonts);
  if (fonts.length > 0) {
    lines.push(`// typsastra:document-scripts ${JSON.stringify(fonts)}`);
  }
  if (fonts.length > 0) {
    const descriptors = fonts.map(font => {
      const script = typographyScripts.find(candidate => candidate.id === font.script)!;
      return `(name: "${escapeTypstString(font.family)}", covers: regex("\\p{scx=${script.unicodeProperty}}"))`;
    });
    lines.push(
      "#set text(",
      "  font: (",
      ...descriptors.map(descriptor => `    ${descriptor},`),
      "  ),",
      `  size: ${decimal(config.baseSizePt)}pt,`,
      ")"
    );
  }
  lines.push(blockEnd, "");
  return lines.join("\n");
}

function documentScriptMetadata(fonts: readonly DocumentScriptFont[]) {
  return fonts.map(font => ({
    family: font.family,
    script: font.script,
    scale: Math.max(0.5, Math.min(2, font.scale)),
    ...(font.language ? { language: font.language } : {})
  }));
}

export function documentScriptsEdit(text: string, fonts: readonly DocumentScriptFont[]): TypographyEdit {
  const directive = `// typsastra:document-scripts ${JSON.stringify(documentScriptMetadata(fonts))}`;
  const existing = /\/\/ typsastra:(?:document-scripts|script-fonts) \[[^\r\n]+\]/.exec(text);
  if (existing?.index !== undefined) {
    return { from: existing.index, to: existing.index + existing[0].length, insert: directive };
  }
  return { from: 0, to: 0, insert: `${directive}\n` };
}

export function parseDocumentScripts(text: string): DocumentScriptFont[] {
  const current = /\/\/ typsastra:document-scripts (\[[^\r\n]+\])/.exec(text);
  const legacy = /\/\/ typsastra:script-fonts (\[[^\r\n]+\])/.exec(text);
  const raw = current?.[1] ?? legacy?.[1];
  if (!raw) return [];
  const validScript = (script: unknown): script is string =>
    typeof script === "string" && typographyScripts.some(candidate => candidate.id === script);
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap(item => {
      if (!item || typeof item !== "object") return [];
      const candidate = item as Partial<DocumentScriptFont>;
      if (typeof candidate.family !== "string" || !validScript(candidate.script)) return [];
      const language = normalizeLanguageTag(candidate.language);
      return [{
        family: candidate.family,
        script: candidate.script,
        scale: typeof candidate.scale === "number" && Number.isFinite(candidate.scale)
          ? Math.max(0.5, Math.min(2, candidate.scale))
          : 1,
        language,
      }];
    });
  } catch {
    return [];
  }
}

export function parseTypographyBlock(text: string): DocumentTypography | null {
  const start = text.indexOf(blockStart);
  const end = start >= 0 ? text.indexOf(blockEnd, start) : -1;
  if (start < 0 || end < 0) return null;
  const block = text.slice(start, end);
  const documentScriptMetadata = /\/\/ typsastra:document-scripts (\[[^\r\n]+\])/.exec(block);
  const scriptFontMetadata = /\/\/ typsastra:script-fonts (\[[^\r\n]+\])/.exec(block);
  const roleMetadata = /\/\/ typsastra:font-roles (\{[^\r\n]+\})/.exec(block);
  const metadata = /\/\/ typsastra:font-fallbacks (\[[^\r\n]+\])/.exec(block);
  const legacyMetadata = /\/\/ typsastra:complex-font (\{[^\r\n]+\})/.exec(block);
  const validScript = (script: unknown): script is string =>
    typeof script === "string" && typographyScripts.some(candidate => candidate.id === script);
  const parseFonts = (value: unknown): DocumentScriptFont[] => !Array.isArray(value) ? [] : value.flatMap(item => {
    if (!item || typeof item !== "object") return [];
    const candidate = item as Partial<DocumentScriptFont>;
    if (typeof candidate.family !== "string" || !validScript(candidate.script)) return [];
    const language = normalizeLanguageTag(candidate.language);
    return [{
      family: candidate.family,
      script: candidate.script,
      scale: typeof candidate.scale === "number" && Number.isFinite(candidate.scale)
        ? Math.max(0.5, Math.min(2, candidate.scale))
        : 1,
      language
    }];
  });
  let fonts: DocumentScriptFont[] = [];
  try {
    if (documentScriptMetadata || scriptFontMetadata) {
      fonts = parseDocumentScripts(block);
    } else if (roleMetadata) {
      const roles = JSON.parse(roleMetadata[1]) as { primary?: unknown; embedded?: unknown };
      if (roles.primary && typeof roles.primary === "object") {
        const candidate = roles.primary as Partial<DocumentScriptFont>;
        if (typeof candidate.family === "string" && validScript(candidate.script)) {
          fonts.push({ family: candidate.family, script: candidate.script, scale: 1, language: null });
        }
      }
      fonts.push(...parseFonts(roles.embedded));
    } else {
      const raw: unknown = metadata ? JSON.parse(metadata[1]) : legacyMetadata ? [JSON.parse(legacyMetadata[1])] : [];
      fonts = parseFonts(raw);
    }
  } catch { return null; }
  const stack = block.match(/#set text\(font: \(([^\r\n]+)\), size: (-?\d+(?:\.\d+)?)pt\)/);
  const single = block.match(/#set text\(font: "((?:\\.|[^"])*)", size: (-?\d+(?:\.\d+)?)pt\)/);
  const legacyComplex = block.match(/#show regex\("\\p\{([^}]+)\}\+"\): set text\(font: "((?:\\.|[^"])*)", size: 1em ([+-]) (\d+(?:\.\d+)?)pt\)/);
  const managedTextRule = /#set text\(/.test(block);
  if (!managedTextRule && !legacyComplex) return null;
  const legacyScript = legacyComplex
    ? documentScripts.find(candidate => candidate.unicodeProperty === legacyComplex[1])
    : null;
  const size = /\bsize:\s*(-?\d+(?:\.\d+)?)pt/.exec(block);
  const baseSizePt = Number(size?.[1] ?? stack?.[2] ?? single?.[2] ?? 11);
  const stackFonts = stack
    ? [...stack[1].matchAll(/"((?:\\.|[^"])*)"/g)].map(match => unescapeTypstString(match[1]))
    : [];
  if (!documentScriptMetadata && !scriptFontMetadata && !roleMetadata && fonts.length > 0 && stackFonts[0]
    && !fonts.some(font => font.family === stackFonts[0])) {
    fonts.unshift({ family: stackFonts[0], script: "latin", scale: 1, language: null });
  }
  const legacyAdjustment = legacyComplex
    ? Number(legacyComplex[4]) * (legacyComplex[3] === "-" ? -1 : 1)
    : 0;
  if (fonts.length === 0 && legacyComplex && legacyScript) {
    const firstFont = stackFonts[0] ?? (single ? unescapeTypstString(single[1]) : null);
    if (firstFont) fonts.push({ family: firstFont, script: "latin", scale: 1, language: null });
    fonts.push({
      family: unescapeTypstString(legacyComplex[2]),
      script: legacyScript.id,
      scale: Math.max(0.5, Math.min(2, (baseSizePt + legacyAdjustment) / baseSizePt)),
      language: null
    });
  }
  if (fonts.length === 0) {
    const orderedFamilies = stackFonts.length > 0
      ? stackFonts
      : single ? [unescapeTypstString(single[1])] : [];
    fonts = orderedFamilies.map((family, index) => ({
      family,
      script: index === 0 ? "latin" : documentScripts[Math.min(index - 1, documentScripts.length - 1)].id,
      scale: 1,
      language: null
    }));
  }
  const uniqueFonts = fonts.filter((font, index) =>
    fonts.findIndex(candidate => candidate.script === font.script) === index
  );
  if (uniqueFonts.length === 0) return null;
  return { baseSizePt, fonts: uniqueFonts };
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
