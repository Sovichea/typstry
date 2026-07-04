import { invoke } from "@tauri-apps/api/core";
import { confirm } from "@tauri-apps/plugin-dialog";
import { cloneDefaultAppSettings, normalizeAppSettings, type AppSettings, type ThemeName } from "./settings";
import {
  unicodeFontPreferenceOptions,
} from "./editor/fontCatalog";

type SettingsPayload = { path: string; settings: unknown | null };
type SystemFontCatalog = { all: string[]; monospace: string[] };

export class SettingsController {
  private settings: AppSettings = cloneDefaultAppSettings();
  private filePath = "";
  private saveTimer: number | null = null;
  private loadError: string | null = null;
  private systemFonts: SystemFontCatalog = { all: ["MiSans Latin"], monospace: ["Fira Mono"] };

  constructor(private readonly applySettings: (settings: AppSettings) => void) {}

  public get value(): AppSettings {
    return this.settings;
  }

  public async load() {
    let shouldPersist = false;
    try {
      const payload = await invoke<SettingsPayload>("load_app_settings");
      this.filePath = payload.path;
      if (payload.settings) {
        this.settings = normalizeAppSettings(payload.settings);
        shouldPersist = JSON.stringify(payload.settings) !== JSON.stringify(this.settings);
      } else {
        const migrated = cloneDefaultAppSettings();
        const legacyTheme = localStorage.getItem("typstry-theme");
        const legacyWordWrap = localStorage.getItem("typstry-word-wrap");
        if (legacyTheme) migrated.appearance.theme = legacyTheme as ThemeName;
        if (legacyWordWrap) migrated.editor.wordWrap = legacyWordWrap !== "false";
        this.settings = normalizeAppSettings(migrated);
        shouldPersist = true;
      }
    } catch (error) {
      console.warn("Failed to load settings.json; using defaults.", error);
      this.settings = cloneDefaultAppSettings();
      this.loadError = String(error);
    }

    if (shouldPersist) await this.persist();
    await this.refreshSystemFonts();
  }

  public update(mutator: (settings: AppSettings) => void) {
    const nextSettings = normalizeAppSettings(this.settings);
    mutator(nextSettings);
    this.settings = normalizeAppSettings(nextSettings);
    this.applySettings(this.settings);
    this.populatePanel();
    this.scheduleSave();
  }

  public flush() {
    if (!this.saveTimer) return;
    window.clearTimeout(this.saveTimer);
    this.saveTimer = null;
    void this.persist();
  }

