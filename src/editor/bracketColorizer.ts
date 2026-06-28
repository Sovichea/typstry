import { Decoration, EditorView, type ViewUpdate } from "@codemirror/view";
import { ViewPlugin, DecorationSet } from "@codemirror/view";
import { MatchDecorator } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";

// Create a MatchDecorator that matches ANY bracket.
const bracketMatcher = new MatchDecorator({
  regexp: /[()[\]{}]/g,
  decoration: (match, view, pos) => {
    const nodeName = syntaxTree(view.state).resolveInner(pos, 1).name;
    if (nodeName !== "punctuation") {
      return null;
    }

    // To calculate depth, we can just scan the text up to this position.
    // Since MatchDecorator caches decorations, this is only called when needed.
    const text = view.state.doc.sliceString(0, pos);
    let depth = 0;
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      if (char === '(' || char === '[' || char === '{') depth++;
      else if (char === ')' || char === ']' || char === '}') depth = Math.max(0, depth - 1);
    }
    
    // Adjust depth based on what THIS bracket is
    const char = match[0];
    if (char === ')' || char === ']' || char === '}') {
        depth = Math.max(0, depth - 1);
    }
    
    const colorIndex = depth % 5;
    return Decoration.mark({ class: `bracket-color-${colorIndex}` });
  }
});

export const bracketColorizer = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  
  constructor(view: EditorView) {
    this.decorations = bracketMatcher.createDeco(view);
  }
  
  update(update: ViewUpdate) {
    this.decorations = bracketMatcher.updateDeco(update, this.decorations);
  }
}, {
  decorations: v => v.decorations
});
