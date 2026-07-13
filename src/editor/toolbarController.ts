import { EditorSelection } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { undo, redo } from "@codemirror/commands";
import { openSearchPanel } from "@codemirror/search";
import { invoke } from "@tauri-apps/api/core";
import {
  detectDocumentScript,
  documentScripts,
  parseTypographyBlock,
  preferredInstalledFamily,
  type DocumentTypography
} from "./documentTypography";

type EditorMode = "CODE" | "WYSIWYM";
const typographyChoiceStorageKey = "typsastra-last-document-typography";

export type EditorToolbarDependencies = {
  getMode: () => EditorMode;
  getEditor: () => EditorView;
  wysiwymContainer: HTMLElement;
  serializeWysiwym: () => string;
  renderWysiwym: (markup: string) => void;
  save: () => Promise<void>;
  syncPreview: (cursor: number) => Promise<void>;
  applyTypography: (config: DocumentTypography, target: "document" | "template") => Promise<void>;
  // TODO: Re-enable when the WYSIWYM layout is ready for use.
  // toggleMode: () => void;
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
  private systemFontFamilies: string[] = ["MiSans Latin", "Fira Mono"];
  private scriptFontFamilies: Record<string, string[]> = {};
  private typographyDefaults: DocumentTypography = {
    latinFont: "MiSans Latin",
    latinSizePt: 11,
    complexFont: "MiSans Latin",
    complexScript: "khmer",
    complexScale: 1
  };
  private rememberedTypography: DocumentTypography | null = null;

  constructor(private readonly dependencies: EditorToolbarDependencies) {}

  public initialize(): void {
    void this.initializeTypographyControls();
    document.getElementById("toolbar-typography-apply")?.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      this.applyDocumentTypography("document");
    });
    document.getElementById("toolbar-typography-apply-template")?.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      this.applyDocumentTypography("template");
    });
    document.getElementById("toolbar-complex-script")?.addEventListener("change", event => {
      const scriptId = (event.currentTarget as HTMLSelectElement).value;
      this.populateComplexFontOptions(scriptId);
      this.updateScriptHint(scriptId, null);
      this.updateTypographyAvailability();
    });
    document.getElementById("toolbar-latin-font")?.addEventListener("change", () => this.updateTypographyAvailability());
    document.getElementById("toolbar-complex-font")?.addEventListener("change", () => this.updateTypographyAvailability());
    document.getElementById("toolbar-latin-enable")?.addEventListener("change", () => this.updateTypographyAvailability());
    document.getElementById("toolbar-complex-enable")?.addEventListener("change", () => this.updateTypographyAvailability());
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
          if (container.classList.contains("toolbar-typography-container")) this.syncTypographyControls();
          this.closeDropdowns(container);
          container.classList.toggle("active");
          event.stopPropagation();
        }
        return;
      }
      const typographyPanel = target.closest(".toolbar-typography-panel");
      if (typographyPanel) {
        event.stopPropagation();
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

  private async initializeTypographyControls(): Promise<void> {
    this.rememberedTypography = this.loadRememberedTypography();
    this.populateScriptOptions();
    try {
      const catalog = await invoke<{ all: string[]; scripts: Record<string, string[]> }>("list_system_fonts");
      this.systemFontFamilies = [...new Set(catalog.all)].sort((left, right) => left.localeCompare(right));
      this.scriptFontFamilies = catalog.scripts ?? {};
    } catch (error) {
      console.warn("Unable to load document font families.", error);
    }
    this.populateDocumentFontOptions();
    this.syncTypographyControls();
  }

  private populateScriptOptions(): void {
    const select = document.getElementById("toolbar-complex-script") as HTMLSelectElement | null;
    if (!select) return;
    select.replaceChildren(...documentScripts.map(script => {
      const option = document.createElement("option");
      option.value = script.id;
      option.textContent = script.label;
      return option;
    }));
  }

  private populateDocumentFontOptions(): void {
    const latin = document.getElementById("toolbar-latin-font") as HTMLSelectElement | null;
    if (latin) latin.replaceChildren(
      this.emptyFontOption("Do not set Latin font"),
      ...this.fontOptions(this.systemFontFamilies)
    );
    const script = (document.getElementById("toolbar-complex-script") as HTMLSelectElement | null)?.value ?? documentScripts[0].id;
    this.populateComplexFontOptions(script, this.typographyDefaults.complexFont);
  }

  private emptyFontOption(label: string): HTMLOptionElement {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = label;
    return option;
  }

  private fontOptions(families: readonly string[]): HTMLOptionElement[] {
    return families.map(family => {
      const option = document.createElement("option");
      option.value = family;
      option.textContent = family;
      return option;
    });
  }

  private populateComplexFontOptions(scriptId: string, preferredFont?: string | null): string[] {
    const select = document.getElementById("toolbar-complex-font") as HTMLSelectElement | null;
    const supported = [...new Set(this.scriptFontFamilies[scriptId] ?? [])]
      .sort((left, right) => left.localeCompare(right));
    if (!select) return supported;
    const previous = preferredFont === null ? "" : preferredFont ?? select.value;
    select.replaceChildren(
      this.emptyFontOption(supported.length > 0 ? "Do not set complex-script font" : "No compatible installed font"),
      ...this.fontOptions(supported)
    );
    const next = previous === ""
      ? ""
      : supported.find(family => family === previous)
        ?? preferredInstalledFamily(documentScripts.find(script => script.id === scriptId) ?? documentScripts[0], supported)
        ?? supported[0]
        ?? "";
    if (next) {
      select.value = next;
    } else {
      select.value = "";
    }
    select.disabled = false;
    this.updateTypographyAvailability();
    return supported;
  }

  private syncTypographyControls(): void {
    const text = this.dependencies.getEditor().state.doc.toString();
    const existing = parseTypographyBlock(text);
    const preferred = existing ?? this.rememberedTypography;
    const detected = detectDocumentScript(text);
    const script = preferred
      ? documentScripts.find(candidate => candidate.id === preferred.complexScript) ?? detected ?? documentScripts[0]
      : detected ?? documentScripts[0];
    const defaultLatinFont = this.systemFontFamilies.find(family => family === "Calibri")
      ?? this.systemFontFamilies.find(family => family === "MiSans Latin")
      ?? this.systemFontFamilies[0]
      ?? null;
    const latinFont = preferred ? preferred.latinFont : defaultLatinFont;
    const preferredComplexFont = preferred
      ? preferred.complexFont
      : preferredInstalledFamily(script, this.scriptFontFamilies[script.id] ?? []);
    const supportedFonts = this.populateComplexFontOptions(script.id, preferredComplexFont);
    const complexFont = preferredComplexFont === null
      ? null
      : supportedFonts.find(family => family === preferredComplexFont)
        ?? preferredInstalledFamily(script, supportedFonts)
        ?? supportedFonts[0]
        ?? null;
    this.typographyDefaults = {
      latinFont,
      latinSizePt: preferred?.latinSizePt ?? 11,
      complexFont,
      complexScript: script.id,
      complexScale: preferred?.complexScale ?? 1
    };
    const latinEnable = document.getElementById("toolbar-latin-enable") as HTMLInputElement | null;
    if (latinEnable) {
      latinEnable.checked = preferred ? preferred.latinFont !== null : true;
    }
    const complexEnable = document.getElementById("toolbar-complex-enable") as HTMLInputElement | null;
    if (complexEnable) {
      complexEnable.checked = preferred ? preferred.complexFont !== null : true;
    }
    this.setTypographyControl("toolbar-latin-font", latinFont ?? "");
    this.setTypographyControl("toolbar-latin-size", String(this.typographyDefaults.latinSizePt));
    this.setTypographyControl("toolbar-complex-script", script.id);
    this.setTypographyControl("toolbar-complex-font", complexFont ?? "");
    this.setTypographyControl("toolbar-complex-adjustment", String(this.typographyDefaults.complexScale));
    this.updateScriptHint(script.id, detected?.id === script.id ? detected.label : null);
    this.updateTypographyAvailability();
  }

  private updateTypographyAvailability(): void {
    const latinEnable = document.getElementById("toolbar-latin-enable") as HTMLInputElement | null;
    const complexEnable = document.getElementById("toolbar-complex-enable") as HTMLInputElement | null;

    const latin = document.getElementById("toolbar-latin-font") as HTMLSelectElement | null;
    const complex = document.getElementById("toolbar-complex-font") as HTMLSelectElement | null;
    const latinSize = document.getElementById("toolbar-latin-size") as HTMLInputElement | null;
    const complexScript = document.getElementById("toolbar-complex-script") as HTMLSelectElement | null;
    const complexAdjustment = document.getElementById("toolbar-complex-adjustment") as HTMLInputElement | null;
    const apply = document.getElementById("toolbar-typography-apply") as HTMLButtonElement | null;
    const applyTemplate = document.getElementById("toolbar-typography-apply-template") as HTMLButtonElement | null;

    const isLatinEnabled = latinEnable?.checked ?? true;
    const isComplexEnabled = complexEnable?.checked ?? true;

    if (latin) latin.disabled = !isLatinEnabled;
    if (latinSize) latinSize.disabled = !isLatinEnabled || !latin?.value;

    if (complexScript) complexScript.disabled = !isComplexEnabled;
    if (complex) complex.disabled = !isComplexEnabled;
    if (complexAdjustment) complexAdjustment.disabled = !isComplexEnabled || !complex?.value;

    if (apply) {
      const hasLatin = isLatinEnabled && !!latin?.value;
      const hasComplex = isComplexEnabled && !!complex?.value;
      apply.disabled = !hasLatin && !hasComplex;
      if (applyTemplate) applyTemplate.disabled = apply.disabled;
    }
  }

  private updateScriptHint(scriptId: string, detectedLabel: string | null): void {
    const hint = document.getElementById("toolbar-complex-script-hint");
    if (!hint) return;
    const count = this.scriptFontFamilies[scriptId]?.length ?? 0;
    const prefix = detectedLabel ? `Detected ${detectedLabel}. ` : "";
    hint.textContent = count > 0
      ? `${prefix}${count} compatible installed font${count === 1 ? "" : "s"}.`
      : `${prefix}No installed font provides the required glyph coverage.`;
  }

  private setTypographyControl(id: string, value: string): void {
    const control = document.getElementById(id) as HTMLInputElement | HTMLSelectElement | null;
    if (!control) return;
    if (control instanceof HTMLSelectElement && ![...control.options].some(option => option.value === value)) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = value;
      control.appendChild(option);
    }
    control.value = value;
  }

  private applyDocumentTypography(target: "document" | "template"): void {
    const value = (id: string) => (document.getElementById(id) as HTMLInputElement | HTMLSelectElement | null)?.value ?? "";
    const latinEnable = document.getElementById("toolbar-latin-enable") as HTMLInputElement | null;
    const complexEnable = document.getElementById("toolbar-complex-enable") as HTMLInputElement | null;
    const isLatinEnabled = latinEnable?.checked ?? true;
    const isComplexEnabled = complexEnable?.checked ?? true;

    const latinFont = isLatinEnabled ? (value("toolbar-latin-font") || null) : null;
    const complexFont = isComplexEnabled ? (value("toolbar-complex-font") || null) : null;
    if (!latinFont && !complexFont) return;
    const config: DocumentTypography = {
      latinFont,
      latinSizePt: this.boundedTypographyNumber(value("toolbar-latin-size"), 6, 96, this.typographyDefaults.latinSizePt),
      complexFont,
      complexScript: value("toolbar-complex-script") || this.typographyDefaults.complexScript,
      complexScale: this.boundedTypographyNumber(value("toolbar-complex-adjustment"), 0.5, 2, 1)
    };
    void this.dependencies.applyTypography(config, target);
    this.typographyDefaults = config;
    this.rememberedTypography = config;
    this.saveRememberedTypography(config);
    this.closeDropdowns();
  }

  private loadRememberedTypography(): DocumentTypography | null {
    try {
      const value: unknown = JSON.parse(localStorage.getItem(typographyChoiceStorageKey) ?? "null");
      if (!value || typeof value !== "object") return null;
      const candidate = value as Partial<DocumentTypography>;
      const validFont = (font: unknown): font is string | null => font === null || typeof font === "string";
      if (
        !validFont(candidate.latinFont)
        || !validFont(candidate.complexFont)
        || typeof candidate.latinSizePt !== "number"
        || !Number.isFinite(candidate.latinSizePt)
        || typeof candidate.complexScale !== "number"
        || !Number.isFinite(candidate.complexScale)
        || typeof candidate.complexScript !== "string"
        || !documentScripts.some(script => script.id === candidate.complexScript)
      ) return null;
      return {
        latinFont: candidate.latinFont,
        latinSizePt: this.boundedTypographyNumber(String(candidate.latinSizePt), 6, 96, 11),
        complexFont: candidate.complexFont,
        complexScript: candidate.complexScript,
        complexScale: this.boundedTypographyNumber(String(candidate.complexScale), 0.5, 2, 1)
      };
    } catch {
      return null;
    }
  }

  private saveRememberedTypography(config: DocumentTypography): void {
    try {
      localStorage.setItem(typographyChoiceStorageKey, JSON.stringify(config));
    } catch {
      // Typography application should still work when browser storage is unavailable.
    }
  }

  private boundedTypographyNumber(value: string, min: number, max: number, fallback: number): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
  }

  private closeDropdowns(except?: Element): void {
    this.toolbar.querySelectorAll(".toolbar-dropdown-container.active").forEach(element => {
      if (element !== except) element.classList.remove("active");
    });
  }

  private async run(tool: string): Promise<void> {
    if (this.dependencies.getMode() === "WYSIWYM") {
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
      case "toggle-special-chars": document.getElementById("zws-toggle")?.click(); break;
      // TODO: Re-enable when the WYSIWYM layout is ready for use.
      // case "toggle-mode": this.dependencies.toggleMode(); break;
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

  public setDisabled(disabled: boolean): void {
    if (disabled) {
      this.toolbar.classList.add("disabled");
      this.toolbar.querySelectorAll("button, select, input").forEach(el => {
        el.setAttribute("disabled", "true");
      });
    } else {
      this.toolbar.classList.remove("disabled");
      this.toolbar.querySelectorAll("button, select, input").forEach(el => {
        el.removeAttribute("disabled");
      });
      this.updateTypographyAvailability();
    }
  }
}
