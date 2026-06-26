import { Extension, Compartment, type EditorState } from "@codemirror/state";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { lineNumbers, highlightActiveLineGutter, highlightActiveLine, drawSelection, dropCursor, keymap, EditorView } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { search, searchKeymap } from "@codemirror/search";
import { baseEditorLayoutTheme, editorFontTheme, typstColorHighlighting, typstFontHighlighting, typstFunctionHighlighting } from "./themes";
import { codeFolding, foldGutter, foldKeymap, foldService, syntaxHighlighting } from "@codemirror/language";
import { typstLanguage } from "./typstLanguage";
import { editorDiagnosticsExtension } from "./diagnostics";
import { indentationMarkers } from '@replit/codemirror-indentation-markers';

import * as uiwThemes from "@uiw/codemirror-themes-all";
import { oneDark } from "@codemirror/theme-one-dark";
import { createTypstAutocomplete } from "./autocomplete";
import { completionKeymap, closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { bracketMatching } from "@codemirror/language";
import { toggleLineComment } from "@codemirror/commands";
import { bracketColorizer } from "./bracketColorizer";
import { createHoverTooltip } from "./hover";
import type { TinymistLspClient } from "../compiler/lsp";
import { typstFunctionFoldService } from "./folding";

export const themeCompartment = new Compartment();
export const wrapCompartment = new Compartment();
export const editorFontCompartment = new Compartment();

function foldedTypstPlaceholderSuffix(state: EditorState, range: { from: number; to: number }): string {
  const foldedText = state.doc.sliceString(range.from, range.to).trimEnd();
  const lastChar = foldedText[foldedText.length - 1] ?? "";
  return /[)\]}]/.test(lastChar) ? lastChar : "";
}

function foldedTypstPlaceholderDOM(_view: EditorView, onclick: (event: Event) => void, suffix: string | null): HTMLElement {
  const placeholder = document.createElement("span");
  placeholder.className = "cm-foldPlaceholder";
  placeholder.textContent = ` ... ${suffix ?? ""}`;
  placeholder.addEventListener("click", onclick);
  return placeholder;
}

const preventEscapedBracketAutoClose = EditorView.inputHandler.of((view, from, to, text) => {
  const bracketsToPrevent = ["$", "(", "[", "{", '"', "'", "*", "_"];
  if (bracketsToPrevent.includes(text)) {
    if (from > 0 && view.state.doc.sliceString(from - 1, from) === "\\") {
      view.dispatch({
        changes: { from, to, insert: text },
        selection: { anchor: from + text.length },
        userEvent: "input.type"
      });
      return true;
    }
  }
  return false;
});

export function getEditorExtensions(getClient: () => TinymistLspClient | undefined, getUri: () => string, flushLspSync: () => void): Extension[] {
  return [
    preventEscapedBracketAutoClose,
    foldService.of(typstFunctionFoldService),
    lineNumbers(),
    foldGutter({
      openText: "v",
      closedText: ">"
    }),
    highlightActiveLineGutter(), highlightActiveLine(),
    drawSelection(), dropCursor(), history(), 
    typstLanguage,
    baseEditorLayoutTheme,
    codeFolding({
      preparePlaceholder: foldedTypstPlaceholderSuffix,
      placeholderDOM: foldedTypstPlaceholderDOM
    }),
    editorDiagnosticsExtension,
    indentationMarkers(),
    wrapCompartment.of(EditorView.lineWrapping),
    search({ top: true }),
    closeBrackets(),
    bracketMatching(),
    bracketColorizer,
    createHoverTooltip(getClient, getUri),
    createTypstAutocomplete(getClient, getUri, flushLspSync),
    themeCompartment.of(getThemeExtension("default")),
    editorFontCompartment.of(editorFontTheme()),
    keymap.of([
      { key: "Mod-/", run: toggleLineComment },
      indentWithTab, 
      ...closeBracketsKeymap, 
      ...defaultKeymap, 
      ...historyKeymap, 
      ...searchKeymap, 
      ...foldKeymap,
      ...completionKeymap
    ])
  ];
}

export function getThemeExtension(themeName: string): Extension {
    const baseExtensions = [];
    
    switch (themeName) {
        case "githubLight": baseExtensions.push(uiwThemes.githubLight); break;
        case "githubDark": baseExtensions.push(uiwThemes.githubDark); break;
        case "dracula": baseExtensions.push(uiwThemes.dracula); break;
        case "material": baseExtensions.push(uiwThemes.materialDark); break;
        case "materialLight": baseExtensions.push(uiwThemes.materialLight); break;
        case "nord": baseExtensions.push(uiwThemes.nord); break;
        case "oneDark": baseExtensions.push(oneDark); break;
        case "default":
        default:
            baseExtensions.push(syntaxHighlighting(typstColorHighlighting));
            break;
    }
    
    baseExtensions.push(syntaxHighlighting(typstFontHighlighting));
    baseExtensions.push(syntaxHighlighting(typstFunctionHighlighting));
    return baseExtensions;
}

