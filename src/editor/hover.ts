import { hoverTooltip, Tooltip } from "@codemirror/view";
import type { EditorView } from "@codemirror/view";
import type { TinymistLspClient } from "../compiler/lsp";
import { open as openUrl } from "@tauri-apps/plugin-shell";

type MarkupContent = { value?: string };
type HoverResponse = { contents?: string | MarkupContent | Array<string | MarkupContent> } | null;

export function createHoverTooltip(getClient: () => TinymistLspClient | undefined, getUri: () => string) {
  return hoverTooltip(async (view: EditorView, pos: number): Promise<Tooltip | null> => {
    const client = getClient();
    const uri = getUri();
    
    if (!client || !uri) return null;
    if (!shouldRequestTypstHover(view, pos)) return null;

    const doc = view.state.doc;
    const lspPos = client.lspPositionFromEditorPosition(doc, pos);

    try {
      const hoverData = await client.request<HoverResponse>("textDocument/hover", {
        textDocument: { uri },
        position: lspPos
      });

      if (!hoverData || !hoverData.contents) return null;

      let markdown = "";
      if (typeof hoverData.contents === "string") {
        markdown = hoverData.contents;
      } else if (!Array.isArray(hoverData.contents) && hoverData.contents.value) {
        markdown = hoverData.contents.value;
      } else if (Array.isArray(hoverData.contents)) {
        markdown = hoverData.contents.map(content => typeof content === "string" ? content : content.value ?? "").join("\n\n");
      }

      if (!markdown) return null;

      // Create a markdown rendering node
      const dom = document.createElement("div");
      dom.className = "typst-hover-tooltip";
      dom.style.padding = "8px";
      dom.style.maxWidth = "450px";
      dom.style.fontSize = "13px";
      dom.style.whiteSpace = "normal";
      dom.style.wordBreak = "break-word";
      dom.style.fontFamily = "var(--ui-font, sans-serif)";
      
      dom.innerHTML = parseMarkdown(markdown);

      // Intercept link clicks and open in the default system browser
      dom.addEventListener("click", (e) => {
        const target = e.target as HTMLElement;
        if (target.tagName === "A" && target.classList.contains("hover-link")) {
          e.preventDefault();
          const href = target.getAttribute("href");
          if (href) {
            void openUrl(href);
          }
        }
      });

      return {
        pos,
        create() {
          return { dom };
        }
      };
    } catch (e) {
      return null;
    }
  });
}

function shouldRequestTypstHover(view: EditorView, pos: number): boolean {
  const line = view.state.doc.lineAt(pos);
  const offset = Math.max(0, Math.min(pos - line.from, line.length));
  const token = typstIdentifierAt(line.text, offset);
  if (!token) return false;

  if (token.hashPrefixed) return true;
  if (!/^[A-Za-z_][\w.-]*$/.test(token.text)) return false;
  if (isFunctionCallLike(line.text, token.to)) return true;

  return isInsideTypstCodeExpression(line.text, token.from);
}

function typstIdentifierAt(lineText: string, offset: number): { from: number; to: number; text: string; hashPrefixed: boolean } | null {
  if (lineText[offset] === "#") {
    const from = offset + 1;
    const to = scanIdentifierEnd(lineText, from);
    const text = lineText.slice(from, to);
    return text ? { from, to, text, hashPrefixed: true } : null;
  }

  let from = offset;
  if (from > 0 && !isIdentifierChar(lineText[from]) && isIdentifierChar(lineText[from - 1])) {
    from--;
  }

  if (!isIdentifierChar(lineText[from])) return null;

  while (from > 0 && isIdentifierChar(lineText[from - 1])) from--;
  const to = scanIdentifierEnd(lineText, from);
  const text = lineText.slice(from, to);
  const hashPrefixed = from > 0 && lineText[from - 1] === "#" && !isEscaped(lineText, from - 1);

  return text ? { from, to, text, hashPrefixed } : null;
}

function scanIdentifierEnd(text: string, from: number): number {
  let to = from;
  while (to < text.length && isIdentifierChar(text[to])) to++;
  return to;
}

function isIdentifierChar(char: string | undefined): boolean {
  return !!char && /[A-Za-z0-9_.-]/.test(char);
}

function isFunctionCallLike(lineText: string, tokenEnd: number): boolean {
  let cursor = tokenEnd;
  while (cursor < lineText.length && /\s/.test(lineText[cursor])) cursor++;
  return lineText[cursor] === "(" || lineText[cursor] === "[";
}

function isInsideTypstCodeExpression(lineText: string, tokenStart: number): boolean {
  const hashIndex = findNearestUnescapedHash(lineText, tokenStart);
  if (hashIndex < 0) return false;

  const expressionPrefix = lineText.slice(hashIndex + 1, tokenStart);
  const state = scanTypstExpressionPrefix(expressionPrefix);
  if (state.inString || state.lineComment) return false;

  const trimmedPrefix = expressionPrefix.trimStart();
  const startsCodeLine = /^(?:let|set|show|import|include|if|else|for|while|return|break|continue)\b/.test(trimmedPrefix);
  const insideCodeDelimiter = state.parenDepth > 0 || state.braceDepth > 0;

  if (state.bracketDepth > 0 && !insideCodeDelimiter) return false;
  return startsCodeLine || insideCodeDelimiter;
}

function findNearestUnescapedHash(text: string, before: number): number {
  for (let index = before - 1; index >= 0; index--) {
    if (text[index] === "#" && !isEscaped(text, index)) return index;
  }
  return -1;
}

