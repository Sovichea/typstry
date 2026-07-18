import { Extension, Compartment, EditorState, StateEffect, RangeSetBuilder, Prec } from "@codemirror/state";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { lineNumbers, highlightActiveLineGutter, highlightActiveLine, drawSelection, dropCursor, keymap, EditorView, ViewPlugin, Decoration, DecorationSet, ViewUpdate } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, insertTab } from "@codemirror/commands";
import { search, searchKeymap } from "@codemirror/search";
import { baseEditorLayoutTheme, editorFontTheme, typstColorHighlighting, typstFontHighlighting, typstFunctionHighlighting, typstSemanticHighlighting, typstVariableHighlighting } from "./themes";
import { codeFolding, foldGutter, foldKeymap, foldService, indentUnit, syntaxHighlighting } from "@codemirror/language";
import { typstLanguage } from "./typstLanguage";
import { editorDiagnosticsExtension } from "./diagnostics";
import { indentationMarkers } from '@replit/codemirror-indentation-markers';

import * as uiwThemes from "@uiw/codemirror-themes-all";
import { oneDark } from "@codemirror/theme-one-dark";
import { createTypstAutocomplete, type ProviderCapabilities } from "./autocomplete";
import { acceptCompletion, completionKeymap, closeBrackets, closeBracketsKeymap, moveCompletionSelection } from "@codemirror/autocomplete";
import { bracketMatching } from "@codemirror/language";
import { toggleLineComment } from "@codemirror/commands";
import { bracketColorizer } from "./bracketColorizer";
import { createHoverTooltip } from "./hover";
import type { TinymistLspClient } from "../compiler/lsp";
import { typstFunctionFoldService } from "./folding";
import { deleteNextGrapheme, deletePreviousGrapheme, graphemeSelectionBoundaryFilter, moveNextGrapheme, movePreviousGrapheme, selectNextGrapheme, selectPreviousGrapheme } from "./grapheme";
import { editingPolicyRegistry } from "./editingPolicies/registry";
import { showInvisibleCharacters } from "./invisibles";
import { TYPSASTRA_GREEN, TYPSASTRA_GREEN_GLOW } from "../ui/brandColors";

export const themeCompartment = new Compartment();
export const wrapCompartment = new Compartment();
export const editorFontCompartment = new Compartment();
export const lineNumbersCompartment = new Compartment();
export const activeLineCompartment = new Compartment();
export const closeBracketsCompartment = new Compartment();
export const indentationGuidesCompartment = new Compartment();
export const tabSizeCompartment = new Compartment();
export const completionCompartment = new Compartment();
export const showZwsCompartment = new Compartment();

const completionNavigationHandler = Prec.highest(EditorView.domEventHandlers({
  keydown(event, view) {
    let handled = false;
    if (event.key === "ArrowDown") {
      handled = moveCompletionSelection(true)(view);
    } else if (event.key === "ArrowUp") {
      handled = moveCompletionSelection(false)(view);
    } else if (event.key === "PageDown") {
      handled = moveCompletionSelection(true, "page")(view);
    } else if (event.key === "PageUp") {
      handled = moveCompletionSelection(false, "page")(view);
    } else if (event.key === "Enter") {
      handled = acceptCompletion(view);
    }
    if (!handled) return false;
    event.preventDefault();
    return true;
  }
}));

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