type ThemeColorVariables = {
  bg: string;
  text: string;
  border: string;
  hover: string;
  select: string;
  header: string;
  mode: "dark" | "light";
  monospace: string;
  cursor: string;
  cursorContrast: string;
  cursorShadow: string;
  cursorGlow: string;
  cursorContrastShadow: string;
  cursorContrastGlow: string;
  selection: string;
  selectionFocus: string;
  selectionOutline: string;
  bracketMatchOutline: string;
  bracketMismatchBg: string;
  brackets: [string, string, string, string, string];
  functionColor: string;
};

const lightEditorVisibility = {
  cursor: "#005cc5",
  cursorContrast: "#d73a49",
  cursorShadow: "rgba(255, 255, 255, 0.95)",
  cursorGlow: "rgba(0, 92, 197, 0.45)",
  cursorContrastShadow: "rgba(255, 255, 255, 0.95)",
  cursorContrastGlow: "rgba(215, 58, 73, 0.35)",
  selection: "rgba(3, 102, 214, 0.22)",
  selectionFocus: "rgba(3, 102, 214, 0.3)",
  selectionOutline: "rgba(3, 102, 214, 0.32)",
  bracketMatchOutline: "#005cc5",
  bracketMismatchBg: "rgba(215, 58, 73, 0.16)",
  brackets: ["#005cc5", "#6f42c1", "#22863a", "#d73a49", "#b31d28"],
  functionColor: "#0f766e"
} satisfies Pick<ThemeColorVariables, "cursor" | "cursorContrast" | "cursorShadow" | "cursorGlow" | "cursorContrastShadow" | "cursorContrastGlow" | "selection" | "selectionFocus" | "selectionOutline" | "bracketMatchOutline" | "bracketMismatchBg" | "brackets" | "functionColor">;

const darkEditorVisibility = {
  cursor: "#79c0ff",
  cursorContrast: "#ff7b72",
  cursorShadow: "rgba(0, 0, 0, 0.95)",
  cursorGlow: "rgba(121, 192, 255, 0.75)",
  cursorContrastShadow: "rgba(0, 0, 0, 0.95)",
  cursorContrastGlow: "rgba(255, 123, 114, 0.65)",
  selection: "rgba(56, 139, 253, 0.28)",
  selectionFocus: "rgba(56, 139, 253, 0.36)",
  selectionOutline: "rgba(121, 192, 255, 0.42)",
  bracketMatchOutline: "#79c0ff",
  bracketMismatchBg: "rgba(255, 123, 114, 0.22)",
  brackets: ["#79c0ff", "#d2a8ff", "#7ee787", "#ffa657", "#ff7b72"],
  functionColor: "#d2a8ff"
} satisfies Pick<ThemeColorVariables, "cursor" | "cursorContrast" | "cursorShadow" | "cursorGlow" | "cursorContrastShadow" | "cursorContrastGlow" | "selection" | "selectionFocus" | "selectionOutline" | "bracketMatchOutline" | "bracketMismatchBg" | "brackets" | "functionColor">;

