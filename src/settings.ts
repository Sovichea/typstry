export const themeNames = [
  "default",
  "typsastraLight",
  "typsastraDark",
  "githubLight",
  "githubDark",
  "oneDark",
  "dracula",
  "material",
  "materialLight",
  "nord"
] as const;

export type ThemeName = typeof themeNames[number];
export type PreviewRenderMode = "on-type" | "on-save";
export type DeveloperLogCategory =
  | "preview"
  | "inverseSync"
  | "forwardSync"
  | "performance"
  | "memory"
  | "lsp"
  | "spellcheck"
  | "general";

export type DeveloperLogSettings = Record<DeveloperLogCategory, boolean>;
export type TerminologyEntry = { term: string; exactCase: boolean };
export type LanguageTerminologyEntry = TerminologyEntry & { languageFamily: string };
export type ScopedIgnoredWord = { term: string; scope: "global" | "project" | "languageFamily"; languageFamily?: string };

export type AppSettings = {
  version: 2;
  developerMode: boolean;
  developerLogs: DeveloperLogSettings;
  appearance: {
    theme: ThemeName;
    editorFontSize: number;
    editorLineHeight: number;
  };
  editor: {
    codeFont: CodeEditorFontId;
    unicodeFont: UnicodeFontPreference;
    unicodeFonts: Record<string, UnicodeFontPreference>;
    wordWrap: boolean;
    tabSize: 2 | 4 | 8;
    lineNumbers: boolean;
    highlightActiveLine: boolean;
    autoCloseBrackets: boolean;
    indentationGuides: boolean;
    spellcheck: boolean;
    wordCompletion: boolean;
    showZws: boolean;
    userDictionary: string[];
    ignoredWords: string[];
    globalTerminology: TerminologyEntry[];
    languageTerminology: LanguageTerminologyEntry[];
    scopedIgnoredWords: ScopedIgnoredWord[];
    formatOnSave: boolean;
  };
  preview: {
    renderMode: PreviewRenderMode;
    cursorSync: boolean;
    syncDebounceMs: number;
    highlightDurationMs: number;
    khmerRenderPreparation: boolean;
  };
  compatibility: {
    disableWebkitDmabufRenderer: boolean;
  };
  toolchain: {
    tinymistVersion: string | null;
  };
};

export const defaultAppSettings: AppSettings = {
  version: 2,
  developerMode: false,
  developerLogs: {
    preview: true,
    inverseSync: true,
    forwardSync: true,
    performance: true,
    memory: true,
    lsp: true,
    spellcheck: true,
    general: true
  },
  appearance: {
    theme: "default",
    editorFontSize: 14,
    editorLineHeight: 1.7
  },
  editor: {
    codeFont: "Fira Mono",
    unicodeFont: "auto",
    unicodeFonts: {},
    wordWrap: true,
    tabSize: 2,
    lineNumbers: true,
    highlightActiveLine: true,
    autoCloseBrackets: true,
    indentationGuides: true,
    spellcheck: true,
    wordCompletion: true,
    showZws: true,
    userDictionary: [],
    ignoredWords: [],
    globalTerminology: [],
    languageTerminology: [],
    scopedIgnoredWords: [],
    formatOnSave: false
  },
  preview: {
    renderMode: "on-save",
    // TODO: Re-enable in prerelease v0.9.0 after improving performance and timeout reliability
    // cursorSync: true,
    cursorSync: false,
    syncDebounceMs: 500,
    highlightDurationMs: 2200,
    khmerRenderPreparation: false
  },
  compatibility: {
    disableWebkitDmabufRenderer: false
  },
  toolchain: {
    tinymistVersion: null
  }
};

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function previewRenderMode(value: unknown): PreviewRenderMode {
  return value === "on-type" ? "on-type" : "on-save";
}

function terminologyEntries(value: unknown, limit = 2_000): TerminologyEntry[] {
  if (!Array.isArray(value)) return [];
  const entries = new Map<string, TerminologyEntry>();
  for (const item of value.slice(0, limit)) {
    const record = objectValue(item);
    const term = typeof record.term === "string" ? record.term.trim() : "";
    if (!term || term.length > 128 || /[\r\n\0]/.test(term)) continue;
    const exactCase = record.exactCase !== false;
    entries.set(`${exactCase ? "exact" : "fold"}:${term}`, { term, exactCase });
  }
  return [...entries.values()];
}

function languageTerminologyEntries(value: unknown): LanguageTerminologyEntry[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 2_000).flatMap((item) => {
    const record = objectValue(item);
    const term = terminologyEntries([record], 1)[0];
    const languageFamily = typeof record.languageFamily === "string"
      && /^[a-z]{2,3}$/i.test(record.languageFamily)
      ? record.languageFamily.toLowerCase()
      : null;
    return term && languageFamily ? [{ ...term, languageFamily }] : [];
  });
}

function scopedIgnoredEntries(value: unknown): ScopedIgnoredWord[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 2_000).flatMap((item) => {
    const record = objectValue(item);
    const term = typeof record.term === "string" ? record.term.trim() : "";
    const scope = record.scope;
    if (!term || term.length > 128 || /[\r\n\0]/.test(term)
      || (scope !== "global" && scope !== "project" && scope !== "languageFamily")) return [];
    const languageFamily = scope === "languageFamily" && typeof record.languageFamily === "string"
      && /^[a-z]{2,3}$/i.test(record.languageFamily)
      ? record.languageFamily.toLowerCase()
      : undefined;
    if (scope === "languageFamily" && !languageFamily) return [];
    return [{ term, scope, languageFamily }];
  });
}