function typstFoldMarkerDOM(open: boolean): HTMLElement {
  const marker = document.createElement("span");
  const label = open ? "Fold line" : "Unfold line";
  marker.textContent = open ? "-" : "+";
  marker.dataset.folded = String(!open);
  marker.title = label;
  marker.setAttribute("aria-label", label);
  return marker;
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

const ctrlClickForceUpdateEffect = StateEffect.define<null>();
const linkDecoration = Decoration.mark({ class: "cm-ctrl-link", attributes: { style: "text-decoration: underline; cursor: pointer;" } });

export function typstImportPathRange(state: EditorState, position: number): { from: number; to: number } | null {
  const line = state.doc.lineAt(position);
  const pathPatterns = [
    /#(?:include|import)\s+"((?:\\.|[^"\\])*)"/g,
    /#?(?:bibliography|image)\s*\(\s*"((?:\\.|[^"\\])*)"/g
  ];
  for (const pathPattern of pathPatterns) {
    for (const match of line.text.matchAll(pathPattern)) {
      if (match.index === undefined) continue;
      const quotedPath = match[1];
      const openingQuote = match[0].indexOf('"');
      const from = line.from + match.index + openingQuote + 1;
      const to = from + quotedPath.length;
      if (position >= from && position < to) return { from, to };
    }
  }
  return null;
}

export const ctrlClickLinkPlugin = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  hoveredPos: number | null = null;
  isCtrlDown = false;
  view: EditorView;

  constructor(view: EditorView) {
    this.view = view;
    this.decorations = Decoration.none;
  }

  update(update: ViewUpdate) {
    if (update.docChanged || update.transactions.some(tr => tr.effects.some(e => e.is(ctrlClickForceUpdateEffect)))) {
      this.decorations = this.computeDecorations();
    }
  }

  computeDecorations(): DecorationSet {
    if (!this.isCtrlDown || this.hoveredPos === null) return Decoration.none;
    const importPath = typstImportPathRange(this.view.state, this.hoveredPos);
    if (importPath) {
      return Decoration.set([linkDecoration.range(importPath.from, importPath.to)]);
    }
    const word = this.view.state.wordAt(this.hoveredPos);
    if (word) {
      return Decoration.set([linkDecoration.range(word.from, word.to)]);
    }
    return Decoration.none;
  }

  updateDecorations(pos: number | null, isCtrlDown: boolean) {
    let changed = false;
    if (this.hoveredPos !== pos) {
      this.hoveredPos = pos;
      changed = true;
    }
    if (this.isCtrlDown !== isCtrlDown) {
      this.isCtrlDown = isCtrlDown;
      changed = true;
    }
    if (changed) {
      this.view.dispatch({ effects: ctrlClickForceUpdateEffect.of(null) });
    }
  }
}, {
  decorations: v => v.decorations,
  eventHandlers: {
    mousemove(e) {
      const pos = this.view.posAtCoords({ x: e.clientX, y: e.clientY });
      if (pos !== null) {
        (this as any).updateDecorations(pos, e.ctrlKey || e.metaKey);
      }
    },
    keydown(e) {
      const isCtrl = e.ctrlKey || e.metaKey || e.key === "Control" || e.key === "Meta";
      (this as any).updateDecorations(this.hoveredPos, isCtrl);
    },
    keyup(e) {
      const isCtrl = e.ctrlKey || e.metaKey;
      (this as any).updateDecorations(this.hoveredPos, isCtrl);
    },
    mouseleave(e) {
      (this as any).updateDecorations(null, e.ctrlKey || e.metaKey);
    }
  }
});

const zwsMark = Decoration.mark({
  class: "cm-zws-mark"
});

const invisibleBlockMark = Decoration.mark({
  class: "cm-invisible-block-mark"
});

const trailingSpaceDecoration = Decoration.mark({
  class: "cm-trailing-space-mark"
});

