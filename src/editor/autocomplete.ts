import { autocompletion, CompletionContext, snippetCompletion, Completion } from "@codemirror/autocomplete";
import type { Text } from "@codemirror/state";
import type { TinymistLspClient } from "../compiler/lsp";
import type { LanguageProviderCapabilities } from "../languageSupport";
import { invoke } from "@tauri-apps/api/core";

type LspPosition = { line: number; character?: number };
type LspRange = { start: LspPosition; end: LspPosition };
type LspTextEdit = {
  newText?: string;
  range?: LspRange;
  insert?: LspRange;
  replace?: LspRange;
};
type LspEditRange = LspRange | { insert: LspRange; replace: LspRange };

type LspCompletionItem = {
  label: string;
  labelDetails?: { description?: string; detail?: string };
  detail?: string;
  documentation?: string | { value?: string };
  kind?: number;
  insertText?: string;
  textEdit?: LspTextEdit;
  insertTextFormat?: number;
  sortText?: string;
};

type LspCompletionResponse = LspCompletionItem[] | {
  items?: LspCompletionItem[];
  itemDefaults?: {
    editRange?: LspEditRange;
    insertTextFormat?: number;
  };
} | null;

export type LanguageCompletionResponse = {
  provider: string;
  from: number;
  to: number;
  options: string[];
};

export function languageCompletionRange(
  runFrom: number,
  runLength: number,
  completion: LanguageCompletionResponse | null
): { from: number; to: number } | null {
  if (!completion || completion.from < 0 || completion.from >= completion.to
    || completion.to !== runLength) return null;
  return { from: runFrom + completion.from, to: runFrom + completion.to };
}

export const languageCompletionValidFor = () => false;

function textEditFromDefault(range: LspEditRange | undefined, newText: string): LspTextEdit | undefined {
  if (!range) return undefined;
  if ("start" in range) return { newText, range };
  return { newText, insert: range.insert, replace: range.replace };
}

export function lspCompletionEditOffsets(
  doc: Text,
  textEdit: LspTextEdit | undefined,
  characterOffset: (text: string, character: number) => number
): { from: number; to: number } | null {
  const range = textEdit?.range ?? textEdit?.replace ?? textEdit?.insert;
  if (!range) return null;
  const offset = (position: LspPosition): number => {
    const line = doc.line(Math.max(1, Math.min(position.line + 1, doc.lines)));
    return line.from + characterOffset(line.text, position.character ?? 0);
  };
  const from = offset(range.start);
  const to = offset(range.end);
  return from <= to ? { from, to } : null;
}

function isEscaped(text: string, index: number): boolean {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor--) slashes++;
  return slashes % 2 === 1;
}

export function fontCompletionValueStart(doc: Text, cursorPosition: number): number | null {
  const line = doc.lineAt(cursorPosition);
  const cursor = cursorPosition - line.from;
  const quotes: number[] = [];
  for (let index = 0; index < cursor; index++) {
    if (line.text[index] === '"' && !isEscaped(line.text, index)) quotes.push(index);
  }
  if (quotes.length % 2 === 0) return null;
  const openingQuote = quotes[quotes.length - 1];
  return /\bfont\s*:\s*$/.test(line.text.slice(0, openingQuote))
    ? line.from + openingQuote + 1
    : null;
}

export function quotedCompletionEditOffsets(
  doc: Text,
  cursorPosition: number,
  insertion: string
): { from: number; to: number } | null {
  const line = doc.lineAt(cursorPosition);
  const cursor = cursorPosition - line.from;
  const quotes: number[] = [];
  for (let index = 0; index < cursor; index++) {
    if (line.text[index] === '"' && !isEscaped(line.text, index)) quotes.push(index);
  }
  let closing = -1;
  let opening = -1;
  if (quotes.length % 2 === 1) {
    opening = quotes[quotes.length - 1];
    for (let index = cursor; index < line.text.length; index++) {
      if (line.text[index] === '"' && !isEscaped(line.text, index)) {
        closing = index;
        break;
      }
    }
  } else if (quotes.length >= 2 && quotes[quotes.length - 1] === cursor - 1) {
    opening = quotes[quotes.length - 2];
    closing = quotes[quotes.length - 1];
  }
  if (opening < 0) return null;
  const replacesOpeningQuote = insertion.startsWith('"');
  const replacesClosingQuote = insertion.endsWith('"');
  return {
    from: line.from + opening + (replacesOpeningQuote ? 0 : 1),
    to: closing >= 0
      ? line.from + closing + (replacesClosingQuote ? 1 : 0)
      : cursorPosition
  };
}

