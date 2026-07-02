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

export type AppSettings = {
  version: 1;
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
    showZws: boolean;
    userDictionary: string[];
  };
  preview: {
    cursorSync: boolean;
    syncDebounceMs: number;
    highlightDurationMs: number;
  };
  toolchain: {
    tinymistVersion: string | null;
  };
};

export const defaultAppSettings: AppSettings = {
  version: 1,
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
    showZws: true,
    userDictionary: []
  },
  preview: {
    cursorSync: true,
    syncDebounceMs: 120,
    highlightDurationMs: 2200
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
      showZws: booleanValue(editor.showZws, defaultAppSettings.editor.showZws),
      userDictionary: Array.isArray(editor.userDictionary)
        ? [...new Set(editor.userDictionary.filter((word): word is string => typeof word === "string" && word.trim().length > 0).map(word => word.trim()))].sort()
        : []
    },
    preview: {
      cursorSync: booleanValue(preview.cursorSync, defaultAppSettings.preview.cursorSync),
      syncDebounceMs: Math.round(boundedNumber(preview.syncDebounceMs, defaultAppSettings.preview.syncDebounceMs, 50, 2000)),
      highlightDurationMs: Math.round(boundedNumber(preview.highlightDurationMs, defaultAppSettings.preview.highlightDurationMs, 500, 10000))
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