  public initializePanel() {
    const overlay = document.getElementById("settings-overlay");
    if (!overlay) return;
    this.populateFontOptions();

    const activatePanel = (name: string) => {
      document.querySelectorAll<HTMLElement>("[data-settings-panel]").forEach(item => {
        item.classList.toggle("active", item.dataset.settingsPanel === name);
      });
      document.querySelectorAll<HTMLElement>("[data-settings-panel-content]").forEach(panel => {
        panel.classList.toggle("active", panel.dataset.settingsPanelContent === name);
      });
    };
    const openSettings = (panel?: string) => {
      this.populatePanel();
      if (panel) activatePanel(panel);
      overlay.classList.remove("hidden");
      document.dispatchEvent(new Event("typstry:settings-opened"));
      (document.querySelector(".settings-nav-item.active") as HTMLButtonElement | null)?.focus();
    };
    const closeSettings = () => overlay.classList.add("hidden");

    document.getElementById("action-open-settings")?.addEventListener("click", () => openSettings());
    document.getElementById("settings-status-button")?.addEventListener("click", () => openSettings());
    document.getElementById("settings-close")?.addEventListener("click", closeSettings);
    document.getElementById("settings-done")?.addEventListener("click", closeSettings);
    overlay.addEventListener("mousedown", event => {
      if (event.target === overlay) closeSettings();
    });
    document.querySelectorAll<HTMLElement>("[data-settings-panel]").forEach(item => {
      item.addEventListener("click", () => activatePanel(item.dataset.settingsPanel ?? "appearance"));
    });
    document.addEventListener("typstry:open-settings", event => {
      openSettings((event as CustomEvent<{ panel?: string }>).detail?.panel);
    });
    document.addEventListener("typstry:system-fonts-changed", () => void this.refreshSystemFonts());

    const onChange = (id: string, update: (settings: AppSettings, control: HTMLInputElement | HTMLSelectElement) => void) => {
      const control = document.getElementById(id) as HTMLInputElement | HTMLSelectElement | null;
      control?.addEventListener("change", () => this.update(settings => update(settings, control)));
    };
    onChange("settings-theme", (settings, control) => { settings.appearance.theme = control.value as ThemeName; });
    onChange("settings-font-size", (settings, control) => { settings.appearance.editorFontSize = Number(control.value); });
    onChange("settings-line-height", (settings, control) => { settings.appearance.editorLineHeight = Number(control.value); });
    onChange("settings-code-font", (settings, control) => { settings.editor.codeFont = control.value; });
    onChange("settings-unicode-font", (settings, control) => { settings.editor.unicodeFont = control.value; });
    onChange("settings-word-wrap", (settings, control) => { settings.editor.wordWrap = (control as HTMLInputElement).checked; });
    onChange("settings-tab-size", (settings, control) => { settings.editor.tabSize = Number(control.value) as 2 | 4 | 8; });
    onChange("settings-line-numbers", (settings, control) => { settings.editor.lineNumbers = (control as HTMLInputElement).checked; });
    onChange("settings-active-line", (settings, control) => { settings.editor.highlightActiveLine = (control as HTMLInputElement).checked; });
    onChange("settings-auto-close", (settings, control) => { settings.editor.autoCloseBrackets = (control as HTMLInputElement).checked; });
    onChange("settings-indent-guides", (settings, control) => { settings.editor.indentationGuides = (control as HTMLInputElement).checked; });
    onChange("settings-spellcheck", (settings, control) => { settings.editor.spellcheck = (control as HTMLInputElement).checked; });
    onChange("settings-word-completion", (settings, control) => { settings.editor.wordCompletion = (control as HTMLInputElement).checked; });
    onChange("settings-show-zws", (settings, control) => { settings.editor.showZws = (control as HTMLInputElement).checked; });
    onChange("settings-cursor-sync", (settings, control) => { settings.preview.cursorSync = (control as HTMLInputElement).checked; });
    onChange("settings-sync-debounce", (settings, control) => { settings.preview.syncDebounceMs = Number(control.value); });
    onChange("settings-highlight-duration", (settings, control) => { settings.preview.highlightDurationMs = Number(control.value); });
    onChange("settings-khmer-prep", (settings, control) => { settings.preview.khmerRenderPreparation = (control as HTMLInputElement).checked; });

    document.getElementById("settings-reset")?.addEventListener("click", async () => {
      if (await confirm("Reset all application settings to their defaults?", { title: "Reset Settings", kind: "warning" })) {
        this.settings = cloneDefaultAppSettings();
        this.applySettings(this.settings);
        this.populatePanel();
        this.scheduleSave();
      }
    });
    document.getElementById("settings-reveal-file")?.addEventListener("click", () => {
      if (this.filePath) void invoke("reveal_in_explorer", { path: this.filePath });
    });
    document.addEventListener("keydown", event => {
      const isMac = navigator.userAgent.toLowerCase().includes("mac");
      if ((isMac ? event.metaKey : event.ctrlKey) && event.key === ",") {
        event.preventDefault();
        openSettings();
      } else if (event.key === "Escape" && !overlay.classList.contains("hidden")) {
        event.preventDefault();
        closeSettings();
      }
    });

    this.populatePanel();
  }

  private async persist() {
    const status = document.getElementById("settings-save-status");
    if (status) status.textContent = "Saving...";
    try {
      this.filePath = await invoke<string>("save_app_settings", { settings: this.settings });
      this.loadError = null;
      localStorage.removeItem("typstry-theme");
      localStorage.removeItem("typstry-word-wrap");
      if (status) status.textContent = "Saved";
      const path = document.getElementById("settings-file-path");
      if (path) path.textContent = this.filePath;
    } catch (error) {
      console.error("Failed to save settings.json", error);
      if (status) status.textContent = `Save failed: ${String(error)}`;
    }
  }