export function fontCompletionEditOffsets(
  doc: Text,
  cursorPosition: number,
  insertion: string
): { from: number; to: number } | null {
  const edit = quotedCompletionEditOffsets(doc, cursorPosition, insertion);
  if (!edit) return null;
  const openingQuote = doc.sliceString(edit.from, edit.from + 1) === '"'
    ? edit.from
    : edit.from - 1;
  if (openingQuote < 0 || doc.sliceString(openingQuote, openingQuote + 1) !== '"') return null;
  const line = doc.lineAt(openingQuote);
  const beforeQuote = doc.sliceString(line.from, openingQuote);
  return /\bfont\s*:\s*$/.test(beforeQuote) ? edit : null;
}

export function completionEditOffsets(
  doc: Text,
  cursorPosition: number,
  insertion: string,
  textEdit: LspTextEdit | undefined,
  characterOffset: (text: string, character: number) => number
): { from: number; to: number } | null {
  return fontCompletionEditOffsets(doc, cursorPosition, insertion)
    ?? lspCompletionEditOffsets(doc, textEdit, characterOffset)
    ?? quotedCompletionEditOffsets(doc, cursorPosition, insertion);
}

export function displayLabelForHashPrefix(label: string, type: string, isHashPrefix: boolean | undefined): string {
  return isHashPrefix
    && !label.startsWith('#')
    && (type === 'function' || type === 'keyword' || type === 'module' || type === 'variable')
    ? `#${label}`
    : label;
}

export function applyTextForHashPrefix(apply: string, type: string, isHashPrefix: boolean | undefined, hasServerEdit: boolean): string {
  if (
    isHashPrefix
    && !hasServerEdit
    && !apply.startsWith('#')
    && (type === 'function' || type === 'keyword' || type === 'module' || type === 'variable')
  ) {
    return `#${apply}`;
  }
  return apply;
}

export const typstSnippets = [
  // Document structure
  snippetCompletion("#set document(title: \"${title}\")\n", { label: "#document", detail: "Document Properties" }),
  snippetCompletion("#set page(margin: ${margin}, paper: \"${paper}\")\n", { label: "#page", detail: "Page setup" }),
  snippetCompletion("#set text(font: \"${font}\", size: ${11pt})\n", { label: "#text", detail: "Text Properties" }),
  snippetCompletion("#set heading(numbering: \"${1.}\")\n", { label: "#heading setup", detail: "Heading Numbering" }),
  snippetCompletion(
    "#block[\n  #set par(\n    justification-limits: (\n      spacing: (min: ${85%}, max: ${115%}),\n      tracking: (min: ${-0.8pt}, max: ${0pt}),\n    ),\n  )\n  ${content}\n]",
    { label: "#par justification limits", detail: "Scoped paragraph justification" }
  ),
  
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

export function allowsLanguageWordCompletionOnLine(lineText: string, wordFrom: number): boolean {
  const beforeWord = lineText.slice(0, Math.max(0, Math.min(wordFrom, lineText.length)));
  if (isInsideTypstCodeString(lineText, wordFrom)) return false;
  const lastHash = beforeWord.lastIndexOf("#");
  if (lastHash === -1) return true;
  const lastOpenContent = beforeWord.lastIndexOf("[");
  const lastCloseContent = beforeWord.lastIndexOf("]");
  return Math.max(lastOpenContent, lastCloseContent) > lastHash;
}

function isInsideTypstCodeString(lineText: string, position: number): boolean {
  const before = lineText.slice(0, Math.max(0, Math.min(position, lineText.length)));
  const quotes: number[] = [];
  for (let index = 0; index < before.length; index++) {
    if (before[index] === '"' && !isEscaped(before, index)) quotes.push(index);
  }
  if (quotes.length % 2 === 0) return false;
  const openQuote = quotes[quotes.length - 1];
  if (before.slice(0, openQuote).includes("#")) return true;
  const after = lineText.slice(position);
  const closeQuote = firstUnescapedQuote(after);
  if (closeQuote === null) return false;
  const afterClose = after.slice(closeQuote + 1).trimStart();
  return /^[),:\]]/.test(afterClose);
}

function firstUnescapedQuote(text: string): number | null {
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '"' && !isEscaped(text, index)) return index;
  }
  return null;
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

export type ProviderCapabilities = LanguageProviderCapabilities;

