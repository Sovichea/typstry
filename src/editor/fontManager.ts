import type { EditorView } from "@codemirror/view";
import miSansKhmerRegularUrl from "../assets/fonts/MiSansKhmer-Regular.woff2?url";
import miSansKhmerBoldUrl from "../assets/fonts/MiSansKhmer-Bold.woff2?url";
import { editorFontCompartment } from "./extensions";
import {
  codeEditorFontStack,
  detectUnicodeEditorFont,
  unicodeEditorFonts,
  type CodeEditorFontId,
  type UnicodeEditorFontId,
  type UnicodeFontPreference
} from "./fontCatalog";
import { editorFontTheme } from "./themes";

type UnicodeFontCandidate = typeof unicodeEditorFonts[number];
type FontSource = { regularUrl?: string; boldUrl?: string };

const fontSources: Partial<Record<UnicodeEditorFontId, FontSource>> = {
  "mi-sans-khmer": {
    regularUrl: miSansKhmerRegularUrl,
    boldUrl: miSansKhmerBoldUrl
  }
};

export class EditorFontManager {
  private codeFont: CodeEditorFontId = "fira-mono";
  private unicodePreference: UnicodeFontPreference = "auto";
  private documentText = "";
  private activeCandidate: UnicodeFontCandidate | null = null;
  private appliedStack = "";
  private dismissedCandidateId: string | null = null;
  private readonly loadedFonts = new Set<string>();
  private readonly breadcrumb = document.getElementById("editor-font-breadcrumb")!;
  private readonly text = document.getElementById("editor-font-breadcrumb-text")!;
  private readonly download = document.getElementById("editor-font-download") as HTMLButtonElement;
  private readonly dismiss = document.getElementById("editor-font-dismiss") as HTMLButtonElement;

  constructor(private readonly getEditorView: () => EditorView | undefined) {}

  public initialize(): void {
    this.download.addEventListener("click", () => {
      if (this.activeCandidate) void this.installAndApply(this.activeCandidate, true);
    });
    this.dismiss.addEventListener("click", () => {
      this.dismissedCandidateId = this.activeCandidate?.id ?? null;
      this.hide();
    });
  }

  public configure(codeFont: CodeEditorFontId, unicodeFont: UnicodeFontPreference): void {
    this.codeFont = codeFont;
    this.unicodePreference = unicodeFont;
    this.refresh();
  }

  public updateDocument(text: string): void {
    this.documentText = text;
    this.refresh();
  }

  private refresh(): void {
    const candidate = this.resolveUnicodeCandidate();
    this.activeCandidate = candidate;

    if (!candidate) {
      this.dismissedCandidateId = null;
      this.hide();
      this.applyStack();
      return;
    }

    const explicitlySelected = this.unicodePreference !== "auto" && this.unicodePreference !== "none";
    if (candidate.bundled || explicitlySelected || this.downloadedIds().has(candidate.id)) {
      void this.installAndApply(candidate, false);
      return;
    }

    this.applyStack();
    if (this.dismissedCandidateId === candidate.id) this.hide();
    else this.renderPrompt(candidate);
  }

  private resolveUnicodeCandidate(): UnicodeFontCandidate | null {
    if (this.unicodePreference === "none") return null;
    if (this.unicodePreference === "auto") return detectUnicodeEditorFont(this.documentText);
    return unicodeEditorFonts.find(font => font.id === this.unicodePreference) ?? null;
  }

  private renderPrompt(candidate: UnicodeFontCandidate): void {
    this.text.textContent = `${candidate.language} text detected. Download ${candidate.label} through the font detector?`;
    this.download.textContent = `Download ${candidate.label}`;
    this.download.disabled = false;
    this.download.classList.remove("hidden");
    this.breadcrumb.classList.remove("hidden");
  }

  private renderApplied(candidate: UnicodeFontCandidate): void {
    this.text.textContent = `${candidate.label} is now the Unicode fallback for ${candidate.language}.`;
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

  private markDownloaded(candidate: UnicodeFontCandidate): void {
    const downloaded = this.downloadedIds();
    downloaded.add(candidate.id);
    localStorage.setItem("typstry-downloaded-editor-fonts", JSON.stringify([...downloaded]));
  }

  private async installAndApply(candidate: UnicodeFontCandidate, showNotice: boolean): Promise<void> {
    if (this.activeCandidate?.id !== candidate.id) return;
    if (showNotice) {
      this.download.disabled = true;
      this.download.textContent = "Downloading...";
    }

    try {
      await this.load(candidate);
      this.markDownloaded(candidate);
      if (this.activeCandidate?.id !== candidate.id) return;
      this.applyStack(candidate.fontFamily);
      if (showNotice) {
        this.dismissedCandidateId = null;
        this.renderApplied(candidate);
      } else {
        this.hide();
      }
    } catch (error) {
      this.applyStack();
      this.text.textContent = `Could not load ${candidate.label}: ${String(error)}`;
      this.download.textContent = `Retry ${candidate.label}`;
      this.download.disabled = false;
      this.download.classList.remove("hidden");
      this.breadcrumb.classList.remove("hidden");
    }
  }

  private async load(candidate: UnicodeFontCandidate): Promise<void> {
    if (this.loadedFonts.has(candidate.id)) return;
    const source = fontSources[candidate.id];
    if (source?.regularUrl) {
      const regular = new FontFace(candidate.fontFamily, `url(${source.regularUrl})`, { weight: "400" });
      document.fonts.add(await regular.load());
    } else {
      await document.fonts.load(`14px "${candidate.fontFamily}"`);
    }
    if (source?.boldUrl) {
      const bold = new FontFace(candidate.fontFamily, `url(${source.boldUrl})`, { weight: "700" });
      document.fonts.add(await bold.load());
    }
    this.loadedFonts.add(candidate.id);
  }

  private applyStack(unicodeFamily?: string): void {
    const stack = codeEditorFontStack(this.codeFont, unicodeFamily);
    document.documentElement.style.setProperty("--editor-code-font", stack);
    document.documentElement.style.setProperty("--editor-unicode-font", unicodeFamily ? `"${unicodeFamily}"` : "sans-serif");
    if (this.appliedStack === stack) return;
    this.appliedStack = stack;
    this.getEditorView()?.dispatch({ effects: editorFontCompartment.reconfigure(editorFontTheme(stack)) });
  }
}
