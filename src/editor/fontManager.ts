import type { EditorView } from "@codemirror/view";
import miSansKhmerRegularUrl from "../assets/fonts/MiSansKhmer-Regular.woff2?url";
import miSansKhmerBoldUrl from "../assets/fonts/MiSansKhmer-Bold.woff2?url";
import { editorFontCompartment } from "./extensions";
import { editorFontTheme } from "./themes";

type EditorFontCandidate = {
  id: string;
  language: string;
  fontFamily: string;
  regularUrl?: string;
  boldUrl?: string;
  restartRequired?: boolean;
};

const systemFontStack = "'DejaVu Sans Mono', ui-monospace, SFMono-Regular, Consolas, 'Liberation Mono', monospace";
const fontRules: Array<EditorFontCandidate & { pattern: RegExp }> = [
  { id: "khmer", language: "Khmer", fontFamily: "MiSans Khmer", regularUrl: miSansKhmerRegularUrl, boldUrl: miSansKhmerBoldUrl, pattern: /[\u1780-\u17FF\u19E0-\u19FF]/ },
  { id: "arabic", language: "Arabic", fontFamily: "MiSans Latin", restartRequired: true, pattern: /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]/ },
  { id: "devanagari", language: "Devanagari", fontFamily: "MiSans Latin", restartRequired: true, pattern: /[\u0900-\u097F]/ },
  { id: "thai", language: "Thai", fontFamily: "MiSans Latin", restartRequired: true, pattern: /[\u0E00-\u0E7F]/ },
  { id: "cyrillic", language: "Cyrillic", fontFamily: "MiSans Latin", pattern: /[\u0400-\u04FF]/ },
  { id: "greek", language: "Greek", fontFamily: "MiSans Latin", pattern: /[\u0370-\u03FF]/ },
  { id: "japanese", language: "Japanese", fontFamily: "MiSans Latin", restartRequired: true, pattern: /[\u3040-\u30FF]/ },
  { id: "korean", language: "Korean", fontFamily: "MiSans Latin", restartRequired: true, pattern: /[\u1100-\u11FF\uAC00-\uD7AF]/ },
  { id: "cjk", language: "CJK", fontFamily: "MiSans Latin", restartRequired: true, pattern: /[\u3400-\u9FFF\uF900-\uFAFF]/ }
];
const fallbackRule: EditorFontCandidate = { id: "unicode", language: "Unicode", fontFamily: "MiSans Latin", restartRequired: true };

export class EditorFontManager {
  private activeCandidate: EditorFontCandidate | null = null;
  private appliedStack = systemFontStack;
  private dismissedCandidateId: string | null = null;
  private readonly loadedFonts = new Set<string>();
  private readonly breadcrumb = document.getElementById("editor-font-breadcrumb")!;
  private readonly text = document.getElementById("editor-font-breadcrumb-text")!;
  private readonly download = document.getElementById("editor-font-download") as HTMLButtonElement;
  private readonly dismiss = document.getElementById("editor-font-dismiss") as HTMLButtonElement;

  constructor(private readonly getEditorView: () => EditorView | undefined) {}

  public initialize(): void {
    this.download.addEventListener("click", () => {
      if (this.activeCandidate) void this.downloadAndApply(this.activeCandidate);
    });
    this.dismiss.addEventListener("click", () => {
      this.dismissedCandidateId = this.activeCandidate?.id ?? null;
      this.hide();
    });
  }

  public updateDocument(text: string): void {
    const candidate = this.detectCandidate(text);
    this.activeCandidate = candidate;
    if (!candidate) {
      this.dismissedCandidateId = null;
      this.hide();
      this.applyStack(systemFontStack);
      return;
    }
    if (this.downloadedIds().has(candidate.id)) {
      const showNotice = this.dismissedCandidateId !== candidate.id;
      void this.downloadAndApply(candidate, true, showNotice);
      if (!showNotice) this.hide();
      return;
    }
    if (this.dismissedCandidateId === candidate.id) {
      this.hide();
      return;
    }
    this.renderPrompt(candidate);
  }