const themeColors: Record<string, ThemeColorVariables> = {
  default: { bg: "#fcfcfc", text: "#333333", border: "#e0e0e0", hover: "#e4e6f1", select: "#d7e8f5", header: "#616161", mode: "light", monospace: "#0f766e", ...lightEditorVisibility },
  githubLight: { bg: "#ffffff", text: "#24292f", border: "#d0d7de", hover: "#f3f4f6", select: "#ddf4ff", header: "#57606a", mode: "light", monospace: "#0550ae", ...lightEditorVisibility, functionColor: "#8250df" },
  githubDark: { bg: "#0d1117", text: "#c9d1d9", border: "#30363d", hover: "#161b22", select: "#21262d", header: "#8b949e", mode: "dark", monospace: "#a5d6ff", ...darkEditorVisibility },
  dracula: {
    bg: "#282a36", text: "#f8f8f2", border: "#44475a", hover: "#44475a", select: "#6272a4", header: "#6272a4", mode: "dark", monospace: "#8be9fd",
    ...darkEditorVisibility,
    cursor: "#8be9fd",
    cursorContrast: "#ff79c6",
    cursorGlow: "rgba(139, 233, 253, 0.75)",
    cursorContrastGlow: "rgba(255, 121, 198, 0.7)",
    bracketMatchOutline: "#8be9fd",
    bracketMismatchBg: "rgba(255, 85, 85, 0.22)",
    brackets: ["#8be9fd", "#ff79c6", "#50fa7b", "#f1fa8c", "#ffb86c"],
    functionColor: "#50fa7b"
  },
  material: {
    bg: "#263238", text: "#eeffff", border: "#37474f", hover: "#2c3b41", select: "#314549", header: "#546e7a", mode: "dark", monospace: "#80cbc4",
    ...darkEditorVisibility,
    cursor: "#80cbc4",
    cursorContrast: "#ff5370",
    cursorGlow: "rgba(128, 203, 196, 0.75)",
    cursorContrastGlow: "rgba(255, 83, 112, 0.7)",
    bracketMatchOutline: "#80cbc4",
    bracketMismatchBg: "rgba(255, 83, 112, 0.22)",
    brackets: ["#80cbc4", "#c792ea", "#c3e88d", "#ffcb6b", "#ff5370"],
    functionColor: "#c792ea"
  },
  materialLight: {
    bg: "#fafafa", text: "#90a4ae", border: "#e0e0e0", hover: "#f0f0f0", select: "#e0e0e0", header: "#90a4ae", mode: "light", monospace: "#39adb5",
    ...lightEditorVisibility,
    cursor: "#00796b",
    cursorContrast: "#c2185b",
    cursorGlow: "rgba(0, 121, 107, 0.42)",
    cursorContrastGlow: "rgba(194, 24, 91, 0.34)",
    bracketMatchOutline: "#00796b",
    bracketMismatchBg: "rgba(198, 40, 40, 0.14)",
    brackets: ["#00796b", "#5e35b1", "#2e7d32", "#c62828", "#ef6c00"],
    functionColor: "#7b1fa2"
  },
  nord: {
    bg: "#2e3440", text: "#d8dee9", border: "#434c5e", hover: "#3b4252", select: "#434c5e", header: "#4c566a", mode: "dark", monospace: "#88c0d0",
    ...darkEditorVisibility,
    cursor: "#88c0d0",
    cursorContrast: "#bf616a",
    cursorGlow: "rgba(136, 192, 208, 0.72)",
    cursorContrastGlow: "rgba(191, 97, 106, 0.65)",
    bracketMatchOutline: "#88c0d0",
    bracketMismatchBg: "rgba(191, 97, 106, 0.22)",
    brackets: ["#88c0d0", "#b48ead", "#a3be8c", "#ebcb8b", "#bf616a"],
    functionColor: "#b48ead"
  },
  oneDark: { bg: "#282c34", text: "#abb2bf", border: "#181a1f", hover: "#2c313a", select: "#292d3e", header: "#5c6370", mode: "dark", monospace: "#56b6c2", ...darkEditorVisibility, functionColor: "#61afef" }
};

export async function applyUIThemeVariables(themeName: string) {
    const colors = themeColors[themeName] || themeColors.default;
    document.documentElement.style.setProperty("--ui-bg", colors.bg);
    document.documentElement.style.setProperty("--ui-text", colors.text);
    document.documentElement.style.setProperty("--ui-border", colors.border);
    document.documentElement.style.setProperty("--ui-hover", colors.hover);
    document.documentElement.style.setProperty("--ui-select", colors.select);
    document.documentElement.style.setProperty("--ui-header-text", colors.header);
    document.documentElement.style.setProperty("--ui-monospace-color", colors.monospace);
    document.documentElement.style.setProperty("--editor-cursor-color", colors.cursor);
    document.documentElement.style.setProperty("--editor-cursor-contrast-color", colors.cursorContrast);
    document.documentElement.style.setProperty("--editor-cursor-shadow", colors.cursorShadow);
    document.documentElement.style.setProperty("--editor-cursor-glow", colors.cursorGlow);
    document.documentElement.style.setProperty("--editor-cursor-contrast-shadow", colors.cursorContrastShadow);
    document.documentElement.style.setProperty("--editor-cursor-contrast-glow", colors.cursorContrastGlow);
    document.documentElement.style.setProperty("--editor-selection-color", colors.selection);
    document.documentElement.style.setProperty("--editor-selection-focus-color", colors.selectionFocus);
    document.documentElement.style.setProperty("--editor-selection-outline", colors.selectionOutline);
    document.documentElement.style.setProperty("--editor-bracket-match-outline", colors.bracketMatchOutline);
    document.documentElement.style.setProperty("--editor-bracket-mismatch-bg", colors.bracketMismatchBg);
    colors.brackets.forEach((color, index) => {
        document.documentElement.style.setProperty(`--editor-bracket-${index}`, color);
    });
    document.documentElement.style.setProperty("--editor-function-color", colors.functionColor);
    
    try {
        await getCurrentWindow().setTheme(colors.mode);
    } catch (e) {
        console.warn("Failed to set native window theme", e);
    }
}
