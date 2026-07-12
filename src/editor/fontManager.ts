import type { EditorView } from "@codemirror/view";
import { invoke } from "@tauri-apps/api/core";
import { editorFontCompartment } from "./extensions";
import {
  codeEditorFontStack,
  detectUnicodeEditorFont,
  unicodeEditorFonts,
  type CodeEditorFontId,
  type UnicodeFontPreference
} from "./fontCatalog";
import { editorFontTheme } from "./themes";

type UnicodeFontCandidate = typeof unicodeEditorFonts[number];
type SystemFontCatalog = { all: string[]; monospace: string[] };
type InstalledFont = { family: string };

const declinedStorageKey = "typstella-declined-unicode-fonts";

export class EditorFontManager {
  private codeFont: CodeEditorFontId = "Fira Mono";
  private unicodePreference: UnicodeFontPreference = "auto";
  private documentText = "";
  private activeCandidate: UnicodeFontCandidate | null = null;
  private activeNoticeId: string | null = null;
  private appliedStack = "";
  private showSettingsAction = false;
  private dismissDeclines = false;
  private readonly systemFamilies = new Set<string>();
  private readonly breadcrumb = document.getElementById("editor-font-breadcrumb")!;
  private readonly text = document.getElementById("editor-font-breadcrumb-text")!;
  private readonly download = document.getElementById("editor-font-download") as HTMLButtonElement;
  private readonly dismiss = document.getElementById("editor-font-dismiss") as HTMLButtonElement;

  constructor(private readonly getEditorView: () => EditorView | undefined) {}

