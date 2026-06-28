import { EditorView } from "@codemirror/view";
import { HighlightStyle } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { codeEditorFontStack } from "./fontCatalog";

export const baseEditorLayoutTheme = EditorView.theme({
  "&": { 
      height: "100%", 
      fontSize: "var(--editor-font-size, 14px)",
      lineHeight: "var(--editor-line-height, 1.7)"
  },
  ".cm-line": { padding: "0 12px", overflow: "visible !important" },
  ".cm-gutters": { borderRight: "1px solid var(--ui-border)" },
  ".cm-cursor, .cm-dropCursor": {
      borderLeftColor: "var(--editor-cursor-color, #005cc5) !important",
      borderLeftWidth: "3px !important",
      filter: "drop-shadow(0 0 2px var(--editor-cursor-shadow, rgba(255, 255, 255, 0.95))) drop-shadow(0 0 5px var(--editor-cursor-glow, rgba(0, 92, 197, 0.45)))"
  },
  ".cm-focused .cm-cursor": {
      animation: "typstry-cursor-pulse 1.05s steps(1) infinite"
  },
  "@keyframes typstry-cursor-pulse": {
      "0%, 45%": {
          borderLeftColor: "var(--editor-cursor-color, #005cc5)",
          filter: "drop-shadow(0 0 2px var(--editor-cursor-shadow, rgba(255, 255, 255, 0.95))) drop-shadow(0 0 5px var(--editor-cursor-glow, rgba(0, 92, 197, 0.45)))"
      },
      "46%, 100%": {
          borderLeftColor: "var(--editor-cursor-contrast-color, #d73a49)",
          filter: "drop-shadow(0 0 2px var(--editor-cursor-contrast-shadow, rgba(255, 255, 255, 0.95))) drop-shadow(0 0 5px var(--editor-cursor-contrast-glow, rgba(215, 58, 73, 0.35)))"
      }
  },
  ".cm-selectionBackground, .cm-content ::selection": {
      backgroundColor: "var(--editor-selection-color, rgba(3, 102, 214, 0.22)) !important"
  },
  ".cm-focused .cm-selectionBackground": {
      backgroundColor: "var(--editor-selection-focus-color, rgba(3, 102, 214, 0.3)) !important",
      outline: "1px solid var(--editor-selection-outline, rgba(3, 102, 214, 0.32))"
  },
  ".cm-matchingBracket": {
      backgroundColor: "var(--ui-select, rgba(255, 255, 255, 0.2)) !important",
      outline: "1px solid var(--editor-bracket-match-outline, #005cc5) !important",
      borderRadius: "2px"
  },
  ".cm-nonmatchingBracket": {
      backgroundColor: "var(--editor-bracket-mismatch-bg, rgba(215, 58, 73, 0.16)) !important",
      color: "inherit !important"
  },
  "& .bracket-color-0, & .bracket-color-0 *": { color: "var(--editor-bracket-0) !important" },
  "& .bracket-color-1, & .bracket-color-1 *": { color: "var(--editor-bracket-1) !important" },
  "& .bracket-color-2, & .bracket-color-2 *": { color: "var(--editor-bracket-2) !important" },
  "& .bracket-color-3, & .bracket-color-3 *": { color: "var(--editor-bracket-3) !important" },
  "& .bracket-color-4, & .bracket-color-4 *": { color: "var(--editor-bracket-4) !important" }
});

export function editorFontTheme(fontFamily: string = codeEditorFontStack("fira-mono")) {
  return EditorView.theme({
    "&": {
      height: "100%",
      "--editor-code-font": fontFamily
    },
    ".cm-content": {
      fontFamily: "var(--editor-code-font) !important"
    },
    ".cm-gutters": {
      fontFamily: "var(--editor-code-font) !important"
    }
  });
}

export const typstColorHighlighting = HighlightStyle.define([
  { tag: [tags.keyword, tags.controlKeyword, tags.atom, tags.bool], color: "#8b2635" },
  { tag: tags.variableName, color: "#5b21b6" },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: "#005cc5" },
  { tag: tags.labelName, color: "#1d6c76" }, // Labels and references (teal)
  { tag: tags.number, color: "#8b2635" },
  { tag: tags.operator, color: "#8b2635" },
  { tag: tags.punctuation, color: "#4b5563" },
  { tag: tags.heading, color: "var(--ui-text, #1f2937)", fontWeight: "bold", textDecoration: "underline" },
  { tag: tags.comment, color: "#6a737d", fontStyle: "italic" },
  { tag: tags.string, color: "#22863a" },
  { tag: [tags.literal, tags.monospace], color: "#5a5a5a" },
  { tag: tags.escape, color: "#22863a" },
  { tag: tags.link, color: "#005cc5", textDecoration: "underline" },
  { tag: tags.regexp, color: "#22863a" }, // mathDelimiter
  { tag: tags.special(tags.operator), color: "#22863a" }, // mathOperator
  { tag: tags.strong, fontWeight: "bold" },
  { tag: tags.emphasis, fontStyle: "italic" }
]);

// Structural formatting belongs to Typst rather than to a selected color
// palette, so keep it active alongside both the default and third-party themes.
export const typstSemanticHighlighting = HighlightStyle.define([
  { tag: tags.heading, fontWeight: "bold", textDecoration: "underline" },
  { tag: tags.strong, fontWeight: "bold" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.link, textDecoration: "underline" }
]);

export const typstVariableHighlighting = HighlightStyle.define([
  { tag: tags.special(tags.variableName), color: "var(--editor-variable-color, #5b21b6)" }
]);

export const typstFunctionHighlighting = HighlightStyle.define([
  {
    tag: [tags.function(tags.variableName), tags.function(tags.propertyName)],
    color: "var(--editor-function-color, #005cc5)"
  }
]);

export const typstFontHighlighting = HighlightStyle.define([
  { tag: [tags.keyword, tags.controlKeyword], fontFamily: "var(--editor-code-font) !important" },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], fontFamily: "var(--editor-code-font) !important" },
  { tag: [tags.variableName, tags.labelName, tags.special(tags.variableName)], fontFamily: "var(--editor-code-font) !important" },
  { tag: [tags.number, tags.atom, tags.bool, tags.escape], fontFamily: "var(--editor-code-font) !important" },
  { tag: [tags.operator, tags.punctuation], fontFamily: "var(--editor-code-font) !important" },
  { tag: tags.heading, scale: 1.15, fontFamily: "var(--editor-code-font) !important" },
  { tag: tags.comment, fontFamily: "var(--editor-code-font) !important" },
  { tag: tags.string, fontFamily: "var(--editor-code-font) !important" },
  { tag: tags.content, fontFamily: "var(--editor-code-font) !important" },
  { tag: [tags.literal, tags.monospace], fontFamily: "var(--editor-code-font) !important", color: "var(--ui-monospace-color) !important" },
  { tag: [tags.strong, tags.emphasis, tags.list, tags.link, tags.url], fontFamily: "var(--editor-code-font) !important" }
]);