export function createTypstAutocomplete(
  getClient: () => TinymistLspClient | undefined,
  getUri: () => string,
  flushLspSync: () => void | Promise<void>,
  languageWordCompletion = true,
  getProviders: () => ProviderCapabilities[] = () => []
) {
  return autocompletion({
    override: [
      async (context: CompletionContext) => {
        if (languageWordCompletion) {
          const providers = getProviders();
          for (const provider of providers) {
            if (provider.supportsCompletion !== true) continue;
            const pattern = new RegExp(provider.pattern + "$", "u");
            const word = context.matchBefore(pattern);
            if (word) {
              const line = context.state.doc.lineAt(context.pos);
              if (!allowsLanguageWordCompletionOnLine(line.text, word.from - line.from)) {
                continue;
              }
              try {
                const completion = await invoke<LanguageCompletionResponse | null>("complete_language_word", {
                  request: {
                    provider: provider.id,
                    text: word.text,
                    cursorUtf16: word.text.length,
                    limit: 10
                  }
                });
                const replacement = languageCompletionRange(word.from, word.text.length, completion);
                if (completion && replacement && completion.options.length > 0) {
                  return {
                    from: replacement.from,
                    options: completion.options.map(w => ({
                      label: w,
                      type: "text",
                      detail: completion.provider
                    })),
                    // Results are deliberately bounded and ranked for the current
                    // segmented prefix, so every typed character must query again.
                    validFor: languageCompletionValidFor
                  };
                }
              } catch (e) {
                console.warn(`${provider.id} autocomplete error`, e);
              }
              continue;
            }
          }
        }

        const fontValueFrom = fontCompletionValueStart(context.state.doc, context.pos);
        if (!context.explicit) {
          const lineStr = context.state.doc.lineAt(context.pos).text;
          const col = context.pos - context.state.doc.lineAt(context.pos).from;
          const textBefore = lineStr.slice(0, col);
          
          // Only trigger autocomplete implicitly on word characters or specific trigger characters (#, ., @, -)
          const lastChar = textBefore.slice(-1);
          if (!/[\w#\.@-]/.test(lastChar) && !(lastChar === " " && fontValueFrom !== null)) {
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
        
        try {
          // Force flush any pending LSP document changes so the server completes
          // against the same text CodeMirror is showing.
          await flushLspSync();

          const response = await client.request<LspCompletionResponse>("textDocument/completion", {
            textDocument: { uri },
            position,
            context: {
              triggerKind: 1
            }
          });
          
          if (!response) return typstCompletions(context);
          
          const items = Array.isArray(response) ? response : response.items;
          const itemDefaults = Array.isArray(response) ? undefined : response.itemDefaults;
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
            
            const defaultApply = item.insertText ?? label;
            const textEdit = item.textEdit ?? textEditFromDefault(itemDefaults?.editRange, defaultApply);
            const insertTextFormat = item.insertTextFormat ?? itemDefaults?.insertTextFormat;
            let apply = textEdit?.newText ?? defaultApply;
            
            label = displayLabelForHashPrefix(label, type, isHashPrefix);
            apply = applyTextForHashPrefix(apply, type, isHashPrefix, Boolean(textEdit));
            
            if (insertTextFormat === 2) {
              const completion = snippetCompletion(apply, { label, detail, info, type });
              const snippetApply = completion.apply;
              if (typeof snippetApply !== "function") return completion;
              return {
                ...completion,
                apply(view, selected, from, to) {
                  const edit = completionEditOffsets(
                    view.state.doc,
                    to,
                    apply,
                    textEdit,
                    (text, character) => client.stringOffsetFromLspCharacter(text, character)
                  );
                  snippetApply(view, selected, edit?.from ?? from, edit?.to ?? to);
                }
              };
            }

            return {
              label,
              detail,
              info,
              type,
              sortText: item.sortText,
              apply(view, _selected, from, to) {
                const edit = completionEditOffsets(
                  view.state.doc,
                  to,
                  apply,
                  textEdit,
                  (text, character) => client.stringOffsetFromLspCharacter(text, character)
                );
                const replacement = edit ?? { from, to };
                view.dispatch({
                  changes: { from: replacement.from, to: replacement.to, insert: apply },
                  selection: { anchor: replacement.from + apply.length },
                  userEvent: "input.complete"
                });
              }
            };
          });
          
          return {
            from: fontValueFrom ?? word?.from ?? context.pos,
            options,
            ...(fontValueFrom !== null ? { validFor: /^[^"\r\n]*$/ } : {})
          };
          
        } catch (e) {
          console.warn("LSP completion error", e);
          return typstCompletions(context);
        }
      }
    ]
  });
}