  public initialize(): void {
    this.download.addEventListener("click", () => {
      if (this.showSettingsAction) {
        document.dispatchEvent(new CustomEvent("typstella:open-settings", { detail: { panel: "editor" } }));
      } else if (this.activeCandidate) {
        void this.installAndApply(this.activeCandidate);
      }
    });
    this.dismiss.addEventListener("click", () => {
      if (this.dismissDeclines && this.activeNoticeId) {
        this.markDeclined(this.activeNoticeId);
        this.renderDeclined();
      } else {
        this.hide();
      }
    });
    void this.refreshSystemFonts();
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

  private async refreshSystemFonts(): Promise<void> {
    try {
      const catalog = await invoke<SystemFontCatalog>("list_system_fonts");
      this.systemFamilies.clear();
      catalog.all.forEach(family => this.systemFamilies.add(family.toLocaleLowerCase()));
      this.refresh();
    } catch (error) {
      console.warn("Failed to enumerate system fonts.", error);
    }
  }

  private refresh(): void {
    if (this.unicodePreference === "none") {
      this.activeCandidate = null;
      this.activeNoticeId = null;
      this.hide();
      this.applyStack();
      return;
    }
    if (this.unicodePreference !== "auto") {
      this.activeCandidate = null;
      this.activeNoticeId = null;
      this.hide();
      this.applyStack(this.unicodePreference);
      return;
    }

    const candidate = detectUnicodeEditorFont(this.documentText);
    this.activeCandidate = candidate;
    if (!candidate) {
      this.activeNoticeId = null;
      this.applyStack();
      this.hide();
      return;
    }
    this.activeNoticeId = candidate.id;
    if (candidate.bundled || this.systemFamilies.has(candidate.fontFamily.toLocaleLowerCase())) {
      this.hide();
      this.applyStack(candidate.fontFamily);
      return;
    }
    this.applyStack(candidate.fontFamily);
    if (this.declinedIds().has(candidate.id)) {
      this.hide();
      return;
    }
    this.renderPrompt(candidate);
  }

  private renderPrompt(candidate: UnicodeFontCandidate): void {
    this.showSettingsAction = false;
    this.dismissDeclines = true;
    this.text.textContent = `${candidate.language} text detected. Download and install ${candidate.label} for consistent Unicode rendering?`;
    this.download.textContent = `Install ${candidate.label}`;
    this.download.disabled = false;
    this.download.classList.remove("hidden");
    this.dismiss.textContent = "Not now";
    this.dismiss.setAttribute("aria-label", "Do not suggest this font again");
    this.breadcrumb.classList.remove("hidden");
  }

  private renderDeclined(): void {
    this.showSettingsAction = true;
    this.dismissDeclines = false;
    this.text.textContent = "No font was downloaded. You can choose any installed Unicode fallback in Settings.";
    this.download.textContent = "Open Settings";
    this.download.disabled = false;
    this.download.classList.remove("hidden");
    this.dismiss.textContent = "Close";
    this.dismiss.setAttribute("aria-label", "Close font notice");
  }

  private renderDownloading(candidate: UnicodeFontCandidate): void {
    this.showSettingsAction = false;
    this.dismissDeclines = false;
    this.text.textContent = `Downloading and installing ${candidate.label} for the current user...`;
    this.download.classList.add("hidden");
    this.dismiss.classList.add("hidden");
    this.breadcrumb.classList.remove("hidden");
  }

  private renderApplied(candidate: UnicodeFontCandidate): void {
    this.showSettingsAction = false;
    this.dismissDeclines = false;
    this.text.textContent = `${candidate.label} was installed for the current user and selected automatically.`;
    this.download.classList.add("hidden");
    this.dismiss.textContent = "Close";
    this.dismiss.setAttribute("aria-label", "Close font notice");
    this.dismiss.classList.remove("hidden");
    this.breadcrumb.classList.remove("hidden");
  }

  private hide(): void {
    this.breadcrumb.classList.add("hidden");
    this.dismiss.classList.remove("hidden");
  }

  private declinedIds(): Set<string> {
    try {
      const stored: unknown = JSON.parse(localStorage.getItem(declinedStorageKey) || "[]");
      return new Set(Array.isArray(stored) ? stored.filter((value): value is string => typeof value === "string") : []);
    } catch {
      return new Set();
    }
  }

  private markDeclined(id: string): void {
    const declined = this.declinedIds();
    declined.add(id);
    localStorage.setItem(declinedStorageKey, JSON.stringify([...declined]));
  }

  private async installAndApply(candidate: UnicodeFontCandidate): Promise<void> {
    if (this.activeCandidate?.id !== candidate.id) return;
    this.renderDownloading(candidate);
    try {
      const installed = await invoke<InstalledFont>("install_unicode_font", { fontId: candidate.id });
      this.systemFamilies.add(installed.family.toLocaleLowerCase());
      await document.fonts.load(`16px "${installed.family}"`);
      if (this.activeCandidate?.id !== candidate.id) return;
      this.applyStack(installed.family);
      this.renderApplied(candidate);
      document.dispatchEvent(new Event("typstella:system-fonts-changed"));
    } catch (error) {
      this.showSettingsAction = false;
      this.dismissDeclines = false;
      this.text.textContent = `Could not install ${candidate.label}: ${String(error)}`;
      this.download.textContent = "Retry";
      this.download.disabled = false;
      this.download.classList.remove("hidden");
      this.dismiss.textContent = "Close";
      this.dismiss.classList.remove("hidden");
      this.breadcrumb.classList.remove("hidden");
    }
  }

  private applyStack(unicodeFamily?: string): void {
    const stack = codeEditorFontStack(this.codeFont, unicodeFamily);
    const uiStack = [...new Set(["MiSans Latin", unicodeFamily].filter((family): family is string => !!family))]
      .map(family => `"${family.replace(/"/g, '\\"')}"`)
      .join(", ");
    document.documentElement.style.setProperty("--ui-font", uiStack);
    document.documentElement.style.setProperty("--editor-code-font", stack);
    document.documentElement.style.setProperty("--editor-unicode-font", unicodeFamily ? `"${unicodeFamily}"` : "sans-serif");
    if (this.appliedStack === stack) return;
    this.appliedStack = stack;
    this.getEditorView()?.dispatch({ effects: editorFontCompartment.reconfigure(editorFontTheme(stack)) });
  }
}
