import { invoke } from "@tauri-apps/api/core";
import { confirm, message } from "@tauri-apps/plugin-dialog";
import { cloneDefaultAppSettings, normalizeAppSettings, type AppSettings, type ThemeName } from "./settings";
import {
  unicodeFontPreferenceOptions,
} from "./editor/fontCatalog";
import {
  boundaryModeLabel,
  parseLanguageCatalog,
  parseLanguageProviderCapabilitiesList,
  providerFeatureLabels,
  providerStabilityLabel,
  supportLevelPresentation,
  type LanguageCatalogCapabilities,
  type LanguageProviderCapabilities
} from "./languageSupport";

type SettingsPayload = { path: string; settings: unknown | null };
type SystemFontCatalog = { all: string[]; monospace: string[] };
type LanguageProviderOption = LanguageProviderCapabilities;
type HunspellCatalogEntry = LanguageCatalogCapabilities;
export type SettingsTimingEntry = {
  source: string;
  label: string;
  ms: number;
};

function formatBytes(bytes: number): string {
  if (bytes === 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export class SettingsController {
  private settings: AppSettings = cloneDefaultAppSettings();
  private filePath = "";
  private saveTimer: number | null = null;
  private loadError: string | null = null;
  private systemFonts: SystemFontCatalog = { all: ["MiSans Latin"], monospace: ["Fira Mono"] };
  private languageProviders: LanguageProviderOption[] = [];
  private readonly timingEntries: SettingsTimingEntry[] = [];

  constructor(
    private readonly applySettings: (settings: AppSettings) => void,
    private readonly onLanguageProvidersChanged: (providers: LanguageProviderOption[]) => void = () => {}
  ) {}

  public get value(): AppSettings {
    return this.settings;
  }

  public getTimings(): SettingsTimingEntry[] {
    return [...this.timingEntries];
  }

  public async load() {
    const loadStart = performance.now();
    let shouldPersist = false;
    try {
      const settingsFileStart = performance.now();
      const payload = await invoke<SettingsPayload>("load_app_settings");
      this.recordTiming("frontend startup", "load settings file", settingsFileStart);
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

    if (shouldPersist) {
      const persistStart = performance.now();
      await this.persist();
      this.recordTiming("frontend startup", "persist migrated settings", persistStart);
    }
    this.recordTiming("frontend startup", "settings load total", loadStart);
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

  public setLanguageProviders(providers: LanguageProviderOption[]): void {
    this.languageProviders = [...providers].sort((left, right) =>
      this.languageProviderLabel(left).localeCompare(this.languageProviderLabel(right))
    );
    this.populateLanguageProviders();
  }

  public initializePanel() {
    const overlay = document.getElementById("settings-overlay");
    if (!overlay) return;
    this.populateFontOptions();
    document.getElementById("settings-khmer-prep-field")?.classList.toggle("hidden", !import.meta.env.DEV);

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
    onChange("settings-format-on-save", (settings, control) => { settings.editor.formatOnSave = (control as HTMLInputElement).checked; });
    onChange("settings-preview-render-mode", (settings, control) => { settings.preview.renderMode = control.value as AppSettings["preview"]["renderMode"]; });
    onChange("settings-cursor-sync", (settings, control) => { settings.preview.cursorSync = (control as HTMLInputElement).checked; });
    onChange("settings-sync-debounce", (settings, control) => { settings.preview.syncDebounceMs = Number(control.value); });
    onChange("settings-highlight-duration", (settings, control) => { settings.preview.highlightDurationMs = Number(control.value); });
    onChange("settings-khmer-prep", (settings, control) => { settings.preview.khmerRenderPreparation = (control as HTMLInputElement).checked; });
    onChange("settings-developer-mode", (settings, control) => { settings.developerMode = (control as HTMLInputElement).checked; });
    document.getElementById("settings-add-language")?.addEventListener("click", () => {
      void this.toggleLanguageCatalog();
    });

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
      if ((isMac ? event.metaKey : event.ctrlKey) && event.code === "Comma") {
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
    setValue("settings-preview-render-mode", preview.renderMode);
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
    setChecked("settings-format-on-save", editor.formatOnSave);
    setChecked("settings-cursor-sync", preview.cursorSync);
    setChecked("settings-khmer-prep", preview.khmerRenderPreparation);
    setChecked("settings-developer-mode", this.settings.developerMode);
    this.populateLanguageProviders();

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

  private populateLanguageProviders(): void {
    const container = document.getElementById("settings-language-providers");
    if (!container) return;
    if (this.languageProviders.length === 0) {
      const empty = document.createElement("small");
      empty.textContent = "No languages are installed.";
      container.replaceChildren(empty);
      return;
    }

    const explicit = this.settings.editor.languageProviders;
    const enabled = explicit === null
      ? new Set(this.languageProviders.map(provider => provider.id))
      : new Set(explicit);

    const controls = this.languageProviders.map(provider => {
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.value = provider.id;
      checkbox.checked = enabled.has(provider.id);
      checkbox.addEventListener("change", () => {
        const checked = new Set(
          Array.from(container.querySelectorAll<HTMLInputElement>("input[type='checkbox']:checked"))
            .map(input => input.value)
        );
        this.update(settings => {
          const allEnabled = this.languageProviders.every(candidate => checked.has(candidate.id));
          settings.editor.languageProviders = allEnabled ? null : [...checked].sort();
        });
      });

      const title = document.createElement("div");
      title.className = "settings-language-provider-title";
      title.textContent = this.languageProviderLabel(provider);
      const support = supportLevelPresentation(provider.supportLevel);
      const supportBadge = this.createSupportBadge(support.level, support.label, support.description);
      const titleRow = document.createElement("div");
      titleRow.className = "settings-language-provider-title-row";
      titleRow.append(title, supportBadge, this.createStabilityBadge(provider.stability));
      const details = document.createElement("div");
      details.className = "settings-language-provider-meta";
      details.textContent = [
        provider.languageTag,
        boundaryModeLabel(provider.boundaryMode),
        provider.engine?.split("_").join(" ")
      ].filter(Boolean).join(" · ");
      const features = document.createElement("div");
      features.className = "settings-language-provider-features";
      features.textContent = providerFeatureLabels(provider).join(" · ") || "No active language-tool capabilities";
      const text = document.createElement("div");
      text.className = "settings-language-provider-text";
      text.append(titleRow, details, features);
      const label = document.createElement("label");
      label.className = "settings-language-provider";
      label.title = support.description;
      label.append(text, checkbox);
      return label;
    });
    container.replaceChildren(...controls);
  }

  private languageProviderLabel(provider: LanguageProviderOption): string {
    return provider.displayName || provider.languageTag || provider.id;
  }

  private async toggleLanguageCatalog(): Promise<void> {
    const catalog = document.getElementById("settings-language-catalog");
    if (!catalog) return;
    if (!catalog.classList.contains("hidden")) {
      catalog.classList.add("hidden");
      return;
    }
    catalog.classList.remove("hidden");
    catalog.textContent = "Loading language catalog...";
    await this.populateLanguageCatalog();
  }

  private async populateLanguageCatalog(): Promise<void> {
    const catalog = document.getElementById("settings-language-catalog");
    if (!catalog) return;
    let entries: HunspellCatalogEntry[] = [];
    try {
      entries = parseLanguageCatalog(await invoke<unknown>("list_hunspell_catalog"));
    } catch (error) {
      catalog.textContent = `Failed to load language catalog: ${String(error)}`;
      return;
    }

    const header = document.createElement("div");
    header.className = "settings-language-catalog-header";
    header.textContent = "Downloadable dictionaries provide Basic support unless Typstry has a tested language-specific provider. Basic support does not imply reliable segmentation or word completion.";
    const list = document.createElement("div");
    list.className = "settings-language-catalog-list";
    list.replaceChildren(...entries.map(entry => this.renderLanguageCatalogRow(entry)));
    catalog.replaceChildren(header, list);
  }

  private renderLanguageCatalogRow(entry: HunspellCatalogEntry): HTMLElement {
    const title = document.createElement("div");
    title.className = "settings-language-catalog-title";
    title.textContent = entry.displayName;
    const support = supportLevelPresentation(entry.supportLevel);
    const titleRow = document.createElement("div");
    titleRow.className = "settings-language-provider-title-row";
    titleRow.append(title, this.createSupportBadge(support.level, support.label, support.description), this.createStabilityBadge(entry.stability));

    const meta = document.createElement("div");
    meta.className = "settings-language-catalog-meta";

    const sizeStr = entry.downloadSize > 0 ? formatBytes(entry.downloadSize) : "";
    const typeLabel = entry.providerType === "deep" ? "Deep provider" : "Dictionary only";

    meta.textContent = [
      entry.languageTag,
      entry.bundled ? "bundled" : entry.installed ? "installed" : "Hunspell",
      typeLabel,
      sizeStr,
      entry.version,
      entry.license,
      entry.source
    ].filter(Boolean).join(" · ");

    const features = document.createElement("div");
    features.className = "settings-language-provider-features";
    features.textContent = providerFeatureLabels(entry).join(" · ") || "No active language-tool capabilities";
    const text = document.createElement("div");
    text.append(titleRow, meta, features);

    const button = document.createElement("button");
    button.type = "button";
    if (entry.bundled) {
      button.className = "settings-secondary-button";
      button.textContent = "Bundled";
      button.disabled = true;
    } else if (entry.installed) {
      button.className = "settings-danger-button";
      button.textContent = "Remove";
      button.addEventListener("click", () => void this.uninstallLanguage(entry, button));
    } else {
      button.className = "settings-secondary-button";
      button.textContent = "Download";
      button.addEventListener("click", () => void this.installLanguage(entry, button));
    }

    const row = document.createElement("div");
    row.className = "settings-language-catalog-row";
    row.title = support.description;
    row.append(text, button);
    return row;
  }

  private createSupportBadge(level: "basic" | "enhanced" | "deep", label: string, description: string): HTMLSpanElement {
    const badge = document.createElement("span");
    badge.className = `settings-language-support-badge support-${level}`;
    badge.textContent = label;
    badge.title = description;
    return badge;
  }

  private createStabilityBadge(stability: string): HTMLSpanElement {
    const badge = document.createElement("span");
    const isExperimental = stability === "experimental";
    badge.className = `settings-language-support-badge stability-${isExperimental ? "experimental" : "stable"}`;
    badge.textContent = isExperimental ? "Experimental" : "Stable";
    badge.title = isExperimental
      ? "This provider is still being validated and may have known limitations."
      : "This provider is tested and considered reliable.";
    return badge;
  }

  private async installLanguage(entry: HunspellCatalogEntry, button: HTMLButtonElement): Promise<void> {
    const original = button.textContent ?? "Download";
    button.disabled = true;
    button.textContent = "Downloading...";
    try {
      const providers = parseLanguageProviderCapabilitiesList(
        await invoke<unknown>("install_hunspell_dictionary", { locale: entry.locale })
      );
      this.setLanguageProviders(providers);
      this.onLanguageProvidersChanged(providers);
      this.update(settings => {
        if (settings.editor.languageProviders !== null && !settings.editor.languageProviders.includes(entry.id)) {
          settings.editor.languageProviders.push(entry.id);
        }
      });
      await this.populateLanguageCatalog();
    } catch (error) {
      button.disabled = false;
      button.textContent = original;
      await message(String(error), { title: `Install ${entry.displayName}`, kind: "error" });
    }
  }

  private async uninstallLanguage(entry: HunspellCatalogEntry, button: HTMLButtonElement): Promise<void> {
    const original = button.textContent ?? "Remove";
    button.disabled = true;
    button.textContent = "Removing...";
    try {
      const providers = parseLanguageProviderCapabilitiesList(
        await invoke<unknown>("remove_hunspell_dictionary", { locale: entry.locale })
      );
      this.setLanguageProviders(providers);
      this.onLanguageProvidersChanged(providers);
      this.update(settings => {
        if (settings.editor.languageProviders !== null) {
          settings.editor.languageProviders = settings.editor.languageProviders.filter(id => id !== entry.id);
        }
      });
      await this.populateLanguageCatalog();
    } catch (error) {
      button.disabled = false;
      button.textContent = original;
      await message(String(error), { title: `Remove ${entry.displayName}`, kind: "error" });
    }
  }

  public async refreshSystemFonts(): Promise<void> {
    const totalStart = performance.now();
    try {
      const nativeFontStart = performance.now();
      this.systemFonts = await invoke<SystemFontCatalog>("list_system_fonts");
      this.recordTiming("frontend startup", "native list_system_fonts", nativeFontStart);
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
      this.recordTiming("frontend startup", "refresh system font choices total", totalStart);
    } catch (error) {
      console.warn("Failed to load system font choices.", error);
      this.recordTiming("frontend startup", "refresh system font choices failed", totalStart);
    }
  }

  private recordTiming(source: string, label: string, start: number): void {
    this.timingEntries.push({
      source,
      label,
      ms: performance.now() - start
    });
  }
}
