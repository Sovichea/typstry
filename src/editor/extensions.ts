import { Extension, Compartment } from "@codemirror/state";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { lineNumbers, highlightActiveLineGutter, highlightActiveLine, drawSelection, dropCursor, keymap, EditorView } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { search, searchKeymap } from "@codemirror/search";
import { baseEditorLayoutTheme, editorFontTheme, typstSyntaxHighlighting } from "./themes";
import { syntaxHighlighting } from "@codemirror/language";
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

export const themeCompartment = new Compartment();
export const wrapCompartment = new Compartment();
export const editorFontCompartment = new Compartment();

export function getEditorExtensions(getClient: () => TinymistLspClient | undefined, getUri: () => string, flushLspSync: () => void): Extension[] {
  return [
    lineNumbers(), highlightActiveLineGutter(), highlightActiveLine(),
    drawSelection(), dropCursor(), history(), 
    typstLanguage,
    baseEditorLayoutTheme,
    editorDiagnosticsExtension,
    indentationMarkers(),
    wrapCompartment.of(EditorView.lineWrapping),
    search({ top: true }),
    closeBrackets(),
    bracketMatching(),
    bracketColorizer,
    createHoverTooltip(getClient, getUri),
    createTypstAutocomplete(getClient, getUri, flushLspSync),
    themeCompartment.of(syntaxHighlighting(typstSyntaxHighlighting)),
    editorFontCompartment.of(editorFontTheme()),
    keymap.of([
      { key: "Mod-/", run: toggleLineComment },
      indentWithTab, 
      ...closeBracketsKeymap, 
      ...defaultKeymap, 
      ...historyKeymap, 
      ...searchKeymap, 
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
            baseExtensions.push(syntaxHighlighting(typstSyntaxHighlighting));
            break;
    }
    
    baseExtensions.push(syntaxHighlighting(typstSyntaxHighlighting));
    return baseExtensions;
}

const themeColors: Record<string, { bg: string, text: string, border: string, hover: string, select: string, header: string, mode: "dark" | "light" }> = {
  default: { bg: "#fcfcfc", text: "#333333", border: "#e0e0e0", hover: "#e4e6f1", select: "#d7e8f5", header: "#616161", mode: "light" },
  githubLight: { bg: "#ffffff", text: "#24292f", border: "#d0d7de", hover: "#f3f4f6", select: "#ddf4ff", header: "#57606a", mode: "light" },
  githubDark: { bg: "#0d1117", text: "#c9d1d9", border: "#30363d", hover: "#161b22", select: "#21262d", header: "#8b949e", mode: "dark" },
  dracula: { bg: "#282a36", text: "#f8f8f2", border: "#44475a", hover: "#44475a", select: "#6272a4", header: "#6272a4", mode: "dark" },
  material: { bg: "#263238", text: "#eeffff", border: "#37474f", hover: "#2c3b41", select: "#314549", header: "#546e7a", mode: "dark" },
  materialLight: { bg: "#fafafa", text: "#90a4ae", border: "#e0e0e0", hover: "#f0f0f0", select: "#e0e0e0", header: "#90a4ae", mode: "light" },
  nord: { bg: "#2e3440", text: "#d8dee9", border: "#434c5e", hover: "#3b4252", select: "#434c5e", header: "#4c566a", mode: "dark" },
  oneDark: { bg: "#282c34", text: "#abb2bf", border: "#181a1f", hover: "#2c313a", select: "#292d3e", header: "#5c6370", mode: "dark" }
};

export async function applyUIThemeVariables(themeName: string) {
    const colors = themeColors[themeName] || themeColors.default;
    document.documentElement.style.setProperty("--ui-bg", colors.bg);
    document.documentElement.style.setProperty("--ui-text", colors.text);
    document.documentElement.style.setProperty("--ui-border", colors.border);
    document.documentElement.style.setProperty("--ui-hover", colors.hover);
    document.documentElement.style.setProperty("--ui-select", colors.select);
    document.documentElement.style.setProperty("--ui-header-text", colors.header);
    
    try {
        await getCurrentWindow().setTheme(colors.mode);
    } catch (e) {
        console.warn("Failed to set native window theme", e);
    }
}