function isEscaped(text: string, index: number): boolean {
  let slashCount = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor--) {
    slashCount++;
  }
  return slashCount % 2 === 1;
}

function scanTypstExpressionPrefix(text: string): {
  parenDepth: number;
  braceDepth: number;
  bracketDepth: number;
  inString: boolean;
  lineComment: boolean;
} {
  let parenDepth = 0;
  let braceDepth = 0;
  let bracketDepth = 0;
  let inString = false;
  let lineComment = false;

  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    const next = text[index + 1];

    if (lineComment) break;

    if (inString) {
      if (char === "\"" && !isEscaped(text, index)) inString = false;
      continue;
    }

    if (char === "/" && next === "/") {
      lineComment = true;
      break;
    }

    if (char === "\"" && !isEscaped(text, index)) {
      inString = true;
      continue;
    }

    if (char === "(") parenDepth++;
    if (char === ")") parenDepth = Math.max(0, parenDepth - 1);
    if (char === "{") braceDepth++;
    if (char === "}") braceDepth = Math.max(0, braceDepth - 1);
    if (char === "[") bracketDepth++;
    if (char === "]") bracketDepth = Math.max(0, bracketDepth - 1);
  }

  return { parenDepth, braceDepth, bracketDepth, inString, lineComment };
}

function parseMarkdown(md: string): string {
  const lines = md.split(/\r?\n/);
  let html = "";
  let inCodeBlock = false;
  let codeBlockContent: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Handle code block toggle
    if (line.trim().startsWith("```")) {
      if (inCodeBlock) {
        // End of code block
        inCodeBlock = false;
        const codeText = escapeHtml(codeBlockContent.join("\n"));
        html += `<pre style="background: var(--ui-hover); border: 1px solid var(--ui-border); padding: 6px 10px; border-radius: 4px; margin: 6px 0; overflow-x: auto; font-family: monospace; font-size: 12px; line-height: 1.4; white-space: pre; color: var(--ui-text);">${codeText}</pre>`;
        codeBlockContent = [];
      } else {
        // Start of code block
        inCodeBlock = true;
      }
      continue;
    }

    if (inCodeBlock) {
      codeBlockContent.push(line);
      continue;
    }

    const trimmed = line.trim();

    // Handle horizontal rules
    if (trimmed === "---") {
      html += '<hr style="border: 0; border-top: 1px solid var(--ui-border); margin: 12px 0;" />';
      continue;
    }

    // Handle headings
    if (trimmed.startsWith("# ")) {
      const text = parseInlineStyles(trimmed.slice(2));
      html += `<h1 style="font-size: 14px; font-weight: bold; margin: 14px 0 6px 0; border-bottom: 1px solid var(--ui-border); padding-bottom: 3px; font-family: var(--ui-font, sans-serif); color: var(--ui-text);">${text}</h1>`;
      continue;
    }
    if (trimmed.startsWith("## ")) {
      const text = parseInlineStyles(trimmed.slice(3));
      html += `<h2 style="font-size: 13px; font-weight: bold; margin: 12px 0 4px 0; color: var(--ui-header-text); font-family: var(--ui-font, sans-serif);">${text}</h2>`;
      continue;
    }
    if (trimmed.startsWith("### ")) {
      const text = parseInlineStyles(trimmed.slice(4));
      html += `<h3 style="font-size: 12px; font-weight: bold; margin: 10px 0 4px 0; color: var(--ui-text); font-family: var(--ui-font, sans-serif);">${text}</h3>`;
      continue;
    }

    // Handle lists
    if (trimmed.startsWith("- ")) {
      const text = parseInlineStyles(trimmed.slice(2));
      html += `<div style="margin-left: 12px; margin-bottom: 4px; display: list-item; list-style-type: disc; font-family: var(--ui-font, sans-serif); color: var(--ui-text);">${text}</div>`;
      continue;
    }

    // Handle empty line (adds vertical spacing)
    if (trimmed === "") {
      html += '<div style="height: 6px;"></div>';
      continue;
    }

    // Normal paragraph text
    const parsedText = parseInlineStyles(line);
    html += `<p style="margin: 0 0 6px 0; line-height: 1.5; font-family: var(--ui-font, sans-serif); color: var(--ui-text);">${parsedText}</p>`;
  }

  if (inCodeBlock && codeBlockContent.length > 0) {
    const codeText = escapeHtml(codeBlockContent.join("\n"));
    html += `<pre style="background: var(--ui-hover); border: 1px solid var(--ui-border); padding: 6px 10px; border-radius: 4px; margin: 6px 0; overflow-x: auto; font-family: monospace; font-size: 12px; line-height: 1.4; white-space: pre; color: var(--ui-text);">${codeText}</pre>`;
  }

  return html;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function parseInlineStyles(text: string): string {
  // First escape HTML in the inline text
  let result = escapeHtml(text);

  // Parse inline code: `code`
  result = result.replace(/`([^`\n]+)`/g, '<code style="background: var(--ui-hover); border: 1px solid var(--ui-border); padding: 1px 4px; border-radius: 3px; font-family: monospace; font-size: 12px; color: var(--ui-text);">$1</code>');

  // Parse links: [text](url)
  result = result.replace(/\[([^\]\n]+)\]\(([^)\n]+)\)/g, '<a href="$2" class="hover-link">$1</a>');

  // Parse bold: **text**
  result = result.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

  // Parse italic: *text*
  result = result.replace(/\*([^*]+)\*/g, '<em>$1</em>');

  return result;
}
