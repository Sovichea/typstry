export const themeNames = [
  "default",
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

export type AppSettings = {
  version: 1;
  developerMode: boolean;
  appearance: {
    theme: ThemeName;
    editorFontSize: number;
    editorLineHeight: number;
  };
  editor: {
    codeFont: CodeEditorFontId;
    unicodeFont: UnicodeFontPreference;
    wordWrap: boolean;
    tabSize: 2 | 4 | 8;
    lineNumbers: boolean;
    highlightActiveLine: boolean;
    autoCloseBrackets: boolean;
    indentationGuides: boolean;
    spellcheck: boolean;
    wordCompletion: boolean;
    languageProviders: string[] | null;
    showZws: boolean;
    userDictionary: string[];
    ignoredWords: string[];
    formatOnSave: boolean;
  };
  preview: {
    renderMode: PreviewRenderMode;
    cursorSync: boolean;
    syncDebounceMs: number;
    highlightDurationMs: number;
    khmerRenderPreparation: boolean;
  };
  toolchain: {
    tinymistVersion: string | null;
  };
};

export const defaultAppSettings: AppSettings = {
  version: 1,
  developerMode: false,
  appearance: {
    theme: "default",
    editorFontSize: 14,
    editorLineHeight: 1.7
  },
  editor: {
    codeFont: "Fira Mono",
    unicodeFont: "auto",
    wordWrap: true,
    tabSize: 2,
    lineNumbers: true,
    highlightActiveLine: true,
    autoCloseBrackets: true,
    indentationGuides: true,
    spellcheck: true,
    wordCompletion: true,
    languageProviders: null,
    showZws: true,
    userDictionary: [],
    ignoredWords: [],
    formatOnSave: false
  },
  preview: {
    renderMode: "on-type",
    // TODO: Re-enable in prerelease v0.9.0 after improving performance and timeout reliability
    // cursorSync: true,
    cursorSync: false,
    syncDebounceMs: 120,
    highlightDurationMs: 2200,
    khmerRenderPreparation: false
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

function stringListOrNull(value: unknown): string[] | null {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value)) return null;
  return [...new Set(value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map(item => item.trim()))].sort();
}

function previewRenderMode(value: unknown): PreviewRenderMode {
  return value === "on-save" || value === "on-type"
    ? value
    : defaultAppSettings.preview.renderMode;
}

export function normalizeAppSettings(value: unknown): AppSettings {
  const root = objectValue(value);
  const appearance = objectValue(root.appearance);
  const editor = objectValue(root.editor);
  const preview = objectValue(root.preview);
  const toolchain = objectValue(root.toolchain);
  const theme = themeNames.includes(appearance.theme as ThemeName)
    ? appearance.theme as ThemeName
    : defaultAppSettings.appearance.theme;
  const tabSize = [2, 4, 8].includes(editor.tabSize as number)
    ? editor.tabSize as 2 | 4 | 8
    : defaultAppSettings.editor.tabSize;

  return {
    version: 1,
    developerMode: booleanValue(root.developerMode, defaultAppSettings.developerMode),
    appearance: {
      theme,
      editorFontSize: boundedNumber(appearance.editorFontSize, defaultAppSettings.appearance.editorFontSize, 10, 32),
      editorLineHeight: boundedNumber(appearance.editorLineHeight, defaultAppSettings.appearance.editorLineHeight, 1.2, 2.4)
    },
    editor: {
      codeFont: normalizeCodeEditorFont(editor.codeFont),
      unicodeFont: normalizeUnicodeFontPreference(editor.unicodeFont),
      wordWrap: booleanValue(editor.wordWrap, defaultAppSettings.editor.wordWrap),
      tabSize,
      lineNumbers: booleanValue(editor.lineNumbers, defaultAppSettings.editor.lineNumbers),
      highlightActiveLine: booleanValue(editor.highlightActiveLine, defaultAppSettings.editor.highlightActiveLine),
      autoCloseBrackets: booleanValue(editor.autoCloseBrackets, defaultAppSettings.editor.autoCloseBrackets),
      indentationGuides: booleanValue(editor.indentationGuides, defaultAppSettings.editor.indentationGuides),
      spellcheck: booleanValue(editor.spellcheck, defaultAppSettings.editor.spellcheck),
      wordCompletion: booleanValue(editor.wordCompletion, defaultAppSettings.editor.wordCompletion),
      languageProviders: stringListOrNull(editor.languageProviders),
      showZws: booleanValue(editor.showZws, defaultAppSettings.editor.showZws),
      userDictionary: Array.isArray(editor.userDictionary)
        ? [...new Set(editor.userDictionary.filter((word): word is string => typeof word === "string" && word.trim().length > 0).map(word => word.trim()))].sort()
        : [],
      ignoredWords: Array.isArray(editor.ignoredWords)
        ? [...new Set(editor.ignoredWords.filter((word): word is string => typeof word === "string" && word.trim().length > 0).map(word => word.trim()))].sort()
        : [],
      formatOnSave: booleanValue(editor.formatOnSave, defaultAppSettings.editor.formatOnSave)
    },
    preview: {
      renderMode: previewRenderMode(preview.renderMode),
      cursorSync: booleanValue(preview.cursorSync, defaultAppSettings.preview.cursorSync),
      syncDebounceMs: Math.round(boundedNumber(preview.syncDebounceMs, defaultAppSettings.preview.syncDebounceMs, 50, 2000)),
      highlightDurationMs: Math.round(boundedNumber(preview.highlightDurationMs, defaultAppSettings.preview.highlightDurationMs, 500, 10000)),
      khmerRenderPreparation: booleanValue(preview.khmerRenderPreparation, defaultAppSettings.preview.khmerRenderPreparation)
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
