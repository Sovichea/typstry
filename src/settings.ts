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
  };
  preview: {
    cursorSync: boolean;
    syncDebounceMs: number;
    highlightDurationMs: number;
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
    codeFont: "fira-mono",
    unicodeFont: "auto",
    wordWrap: true,
    tabSize: 2,
    lineNumbers: true,
    highlightActiveLine: true,
    autoCloseBrackets: true,
    indentationGuides: true
  },
  preview: {
    cursorSync: true,
    syncDebounceMs: 120,
    highlightDurationMs: 2200
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
      indentationGuides: booleanValue(editor.indentationGuides, defaultAppSettings.editor.indentationGuides)
    },
    preview: {
      cursorSync: booleanValue(preview.cursorSync, defaultAppSettings.preview.cursorSync),
      syncDebounceMs: Math.round(boundedNumber(preview.syncDebounceMs, defaultAppSettings.preview.syncDebounceMs, 50, 2000)),
      highlightDurationMs: Math.round(boundedNumber(preview.highlightDurationMs, defaultAppSettings.preview.highlightDurationMs, 500, 10000))
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