function unicodeFontPreferences(value: unknown): Record<string, UnicodeFontPreference> {
  const preferences = objectValue(value);
  return Object.fromEntries(Object.entries(preferences)
    .filter(([id]) => /^[a-z0-9-]+$/.test(id))
    .map(([id, preference]) => [id, normalizeUnicodeFontPreference(preference)]));
}

export function normalizeAppSettings(value: unknown): AppSettings {
  const root = objectValue(value);
  const appearance = objectValue(root.appearance);
  const editor = objectValue(root.editor);
  const preview = objectValue(root.preview);
  const compatibility = objectValue(root.compatibility);
  const developerLogs = objectValue(root.developerLogs);
  const toolchain = objectValue(root.toolchain);
  const theme = themeNames.includes(appearance.theme as ThemeName)
    ? appearance.theme as ThemeName
    : defaultAppSettings.appearance.theme;
  const tabSize = [2, 4, 8].includes(editor.tabSize as number)
    ? editor.tabSize as 2 | 4 | 8
    : defaultAppSettings.editor.tabSize;

  return {
    version: 2,
    developerMode: booleanValue(root.developerMode, defaultAppSettings.developerMode),
    developerLogs: {
      preview: booleanValue(developerLogs.preview, defaultAppSettings.developerLogs.preview),
      inverseSync: booleanValue(developerLogs.inverseSync, defaultAppSettings.developerLogs.inverseSync),
      forwardSync: booleanValue(developerLogs.forwardSync, defaultAppSettings.developerLogs.forwardSync),
      performance: booleanValue(developerLogs.performance, defaultAppSettings.developerLogs.performance),
      memory: booleanValue(developerLogs.memory, defaultAppSettings.developerLogs.memory),
      lsp: booleanValue(developerLogs.lsp, defaultAppSettings.developerLogs.lsp),
      spellcheck: booleanValue(developerLogs.spellcheck, defaultAppSettings.developerLogs.spellcheck),
      general: booleanValue(developerLogs.general, defaultAppSettings.developerLogs.general)
    },
    appearance: {
      theme,
      editorFontSize: boundedNumber(appearance.editorFontSize, defaultAppSettings.appearance.editorFontSize, 10, 32),
      editorLineHeight: boundedNumber(appearance.editorLineHeight, defaultAppSettings.appearance.editorLineHeight, 1.2, 2.4)
    },
    editor: {
      codeFont: normalizeCodeEditorFont(editor.codeFont),
      unicodeFont: normalizeUnicodeFontPreference(editor.unicodeFont),
      unicodeFonts: unicodeFontPreferences(editor.unicodeFonts),
      wordWrap: booleanValue(editor.wordWrap, defaultAppSettings.editor.wordWrap),
      tabSize,
      lineNumbers: booleanValue(editor.lineNumbers, defaultAppSettings.editor.lineNumbers),
      highlightActiveLine: booleanValue(editor.highlightActiveLine, defaultAppSettings.editor.highlightActiveLine),
      autoCloseBrackets: booleanValue(editor.autoCloseBrackets, defaultAppSettings.editor.autoCloseBrackets),
      indentationGuides: booleanValue(editor.indentationGuides, defaultAppSettings.editor.indentationGuides),
      spellcheck: booleanValue(editor.spellcheck, defaultAppSettings.editor.spellcheck),
      wordCompletion: booleanValue(editor.wordCompletion, defaultAppSettings.editor.wordCompletion),
      showZws: booleanValue(editor.showZws, defaultAppSettings.editor.showZws),
      userDictionary: Array.isArray(editor.userDictionary)
        ? [...new Set(editor.userDictionary.filter((word): word is string => typeof word === "string" && word.trim().length > 0).map(word => word.trim()))].sort()
        : [],
      ignoredWords: Array.isArray(editor.ignoredWords)
        ? [...new Set(editor.ignoredWords.filter((word): word is string => typeof word === "string" && word.trim().length > 0).map(word => word.trim()))].sort()
        : [],
      globalTerminology: terminologyEntries(editor.globalTerminology),
      languageTerminology: languageTerminologyEntries(editor.languageTerminology),
      scopedIgnoredWords: scopedIgnoredEntries(editor.scopedIgnoredWords),
      formatOnSave: booleanValue(editor.formatOnSave, defaultAppSettings.editor.formatOnSave)
    },
    preview: {
      renderMode: previewRenderMode(preview.renderMode),
      cursorSync: booleanValue(preview.cursorSync, defaultAppSettings.preview.cursorSync),
      syncDebounceMs: Math.round(boundedNumber(preview.syncDebounceMs, defaultAppSettings.preview.syncDebounceMs, 50, 2000)),
      highlightDurationMs: Math.round(boundedNumber(preview.highlightDurationMs, defaultAppSettings.preview.highlightDurationMs, 500, 10000)),
      khmerRenderPreparation: booleanValue(preview.khmerRenderPreparation, defaultAppSettings.preview.khmerRenderPreparation)
    },
    compatibility: {
      disableWebkitDmabufRenderer: booleanValue(
        compatibility.disableWebkitDmabufRenderer,
        defaultAppSettings.compatibility.disableWebkitDmabufRenderer
      )
    },
    toolchain: {
      tinymistVersion: typeof toolchain.tinymistVersion === "string" && /^\d+\.\d+\.\d+$/.test(toolchain.tinymistVersion)
        ? toolchain.tinymistVersion
        : typeof toolchain.typstVersion === "string" && /^\d+\.\d+\.\d+$/.test(toolchain.typstVersion)
          ? toolchain.typstVersion
        : null
    }
  };
}

export function cloneDefaultAppSettings(): AppSettings {
  return normalizeAppSettings(defaultAppSettings);
}
import {
  normalizeCodeEditorFont,
  normalizeUnicodeFontPreference,
  type CodeEditorFontId,
  type UnicodeFontPreference
} from "./editor/fontCatalog";
