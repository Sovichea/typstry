import { EditorView } from "@codemirror/view";
import { HighlightStyle } from "@codemirror/language";
import { tags } from "@lezer/highlight";

export const baseEditorLayoutTheme = EditorView.theme({
  "&": { 
      height: "100%", 
      fontSize: "14px", 
      lineHeight: "1.7" 
  },
  ".cm-line": { padding: "0 12px", overflow: "visible !important" },
  ".cm-gutters": { borderRight: "1px solid var(--ui-border)" },
  ".cm-matchingBracket": {
      backgroundColor: "var(--ui-select, rgba(255, 255, 255, 0.2)) !important",
      outline: "1px solid #007acc !important",
      borderRadius: "2px"
  },
  ".cm-nonmatchingBracket": {
      backgroundColor: "rgba(255, 0, 0, 0.2) !important",
      color: "inherit !important"
  },
  "& .bracket-color-0, & .bracket-color-0 *": { color: "#ffd700 !important", fontWeight: "bold !important" },
  "& .bracket-color-1, & .bracket-color-1 *": { color: "#da70d6 !important", fontWeight: "bold !important" },
  "& .bracket-color-2, & .bracket-color-2 *": { color: "#87cefa !important", fontWeight: "bold !important" },
  "& .bracket-color-3, & .bracket-color-3 *": { color: "#ff8c00 !important", fontWeight: "bold !important" },
  "& .bracket-color-4, & .bracket-color-4 *": { color: "#98fb98 !important", fontWeight: "bold !important" }
});

export function editorFontTheme(fontFamily: string = "ui-monospace, SFMono-Regular, Consolas, 'Liberation Mono', monospace") {
  return EditorView.theme({
    "&, .cm-content, .cm-gutters": {
      fontFamily
    }
  });
}

export const typstSyntaxHighlighting = HighlightStyle.define([
  { tag: [tags.keyword, tags.controlKeyword], color: "#7c3aed", fontWeight: "bold" },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: "#0f766e", fontWeight: "600" },
  { tag: [tags.variableName, tags.labelName], color: "#1d4ed8" },
  { tag: [tags.number, tags.atom, tags.bool], color: "#b45309" },
  { tag: [tags.operator, tags.punctuation], color: "#4b5563" },
  { tag: tags.heading, color: "#0056b3", fontWeight: "bold", scale: 1.15 },
  { tag: tags.comment, color: "#008000", fontStyle: "italic" },
  {
    tag: [tags.string, tags.content, tags.literal],
    color: "#a31515"
  }
]);