  private detectCandidate(text: string): EditorFontCandidate | null {
    if (!/[^\u0000-\u007F]/.test(text)) return null;
    return fontRules.find(candidate => candidate.pattern.test(text)) ?? fallbackRule;
  }

  private renderPrompt(candidate: EditorFontCandidate): void {
    this.text.textContent = `${candidate.language} text detected. Download ${candidate.fontFamily} for the editor?`;
    this.download.textContent = `Download ${candidate.fontFamily}`;
    this.download.disabled = false;
    this.download.classList.remove("hidden");
    this.breadcrumb.classList.remove("hidden");
  }

  private renderApplied(candidate: EditorFontCandidate): void {
    const restart = candidate.restartRequired
      ? " Restart Typstry if glyphs still render incorrectly."
      : " Restart Typstry if the change does not appear everywhere.";
    this.text.textContent = `${candidate.fontFamily} applied for ${candidate.language}.${restart}`;
    this.download.classList.add("hidden");
    this.breadcrumb.classList.remove("hidden");
  }

  private hide(): void {
    this.breadcrumb.classList.add("hidden");
  }

  private downloadedIds(): Set<string> {
    try {
      const stored: unknown = JSON.parse(localStorage.getItem("typstry-downloaded-editor-fonts") || "[]");
      return new Set(Array.isArray(stored) ? stored.filter((value): value is string => typeof value === "string") : []);
    } catch {
      return new Set();
    }
  }

  private markDownloaded(candidate: EditorFontCandidate): void {
    const downloaded = this.downloadedIds();
    downloaded.add(candidate.id);
    localStorage.setItem("typstry-downloaded-editor-fonts", JSON.stringify([...downloaded]));
  }

  private async downloadAndApply(candidate: EditorFontCandidate, fromCache = false, showNotice = true): Promise<void> {
    if (this.activeCandidate?.id !== candidate.id) return;
    if (!fromCache) {
      this.download.disabled = true;
      this.download.textContent = "Downloading...";
    }
    try {
      await this.load(candidate);
      this.markDownloaded(candidate);
      this.applyStack(`${systemFontStack}, "${candidate.fontFamily}"`, candidate.fontFamily);
      if (!fromCache || showNotice) this.dismissedCandidateId = null;
      if (showNotice) this.renderApplied(candidate);
    } catch (error) {
      this.text.textContent = `Could not load ${candidate.fontFamily}: ${String(error)}`;
      this.download.textContent = `Retry ${candidate.fontFamily}`;
      this.download.disabled = false;
      this.download.classList.remove("hidden");
      this.breadcrumb.classList.remove("hidden");
    }
  }

  private async load(candidate: EditorFontCandidate): Promise<void> {
    if (this.loadedFonts.has(candidate.id)) return;
    if (candidate.regularUrl) {
      const face = new FontFace(candidate.fontFamily, `url(${candidate.regularUrl})`, { weight: "400" });
      document.fonts.add(await face.load());
    } else {
      await document.fonts.load(`14px "${candidate.fontFamily}"`);
    }
    if (candidate.boldUrl) {
      const face = new FontFace(candidate.fontFamily, `url(${candidate.boldUrl})`, { weight: "700" });
      document.fonts.add(await face.load());
    }
    this.loadedFonts.add(candidate.id);
  }

  private applyStack(stack: string, fontFamily: string | null = null): void {
    if (this.appliedStack === stack) return;
    this.appliedStack = stack;
    this.getEditorView()?.dispatch({ effects: editorFontCompartment.reconfigure(editorFontTheme(stack)) });
    if (fontFamily) document.documentElement.style.setProperty("--active-unicode-font", `"${fontFamily}"`);
    else document.documentElement.style.removeProperty("--active-unicode-font");
  }
}