const showZeroWidthSpacesPlugin = ViewPlugin.fromClass(class {
  decorations: DecorationSet;

  constructor(view: EditorView) {
    this.decorations = this.getDeco(view);
  }

  update(update: ViewUpdate) {
    if (update.docChanged || update.viewportChanged) {
      this.decorations = this.getDeco(update.view);
    }
  }

  getDeco(view: EditorView) {
    const builder = new RangeSetBuilder<Decoration>();
    const ranges: { from: number; to: number; deco: Decoration }[] = [];
    for (const { from, to } of view.visibleRanges) {
      const text = view.state.doc.sliceString(from, to);

      for (let i = 0; i < text.length; i++) {
        const char = text[i];
        if (char === "\u200b" || char === "\u200c") {
          ranges.push({ from: from + i, to: from + i + 1, deco: zwsMark });
        } else if (char === "\u00ad" || char === "\u200d" || char === "\u200e" || char === "\u200f" || char === "\u2060") {
          ranges.push({ from: from + i, to: from + i + 1, deco: invisibleBlockMark });
        }
      }

      for (let line = view.state.doc.lineAt(from); line.from <= to; line = view.state.doc.line(line.number + 1)) {
        const lineText = line.text;
        const match = /[ \t]+$/u.exec(lineText);
        if (match) {
          const trailingFrom = line.from + match.index;
          const trailingTo = line.to;
          const start = Math.max(trailingFrom, from);
          const end = Math.min(trailingTo, to);
          if (start < end) {
            ranges.push({ from: start, to: end, deco: trailingSpaceDecoration });
          }
        }
        if (line.to >= to || line.number >= view.state.doc.lines) break;
      }
    }
    ranges.sort((a, b) => a.from - b.from || a.to - b.to);
    for (const range of ranges) {
      builder.add(range.from, range.to, range.deco);
    }
    return builder.finish();
  }
}, {
  decorations: v => v.decorations
});

export const showZeroWidthSpaces: Extension = [
  showInvisibleCharacters.of(true),
  showZeroWidthSpacesPlugin
];

export function getEditorExtensions(
  getClient: () => TinymistLspClient | undefined,
  getUri: () => string,
  flushLspSync: () => void | Promise<void>,
  onNavigateToDefinition?: (uri: string, line: number, character: number) => void,
  getProviders?: () => ProviderCapabilities[]
): Extension[] {
  return [
    ctrlClickLinkPlugin,
    ...editingPolicyRegistry.editorExtensions(),
    graphemeSelectionBoundaryFilter,
    showZwsCompartment.of(showZeroWidthSpaces),
    preventEscapedBracketAutoClose,
    EditorView.domEventHandlers({
      mousedown: (event, view) => {
        if ((event.ctrlKey || event.metaKey) && event.button === 0) {
          console.log("[Ctrl+Click] Detected! Pos:", view.posAtCoords({ x: event.clientX, y: event.clientY }));
          const client = getClient();
          const uri = getUri();
          const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
          if (client && pos !== null && onNavigateToDefinition) {
            const lspPos = client.lspPositionFromEditorPosition(view.state.doc, pos);
            console.log("[Ctrl+Click] Requesting definition for", uri, lspPos);
            void client.getDefinition(uri, lspPos).then((locations) => {
              console.log("[Ctrl+Click] Definition result:", locations);
              if (locations && locations.length > 0) {
                const loc = locations[0];
                const targetUri = loc.targetUri ?? loc.uri;
                const targetRange = loc.targetRange ?? loc.range;
                if (targetUri && targetRange) {
                  onNavigateToDefinition(targetUri, targetRange.start.line, targetRange.start.character ?? 0);
                }
              } else {
                console.log("[Ctrl+Click] Requesting references for", uri, lspPos);
                void client.getReferences(uri, lspPos).then((refs) => {
                  console.log("[Ctrl+Click] References result:", refs);
                  if (refs && refs.length > 0) {
                    const loc = refs[0];
                    const targetUri = loc.targetUri ?? loc.uri;
                    const targetRange = loc.targetRange ?? loc.range;
                    if (targetUri && targetRange) {
                      onNavigateToDefinition(targetUri, targetRange.start.line, targetRange.start.character ?? 0);
                    }
                  }
                });
              }
            });
            event.preventDefault();
            return true;
          }
        }
        return false;
      }
    }),
    foldService.of(typstFunctionFoldService),
    lineNumbersCompartment.of(lineNumbers()),
    foldGutter({
      markerDOM: typstFoldMarkerDOM
    }),
    activeLineCompartment.of([highlightActiveLineGutter(), highlightActiveLine()]),
    drawSelection(), dropCursor(), history(), 
    typstLanguage,
    baseEditorLayoutTheme,
    codeFolding({
      preparePlaceholder: foldedTypstPlaceholderSuffix,
      placeholderDOM: foldedTypstPlaceholderDOM
    }),
    editorDiagnosticsExtension,
    indentationGuidesCompartment.of(indentationMarkers()),
    tabSizeCompartment.of([EditorState.tabSize.of(2), indentUnit.of("  ")]),
    wrapCompartment.of(EditorView.lineWrapping),
    search({ top: true }),
    closeBracketsCompartment.of(closeBrackets()),
    bracketMatching(),
    bracketColorizer,
    createHoverTooltip(getClient, getUri),
    completionCompartment.of(createTypstAutocomplete(getClient, getUri, flushLspSync, true, getProviders)),
    completionNavigationHandler,
    themeCompartment.of(getThemeExtension("default")),
    editorFontCompartment.of(editorFontTheme()),
    keymap.of([
      { key: "Mod-/", run: toggleLineComment },
      { key: "Backspace", run: deletePreviousGrapheme },
      { key: "Delete", run: deleteNextGrapheme },
      { key: "ArrowLeft", run: movePreviousGrapheme },
      { key: "ArrowRight", run: moveNextGrapheme },
      { key: "Shift-ArrowLeft", run: selectPreviousGrapheme },
      { key: "Shift-ArrowRight", run: selectNextGrapheme },
      ...completionKeymap,
      { key: "Tab", run: insertTab }, 
      ...closeBracketsKeymap, 
      ...defaultKeymap, 
      ...historyKeymap, 
      ...searchKeymap, 
      ...foldKeymap
    ])
  ];
}

