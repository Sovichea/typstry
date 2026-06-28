import { autocompletion, CompletionContext, snippetCompletion, Completion } from "@codemirror/autocomplete";
import type { TinymistLspClient } from "../compiler/lsp";

type LspCompletionItem = {
  label: string;
  labelDetails?: { description?: string; detail?: string };
  detail?: string;
  documentation?: string | { value?: string };
  kind?: number;
  insertText?: string;
  textEdit?: { newText?: string };
  insertTextFormat?: number;
  sortText?: string;
};

type LspCompletionResponse = LspCompletionItem[] | { items?: LspCompletionItem[] } | null;

export const typstSnippets = [
  // Document structure
  snippetCompletion("#set document(title: \"${title}\")\n", { label: "#document", detail: "Document Properties" }),
  snippetCompletion("#set page(margin: ${margin}, paper: \"${paper}\")\n", { label: "#page", detail: "Page setup" }),
  snippetCompletion("#set text(font: \"${font}\", size: ${11pt})\n", { label: "#text", detail: "Text Properties" }),
  snippetCompletion("#set heading(numbering: \"${1.}\")\n", { label: "#heading setup", detail: "Heading Numbering" }),
  
  // Elements
  snippetCompletion("#align(${center})[\n  ${content}\n]\n", { label: "#align", detail: "Align content" }),
  snippetCompletion("#import \"${pkg}\": *\n", { label: "#import", detail: "Import package" }),
  snippetCompletion("= ${heading}\n", { label: "= Heading 1", detail: "Level 1 Heading" }),
  snippetCompletion("== ${heading}\n", { label: "== Heading 2", detail: "Level 2 Heading" }),
  snippetCompletion("#figure(\n  image(\"${path}\", width: ${80%}),\n  caption: [${caption}],\n)\n", { label: "#figure", detail: "Image Figure" }),
  snippetCompletion("#table(\n  columns: (${columns}),\n  align: ${center},\n  [${A}], [${B}],\n)\n", { label: "#table", detail: "Table" }),
  snippetCompletion("#grid(\n  columns: (${columns}),\n  gutter: ${1em},\n  [${cell 1}], [${cell 2}],\n)\n", { label: "#grid", detail: "Grid layout" }),
  
  // Math & Code
  snippetCompletion("$ ${math} $\n", { label: "math inline", detail: "Inline Math" }),
  snippetCompletion("$ ${math} $\n", { label: "$", detail: "Inline Math" }),
  snippetCompletion("$ \n  ${math} \n$\n", { label: "math block", detail: "Math Block" }),
  snippetCompletion("```${lang}\n${code}\n```\n", { label: "```", detail: "Code Block" }),
  
  // Typography
  snippetCompletion("*${bold}*", { label: "*bold*", detail: "Bold text" }),
  snippetCompletion("_${italic}_", { label: "_italic_", detail: "Italic text" }),
  snippetCompletion("#strong[${bold}]", { label: "#strong", detail: "Strong text" }),
  snippetCompletion("#emph[${italic}]", { label: "#emph", detail: "Emphasized text" }),
  
  // Math common
  snippetCompletion("frac(${num}, ${den})", { label: "frac", detail: "Fraction" }),
  snippetCompletion("sum_(${i=1})^(${n})", { label: "sum", detail: "Summation" }),
  snippetCompletion("integral_(${a})^(${b})", { label: "integral", detail: "Integral" }),
];

export function typstCompletions(context: CompletionContext) {
  const word = context.matchBefore(/[\w#=]+/);
  if (!word) {
    if (context.explicit) {
      return { from: context.pos, options: typstSnippets };
    }
    return null;
  }
  return {
    from: word.from,
    options: typstSnippets
  };
}

function getCmCompletionType(kind?: number): string {
  switch (kind) {
    case 1: return "text";
    case 2: return "method";
    case 3: return "function";
    case 4: return "constructor";
    case 5: return "field";
    case 6: return "variable";
    case 7: return "class";
    case 8: return "interface";
    case 9: return "module";
    case 10: return "property";
    case 14: return "keyword";
    default: return "variable";
  }
}

export function createTypstAutocomplete(getClient: () => TinymistLspClient | undefined, getUri: () => string, flushLspSync: () => void) {
  return autocompletion({
    override: [
      async (context: CompletionContext) => {
        if (!context.explicit) {
          const lineStr = context.state.doc.lineAt(context.pos).text;
          const col = context.pos - context.state.doc.lineAt(context.pos).from;
          const textBefore = lineStr.slice(0, col);
          
          // Only trigger autocomplete implicitly on word characters or specific trigger characters (#, ., @, -)
          const lastChar = textBefore.slice(-1);
          if (!/[\w#\.@-]/.test(lastChar)) {
            return null;
          }
          
          const isHashWord = /#[\w-]*$/.test(textBefore);
          const isSetShow = /^\s*#(?:set|show)\b/.test(textBefore);
          
          const docBefore = context.state.doc.sliceString(0, context.pos);
          const openBraces = (docBefore.match(/\{/g) || []).length;
          const closeBraces = (docBefore.match(/\}/g) || []).length;
          const inCodeBlock = openBraces > closeBraces;
          
          if (!isHashWord && !isSetShow && !inCodeBlock) {
            return null;
          }
        }

        const client = getClient();
        const uri = getUri();
        if (!client || !uri) return typstCompletions(context);
        
        const doc = context.state.doc;
        const position = client.lspPositionFromEditorPosition(doc, context.pos);
        
        // Force flush any pending LSP document changes so the server has the very latest keystrokes
        flushLspSync();
        
        try {
          const response = await client.request<LspCompletionResponse>("textDocument/completion", {
            textDocument: { uri },
            position,
            context: {
              triggerKind: 1
            }
          });
          
          if (!response) return typstCompletions(context);
          
          const items = Array.isArray(response) ? response : response.items;
          if (!items || items.length === 0) return typstCompletions(context);
          
          const word = context.matchBefore(/#?[\w-]*/);
          const isHashPrefix = word?.text.startsWith('#');
          
          const options: Completion[] = items.map(item => {
            let label = item.label;
            let detail = item.labelDetails?.description ?? item.labelDetails?.detail ?? item.detail;
            let info = typeof item.documentation === 'string' ? item.documentation : item.documentation?.value;
            const type = getCmCompletionType(item.kind);
            
            // VS Code style: keep detail short, move long text to info
            if (detail && detail.length > 30 && detail.includes(' ')) {
                if (!info) info = detail;
                detail = undefined;
            }
            
            let apply = item.insertText ?? item.textEdit?.newText ?? label;
            
            if (isHashPrefix && !label.startsWith('#') && (type === 'function' || type === 'keyword' || type === 'module' || type === 'variable')) {
                label = '#' + label;
                if (typeof apply === 'string' && !apply.startsWith('#')) {
                    apply = '#' + apply;
                } else if (typeof apply === 'string' && apply.startsWith('#')) {
                    // already starts with #
                }
            }
            
            if (item.insertTextFormat === 2) {
              return snippetCompletion(apply, { label, detail, info, type });
            }
            
            return {
              label,
              detail,
              info,
              type,
              apply,
              sortText: item.sortText
            };
          });
          
          return {
            from: word ? word.from : context.pos,
            options
          };
          
        } catch (e) {
          console.warn("LSP completion error", e);
          return typstCompletions(context);
        }
      }
    ]
  });
}