  private scheduleSave() {
    if (this.saveTimer) window.clearTimeout(this.saveTimer);
    const status = document.getElementById("settings-save-status");
    if (status) status.textContent = "Unsaved changes";
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      void this.persist();
    }, 180);
  }

  private populatePanel() {
    const { appearance, editor, preview } = this.settings;
    const setValue = (id: string, value: string) => {
      const control = document.getElementById(id) as HTMLInputElement | HTMLSelectElement | null;
      if (control) control.value = value;
    };
    const setChecked = (id: string, checked: boolean) => {
      const control = document.getElementById(id) as HTMLInputElement | null;
      if (control) control.checked = checked;
    };

    setValue("settings-theme", appearance.theme);
    setValue("settings-font-size", String(appearance.editorFontSize));
    setValue("settings-line-height", String(appearance.editorLineHeight));
    setValue("settings-code-font", editor.codeFont);
    setValue("settings-unicode-font", editor.unicodeFont);
    setValue("settings-tab-size", String(editor.tabSize));
    setValue("settings-sync-debounce", String(preview.syncDebounceMs));
    setValue("settings-highlight-duration", String(preview.highlightDurationMs));
    setChecked("settings-word-wrap", editor.wordWrap);
    setChecked("settings-line-numbers", editor.lineNumbers);
    setChecked("settings-active-line", editor.highlightActiveLine);
    setChecked("settings-auto-close", editor.autoCloseBrackets);
    setChecked("settings-indent-guides", editor.indentationGuides);
    setChecked("settings-spellcheck", editor.spellcheck);
    setChecked("settings-word-completion", editor.wordCompletion);
    setChecked("settings-show-zws", editor.showZws);
    setChecked("settings-cursor-sync", preview.cursorSync);
    setChecked("settings-khmer-prep", preview.khmerRenderPreparation);

    const path = document.getElementById("settings-file-path");
    if (path) {
      path.textContent = this.filePath || "settings.json path unavailable";
      path.title = this.filePath;
    }
    const status = document.getElementById("settings-save-status");
    if (status && this.loadError) status.textContent = `Using defaults: ${this.loadError}`;
  }

  private populateFontOptions() {
    const populate = (id: string, options: ReadonlyArray<{ id: string; label: string }>) => {
      const select = document.getElementById(id) as HTMLSelectElement | null;
      if (!select) return;
      select.replaceChildren(...options.map(item => {
        const option = document.createElement("option");
        option.value = item.id;
        option.textContent = item.label;
        return option;
      }));
    };

    const codeFamilies = new Set(this.systemFonts.monospace);
    codeFamilies.add(this.settings.editor.codeFont);
    const fallbackFamilies = new Set(this.systemFonts.all);
    if (this.settings.editor.unicodeFont !== "auto" && this.settings.editor.unicodeFont !== "none") {
      fallbackFamilies.add(this.settings.editor.unicodeFont);
    }
    populate("settings-code-font", [...codeFamilies].sort().map(family => ({ id: family, label: family })));
    populate("settings-unicode-font", [
      ...unicodeFontPreferenceOptions,
      ...[...fallbackFamilies].sort().map(family => ({ id: family, label: family }))
    ]);
  }

  private async refreshSystemFonts(): Promise<void> {
    try {
      this.systemFonts = await invoke<SystemFontCatalog>("list_system_fonts");
      const selectedCodeFont = this.settings.editor.codeFont.toLocaleLowerCase();
      if (!this.systemFonts.monospace.some(family => family.toLocaleLowerCase() === selectedCodeFont)) {
        this.settings.editor.codeFont = this.systemFonts.monospace.find(family => family === "Fira Mono")
          ?? this.systemFonts.monospace[0]
          ?? "Fira Mono";
        this.scheduleSave();
      }
      const selectedFallback = this.settings.editor.unicodeFont;
      if (selectedFallback !== "auto"
        && selectedFallback !== "none"
        && !this.systemFonts.all.some(family => family.toLocaleLowerCase() === selectedFallback.toLocaleLowerCase())) {
        this.settings.editor.unicodeFont = "auto";
        this.scheduleSave();
      }
      this.populateFontOptions();
      this.populatePanel();
    } catch (error) {
      console.warn("Failed to load system font choices.", error);
    }
  }
}