export function getThemeExtension(themeName: string): Extension {
    const baseExtensions = [];
    
    switch (themeName) {
        case "typsastraLight": baseExtensions.push(uiwThemes.githubLight); break;
        case "typsastraDark": baseExtensions.push(uiwThemes.githubDark); break;
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
    baseExtensions.push(syntaxHighlighting(typstVariableHighlighting));
    baseExtensions.push(syntaxHighlighting(typstFunctionHighlighting));
    baseExtensions.push(syntaxHighlighting(typstSemanticHighlighting));
    return baseExtensions;
}

type ThemeColorVariables = {
  bg: string;
  text: string;
  border: string;
  hover: string;
  select: string;
  accent?: string;
  autocompleteSelect?: string;
  autocompleteSelectText?: string;
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
  variableColor: string;
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
  functionColor: "#005cc5",
  variableColor: "#5b21b6"
} satisfies Pick<ThemeColorVariables, "cursor" | "cursorContrast" | "cursorShadow" | "cursorGlow" | "cursorContrastShadow" | "cursorContrastGlow" | "selection" | "selectionFocus" | "selectionOutline" | "bracketMatchOutline" | "bracketMismatchBg" | "brackets" | "functionColor" | "variableColor">;

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
  functionColor: "#79c0ff",
  variableColor: "#d2a8ff"
} satisfies Pick<ThemeColorVariables, "cursor" | "cursorContrast" | "cursorShadow" | "cursorGlow" | "cursorContrastShadow" | "cursorContrastGlow" | "selection" | "selectionFocus" | "selectionOutline" | "bracketMatchOutline" | "bracketMismatchBg" | "brackets" | "functionColor" | "variableColor">;

