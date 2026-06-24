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
  ".cm-gutters": { borderRight: "1px solid var(--ui-border)" }
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
