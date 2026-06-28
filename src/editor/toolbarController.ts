import { EditorSelection } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { undo, redo } from "@codemirror/commands";
import { openSearchPanel } from "@codemirror/search";

type EditorMode = "CODE" | "WYSIWYM";

export type EditorToolbarDependencies = {
  getMode: () => EditorMode;
  getEditor: () => EditorView;
  wysiwymContainer: HTMLElement;
  serializeWysiwym: () => string;
  renderWysiwym: (markup: string) => void;
  save: () => Promise<void>;
  syncPreview: (cursor: number) => Promise<void>;
  toggleMode: () => void;
};

const snippets: Record<string, string> = {
  table: "#table(\n  columns: 3,\n  [Header 1], [Header 2], [Header 3],\n  [Cell 1], [Cell 2], [Cell 3],\n)\n",
  figure: '#figure(\n  image("image.png", width: 80%),\n  caption: [Caption],\n)\n',
  bibliography: '#bibliography("refs.bib")\n',
  "math-block": "$\n  x = frac(-b plus.minus sqrt(b^2 - 4 a c), 2 a)\n$\n",
  outline: "#outline()\n",
  pagebreak: "#pagebreak()\n"
};

const wrappers: Record<string, [string, string, string]> = {
  bold: ["#strong[", "]", "strong text"],
  italic: ["#emph[", "]", "emphasized text"],
  underline: ["#underline[", "]", "text"],
  strikethrough: ["#strike[", "]", "text"],
  highlight: ["#highlight[", "]", "text"],
  "inline-code": ["`", "`", "code"],
  "code-block": ["```typst\n", "\n```", "code"],
  blockquote: ["#quote(block: true)[\n  ", "\n]", "quote"],
  link: ['#link("https://example.com")[', "]", "link text"],
  footnote: ["#footnote[", "]", "note"],
  label: ["<", ">", "label"],
  reference: ["@", "", "label"],
  "inline-math": ["$", "$", "x"],
  subscript: ["_", "", "sub"],
  superscript: ["^", "", "sup"],
  "align-center": ["#align(center)[\n  ", "\n]", "content"],
  "align-right": ["#align(right)[\n  ", "\n]", "content"]
};

export class EditorToolbarController {
  private readonly toolbar = document.getElementById("editor-visual-toolbar")!;

  constructor(private readonly dependencies: EditorToolbarDependencies) {}

  public initialize(): void {
    this.toolbar.addEventListener("pointerdown", event => {
      const target = event.target as HTMLElement;
      if (target.closest("[data-tool]") || target.closest(".toolbar-dropdown-btn")) event.preventDefault();
    });
    this.toolbar.addEventListener("click", event => {
      const target = event.target as HTMLElement;
      const dropdownButton = target.closest(".toolbar-dropdown-btn");
      if (dropdownButton) {
        const container = dropdownButton.closest(".toolbar-dropdown-container");
        if (container) {
          this.closeDropdowns(container);
          container.classList.toggle("active");
          event.stopPropagation();
        }
        return;
      }
      const button = target.closest<HTMLElement>("[data-tool]");
      this.closeDropdowns();
      if (button) void this.run(button.dataset.tool ?? "");
    });
    document.addEventListener("click", event => {
      if (!this.toolbar.contains(event.target as Node)) this.closeDropdowns();
    });
  }

  private closeDropdowns(except?: Element): void {
    this.toolbar.querySelectorAll(".toolbar-dropdown-container.active").forEach(element => {
      if (element !== except) element.classList.remove("active");
    });
  }