const themeColors: Record<string, ThemeColorVariables> = {
  default: { bg: "#fcfcfc", text: "#333333", border: "#e0e0e0", hover: "#e4e6f1", select: "#d7e8f5", header: "#616161", mode: "light", monospace: "#005cc5", ...lightEditorVisibility },
  typsastraLight: {
    bg: "#f7faf8", text: "#24352e", border: "#cedbd4", hover: "#e8f1ec", select: "#d8ebe1", accent: "#23865f", header: "#5b6f64", mode: "light", monospace: "#167a57",
    ...lightEditorVisibility,
    autocompleteSelect: "#23865f",
    cursor: "#167a57",
    cursorContrast: "#9c3f71",
    cursorGlow: "rgba(22, 122, 87, 0.48)",
    cursorContrastGlow: "rgba(156, 63, 113, 0.36)",
    selection: "rgba(35, 134, 95, 0.20)",
    selectionFocus: "rgba(35, 134, 95, 0.29)",
    selectionOutline: "rgba(35, 134, 95, 0.38)",
    bracketMatchOutline: "#23865f",
    brackets: ["#167a57", "#7656a8", "#247ba0", "#b26a1f", "#b33a3a"],
    functionColor: "#167a57",
    variableColor: "#7656a8"
  },
  typsastraDark: {
    bg: "#17211d", text: "#d8e5de", border: "#34463d", hover: "#202e28", select: "#294137", accent: "#45bf8a", header: "#8fa69a", mode: "dark", monospace: "#69d3a6",
    ...darkEditorVisibility,
    autocompleteSelect: "#32986d",
    cursor: "#69d3a6",
    cursorContrast: "#f28fbd",
    cursorGlow: "rgba(105, 211, 166, 0.72)",
    cursorContrastGlow: "rgba(242, 143, 189, 0.62)",
    selection: "rgba(69, 191, 138, 0.24)",
    selectionFocus: "rgba(69, 191, 138, 0.34)",
    selectionOutline: "rgba(105, 211, 166, 0.42)",
    bracketMatchOutline: "#69d3a6",
    brackets: ["#69d3a6", "#c7a0f3", "#75c8e8", "#e8b56a", "#f28b82"],
    functionColor: "#69d3a6",
    variableColor: "#c7a0f3"
  },
  githubLight: { bg: "#ffffff", text: "#24292f", border: "#d0d7de", hover: "#f3f4f6", select: "#ddf4ff", header: "#57606a", mode: "light", monospace: "#0550ae", ...lightEditorVisibility, functionColor: "#0969da", variableColor: "#6639ba" },
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
    functionColor: "#8be9fd",
    variableColor: "#bd93f9"
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
    functionColor: "#82aaff",
    variableColor: "#c792ea"
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
    functionColor: "#005cc5",
    variableColor: "#6a1b9a"
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
    functionColor: "#88c0d0",
    variableColor: "#b48ead"
  },
  oneDark: { bg: "#282c34", text: "#abb2bf", border: "#181a1f", hover: "#2c313a", select: "#292d3e", header: "#5c6370", mode: "dark", monospace: "#56b6c2", ...darkEditorVisibility, functionColor: "#61afef", variableColor: "#c678dd" }
};

export async function applyUIThemeVariables(themeName: string) {
    const colors = themeColors[themeName] || themeColors.default;
    document.documentElement.style.colorScheme = colors.mode;
    document.documentElement.style.setProperty("--ui-bg", colors.bg);
    document.documentElement.style.setProperty("--ui-text", colors.text);
    document.documentElement.style.setProperty("--ui-border", colors.border);
    document.documentElement.style.setProperty("--ui-hover", colors.hover);
    document.documentElement.style.setProperty("--ui-select", colors.select);
    document.documentElement.style.setProperty("--ui-accent-color", colors.accent ?? colors.functionColor);
    document.documentElement.style.setProperty(
        "--autocomplete-select-bg",
        colors.autocompleteSelect ?? (colors.mode === "dark" ? "#3b82f6" : "#0969da")
    );
    document.documentElement.style.setProperty(
        "--autocomplete-select-text",
        colors.autocompleteSelectText ?? "#ffffff"
    );
    document.documentElement.style.setProperty("--ui-header-text", colors.header);
    document.documentElement.style.setProperty("--ui-monospace-color", colors.monospace);
    document.documentElement.style.setProperty("--editor-cursor-color", TYPSASTRA_GREEN);
    document.documentElement.style.setProperty("--editor-cursor-contrast-color", colors.cursorContrast);
    document.documentElement.style.setProperty("--editor-cursor-shadow", colors.cursorShadow);
    document.documentElement.style.setProperty("--editor-cursor-glow", TYPSASTRA_GREEN_GLOW);
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
    document.documentElement.style.setProperty("--editor-variable-color", colors.variableColor);
    
    try {
        await getCurrentWindow().setTheme(colors.mode);
    } catch (e) {
        console.warn("Failed to set native window theme", e);
    }
}
