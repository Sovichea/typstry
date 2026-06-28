export const codeEditorFonts = [
  { id: "fira-mono", label: "Fira Mono", fontFamily: "Fira Mono", bundled: true },
  { id: "dejavu-sans-mono", label: "DejaVu Sans Mono", fontFamily: "DejaVu Sans Mono", bundled: true },
  { id: "system-monospace", label: "System Monospace", fontFamily: null, bundled: false }
] as const;

export type CodeEditorFontId = typeof codeEditorFonts[number]["id"];

export const unicodeEditorFonts = [
  {
    id: "mi-sans-khmer",
    label: "MiSans Khmer",
    language: "Khmer",
    fontFamily: "MiSans Khmer",
    pattern: /[\u1780-\u17FF\u19E0-\u19FF]/,
    bundled: true
  }
] as const;

export type UnicodeEditorFontId = typeof unicodeEditorFonts[number]["id"];
export type UnicodeFontPreference = "auto" | "none" | UnicodeEditorFontId;

export const unicodeFontPreferenceOptions: ReadonlyArray<{ id: UnicodeFontPreference; label: string }> = [
  { id: "auto", label: "Automatic (font detector)" },
  { id: "none", label: "No additional fallback" },
  ...unicodeEditorFonts.map(font => ({ id: font.id, label: `${font.label} (${font.language})` }))
];

export function normalizeCodeEditorFont(value: unknown): CodeEditorFontId {
  return codeEditorFonts.some(font => font.id === value) ? value as CodeEditorFontId : "fira-mono";
}

export function normalizeUnicodeFontPreference(value: unknown): UnicodeFontPreference {
  return unicodeFontPreferenceOptions.some(option => option.id === value) ? value as UnicodeFontPreference : "auto";
}

export function codeEditorFontStack(id: CodeEditorFontId, unicodeFamily?: string): string {
  const selected = codeEditorFonts.find(font => font.id === id) ?? codeEditorFonts[0];
  const families = [
    selected.fontFamily ? `"${selected.fontFamily}"` : null,
    unicodeFamily ? `"${unicodeFamily}"` : null,
    "ui-monospace",
    "SFMono-Regular",
    "Consolas",
    '"Liberation Mono"',
    "monospace"
  ];
  return [...new Set(families.filter((family): family is string => !!family))].join(", ");
}

export function detectUnicodeEditorFont(text: string) {
  return unicodeEditorFonts.find(font => font.pattern.test(text)) ?? null;
}