  private async run(tool: string): Promise<void> {
    if (this.dependencies.getMode() === "WYSIWYM" && tool !== "toggle-mode") {
      this.applyWysiwymTool(tool);
      const markup = this.dependencies.serializeWysiwym();
      const editor = this.dependencies.getEditor();
      editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: markup } });
      this.dependencies.renderWysiwym(markup);
      return;
    }

    const editor = this.dependencies.getEditor();
    if (wrappers[tool]) {
      this.wrapSelection(...wrappers[tool]);
      return;
    }
    if (snippets[tool]) {
      this.insertSnippet(snippets[tool]);
      return;
    }

    switch (tool) {
      case "save": await this.dependencies.save(); break;
      case "undo": undo(editor); break;
      case "redo": redo(editor); break;
      case "find-replace": openSearchPanel(editor); break;
      case "heading-1": this.applyHeading(1); break;
      case "heading-2": this.applyHeading(2); break;
      case "heading-3": this.applyHeading(3); break;
      case "bullet-list": this.applyLinePrefix("- "); break;
      case "numbered-list": this.applyLinePrefix("+ "); break;
      case "fraction": this.insertSnippet("$frac(1, 2)$", 6, 7); break;
      case "sqrt": this.insertSnippet("$sqrt(x)$", 6, 7); break;
      case "sync-preview":
        await this.dependencies.syncPreview(editor.state.selection.main.head);
        editor.focus();
        break;
      case "export-pdf": document.getElementById("action-export-pdf")?.click(); break;
      case "toggle-wrap": document.getElementById("word-wrap-toggle")?.click(); break;
      case "toggle-mode": this.dependencies.toggleMode(); break;
    }
  }

  private applyWysiwymTool(tool: string): void {
    const selection = window.getSelection();
    const container = this.dependencies.wysiwymContainer;
    let selectedBlock: HTMLElement | null = null;
    if (selection?.rangeCount && container.contains(selection.anchorNode)) {
      const range = selection.getRangeAt(0);
      const anchor = selection.anchorNode!;
      const parent = (anchor.nodeType === Node.TEXT_NODE ? anchor.parentElement : anchor) as HTMLElement;
      selectedBlock = parent?.closest<HTMLElement>(".wysiwym-block") ?? null;
      const inlineWrappers: Record<string, [string, string, string]> = {
        bold: ["*", "*", "strong text"], italic: ["_", "_", "emphasized text"],
        underline: ["#underline[", "]", "text"], strikethrough: ["#strike[", "]", "text"],
        highlight: ["#highlight[", "]", "text"], "inline-code": ["`", "`", "code"],
        footnote: ["#footnote[", "]", "note"], label: ["<", ">", "label"], reference: ["@", "", "label"],
        "inline-math": ["$", "$", "x"], subscript: ["_", "", "sub"], superscript: ["^", "", "sup"]
      };
      if (inlineWrappers[tool]) {
        const [prefix, suffix, placeholder] = inlineWrappers[tool];
        const existing = this.findFormattingAncestor(anchor, `wysiwym-${tool}`, container);
        if (existing) this.unwrapFormatting(existing);
        else {
          const node = document.createTextNode(`${prefix}${range.toString() || placeholder}${suffix}`);
          range.deleteContents();
          range.insertNode(node);
        }
      } else if (selectedBlock) {
        this.applyWysiwymBlockTool(selectedBlock, tool);
      }
    }

    if (snippets[tool]) {
      const block = document.createElement("div");
      block.className = "wysiwym-block body";
      block.innerText = snippets[tool];
      if (selectedBlock?.parentNode) selectedBlock.parentNode.insertBefore(block, selectedBlock.nextSibling);
      else container.appendChild(block);
    }
  }

  private applyWysiwymBlockTool(block: HTMLElement, tool: string): void {
    const container = this.dependencies.wysiwymContainer;
    container.classList.add("serialize-mode");
    const text = block.innerText;
    container.classList.remove("serialize-mode");
    if (tool.startsWith("heading-")) {
      const level = Number(tool.split("-")[1]);
      const sameLevel = new RegExp(`^={${level}}\\s+`).test(text);
      block.innerText = sameLevel ? text.replace(/^=+\s*/, "") : `${"=".repeat(level)} ${text.replace(/^=+\s*/, "")}`;
    } else if (tool === "bullet-list") {
      block.innerText = text.startsWith("- ") ? text.replace(/^- \s*/, "") : `- ${text.replace(/^[-+]\s*/, "")}`;
    } else if (tool === "numbered-list") {
      block.innerText = text.startsWith("+ ") ? text.replace(/^\+ \s*/, "") : `+ ${text.replace(/^[-+]\s*/, "")}`;
    } else {
      const blocks: Record<string, [string, number]> = {
        "align-center": ["#align(center)[", 16], "align-right": ["#align(right)[", 15], blockquote: ["#quote(block: true)[", 21]
      };
      const wrapper = blocks[tool];
      if (wrapper) {
        const [prefix, contentStart] = wrapper;
        block.innerText = text.startsWith(`${prefix}\n`) && text.endsWith("\n]")
          ? text.substring(contentStart, text.length - 2).trim()
          : `${prefix}\n  ${text}\n]`;
      }
    }
  }

  private findFormattingAncestor(node: Node, className: string, boundary: HTMLElement): HTMLElement | null {
    let current: Node | null = node;
    while (current && current !== boundary) {
      if (current.nodeType === Node.ELEMENT_NODE && (current as HTMLElement).classList.contains(className)) return current as HTMLElement;
      current = current.parentNode;
    }
    return null;
  }

  private unwrapFormatting(element: HTMLElement): void {
    for (const sibling of [element.previousSibling, element.nextSibling]) {
      if (sibling?.nodeType === Node.ELEMENT_NODE && (sibling as HTMLElement).classList.contains("wysiwym-marker")) sibling.remove();
    }
    const parent = element.parentNode;
    if (!parent) return;
    while (element.firstChild) parent.insertBefore(element.firstChild, element);
    element.remove();
  }

  private wrapSelection(prefix: string, suffix: string, placeholder: string): void {
    const editor = this.dependencies.getEditor();
    const state = editor.state;
    const transaction = state.changeByRange(range => {
      const selectedText = state.sliceDoc(range.from, range.to) || placeholder;
      const selectionFrom = range.from + prefix.length;
      return {
        changes: { from: range.from, to: range.to, insert: `${prefix}${selectedText}${suffix}` },
        range: EditorSelection.range(selectionFrom, selectionFrom + selectedText.length)
      };
    });
    editor.dispatch(transaction, { scrollIntoView: true, userEvent: "input" });
    editor.focus();
  }

  private insertSnippet(snippet: string, selectFrom?: number, selectTo?: number): void {
    const editor = this.dependencies.getEditor();
    const range = editor.state.selection.main;
    const selectionFrom = range.from + (selectFrom ?? snippet.length);
    editor.dispatch({
      changes: { from: range.from, to: range.to, insert: snippet },
      selection: { anchor: selectionFrom, head: range.from + (selectTo ?? selectFrom ?? snippet.length) },
      scrollIntoView: true,
      userEvent: "input"
    });
    editor.focus();
  }

  private applyHeading(level: number): void {
    const editor = this.dependencies.getEditor();
    const selection = editor.state.selection.main;
    const line = editor.state.doc.lineAt(selection.from);
    const prefix = `${"=".repeat(level)} `;
    const text = line.text.replace(/^=+\s*/, "");
    editor.dispatch({
      changes: { from: line.from, to: line.to, insert: `${prefix}${text}` },
      selection: { anchor: line.from + prefix.length, head: line.from + prefix.length + text.length },
      scrollIntoView: true,
      userEvent: "input"
    });
    editor.focus();
  }

  private applyLinePrefix(prefix: string): void {
    const editor = this.dependencies.getEditor();
    const selection = editor.state.selection.main;
    const start = editor.state.doc.lineAt(selection.from);
    const end = editor.state.doc.lineAt(selection.to > selection.from ? selection.to - 1 : selection.to);
    const changes = [];
    for (let lineNumber = start.number; lineNumber <= end.number; lineNumber++) {
      changes.push({ from: editor.state.doc.line(lineNumber).from, insert: prefix });
    }
    editor.dispatch({ changes, scrollIntoView: true, userEvent: "input" });
    editor.focus();
  }
}
