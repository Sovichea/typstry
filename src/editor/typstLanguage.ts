import { StreamLanguage } from "@codemirror/language";
import type { StreamParser, StringStream } from "@codemirror/language";

type TypstParserState = {
  inBlockComment: boolean;
  inRawBlock: boolean;
  indentLevel: number;
};

const keywordPattern = /#(?:let|set|show|import|include|if|else|for|while|break|continue|return|none|auto|true|false)\b/;
const functionPattern = /#[A-Za-z_][\w-]*(?=\s*(?:\(|\[))/;

const typstParser: StreamParser<TypstParserState> = {
  name: "typst",

  startState() {
    return { inBlockComment: false, inRawBlock: false, indentLevel: 0 };
  },

  token(stream: StringStream, state: TypstParserState): string | null {
    if (stream.sol() && stream.match(/```/)) {
      state.inRawBlock = !state.inRawBlock;
      stream.skipToEnd();
      return "string special";
    }

    if (state.inRawBlock) {
      stream.skipToEnd();
      return "string";
    }

    if (state.inBlockComment) {
      if (stream.skipTo("*/")) {
        stream.match("*/");
        state.inBlockComment = false;
      } else {
        stream.skipToEnd();
      }
      return "comment";
    }

    if (stream.eatSpace()) return null;

    if (stream.match("//")) {
      stream.skipToEnd();
      return "comment";
    }

    if (stream.match("/*")) {
      state.inBlockComment = true;
      return "comment";
    }

    if (stream.sol() && stream.match(/={1,6}(?=\s)/)) return "heading";

    if (stream.match(/"(?:[^"\\]|\\.)*"?/)) return "string";
    if (stream.match(/`[^`]*`?/)) return "monospace";
    if (stream.match(/\$[^$]*\$?/)) return "atom";
    if (stream.match(/@[A-Za-z0-9_-]+/)) return "labelName";
    if (stream.match(/<[A-Za-z0-9:_-]+>/)) return "labelName";
    if (stream.match(keywordPattern)) return "keyword";
    if (stream.match(functionPattern)) return "variableName function";
    if (stream.match(/#[A-Za-z_][\w-]*/)) return "variableName";
    if (stream.match(/\b\d+(?:\.\d+)?(?:pt|em|mm|cm|in|deg|%|fr)?\b/)) return "number";
    if (stream.match(/[+\-*/=<>!&|]+/)) return "operator";
    if (stream.match(/[({[]/)) {
      state.indentLevel++;
      return "punctuation";
    }
    
    if (stream.match(/[)}\]]/)) {
      if (state.indentLevel > 0) state.indentLevel--;
      return "punctuation";
    }

    if (stream.match(/[.,:;]/)) return "punctuation";
    if (stream.match(/\*{1,2}|_{1,2}/)) return "strong";

    stream.next();
    return null;
  },
  
  languageData: {
    commentTokens: { line: "//", block: { open: "/*", close: "*/" } },
    indentOnInput: /^\s*[\}\]]$/,
    closeBrackets: { brackets: ["(", "[", "{", '"', "'", "*", "_", "$"] }
  },

  indent(state: TypstParserState, textAfter: string, cx) {
    if (state.inBlockComment || state.inRawBlock) return null;
    let indent = state.indentLevel * cx.unit;
    if (/^[\}\]]/.test(textAfter)) indent -= cx.unit;
    return indent;
  }
};

export const typstLanguage = StreamLanguage.define(typstParser);
