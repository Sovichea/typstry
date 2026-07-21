import { invoke } from "@tauri-apps/api/core";
import { confirm, message } from "@tauri-apps/plugin-dialog";
import { relaunch } from "@tauri-apps/plugin-process";
import { cloneDefaultAppSettings, normalizeAppSettings, type AppSettings, type TerminologyEntry, type ThemeName } from "./settings";
import {
  unicodeEditorFonts,
  unicodeFontPreferenceOptions,
} from "./editor/fontCatalog";
import {
  parseLanguageCatalog,
  parseLanguageProviderCapabilitiesList,
  providerFeatureLabels,
  supplementalLanguageProviders,
  supportLevelPresentation,
  type LanguageCatalogCapabilities,
  type LanguageProviderCapabilities
} from "./languageSupport";

type SettingsPayload = { path: string; settings: unknown | null };
type SystemFontCatalog = { all: string[]; monospace: string[] };
type LanguageProviderOption = LanguageProviderCapabilities;
type HunspellCatalogEntry = LanguageCatalogCapabilities;
type LinuxRendererCompatibility = {
  supported: boolean;
  sessionType: string | null;
  wayland: boolean;
  webkitVersion: string | null;
  distribution: string | null;
  architecture: string;
  gpuVendor: string | null;
  amdGpu: boolean;
  riskLevel: "none" | "possible" | "reported";
  dmabufDisabled: boolean;
  dmabufEnvironmentValue: string | null;
  dmabufAppliedByTypsastra: boolean;
};
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
  private readonly timingEntries: SettingsTimingEntry[] = [];
  private projectTerminology: TerminologyEntry[] = [];
  private rendererCompatibility: LinuxRendererCompatibility | null = null;
  private rendererCompatibilityError: string | null = null;
  private updateProjectTerminology: (entries: TerminologyEntry[]) => void = () => {};

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
        const legacyTheme = localStorage.getItem("typsastra-theme");
        const legacyWordWrap = localStorage.getItem("typsastra-word-wrap");
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
    void this.refreshRendererCompatibility();
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

  public setProjectTerminology(
    entries: readonly TerminologyEntry[],
    update?: (entries: TerminologyEntry[]) => void,
  ): void {
    this.projectTerminology = [...entries];
    if (update) this.updateProjectTerminology = update;
    this.populateTerminology();
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
      document.dispatchEvent(new Event("typsastra:settings-opened"));
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
    document.addEventListener("typsastra:open-settings", event => {
      openSettings((event as CustomEvent<{ panel?: string }>).detail?.panel);
    });
    document.addEventListener("typsastra:system-fonts-changed", () => void this.refreshSystemFonts());
    document.addEventListener("typsastra:language-providers-changed", () => {
      const catalog = document.getElementById("settings-language-catalog");
      if (catalog && !catalog.classList.contains("hidden")) void this.populateLanguageCatalog();
    });

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
    onChange("settings-disable-webkit-dmabuf", (settings, control) => {
      settings.compatibility.disableWebkitDmabufRenderer = (control as HTMLInputElement).checked;
    });
    onChange("settings-developer-mode", (settings, control) => { settings.developerMode = (control as HTMLInputElement).checked; });
    onChange("settings-dev-log-preview", (settings, control) => { settings.developerLogs.preview = (control as HTMLInputElement).checked; });
    onChange("settings-dev-log-inverse-sync", (settings, control) => { settings.developerLogs.inverseSync = (control as HTMLInputElement).checked; });
    onChange("settings-dev-log-forward-sync", (settings, control) => { settings.developerLogs.forwardSync = (control as HTMLInputElement).checked; });
    onChange("settings-dev-log-performance", (settings, control) => { settings.developerLogs.performance = (control as HTMLInputElement).checked; });
    onChange("settings-dev-log-memory", (settings, control) => { settings.developerLogs.memory = (control as HTMLInputElement).checked; });
    onChange("settings-dev-log-lsp", (settings, control) => { settings.developerLogs.lsp = (control as HTMLInputElement).checked; });
    onChange("settings-dev-log-spellcheck", (settings, control) => { settings.developerLogs.spellcheck = (control as HTMLInputElement).checked; });
    onChange("settings-dev-log-general", (settings, control) => { settings.developerLogs.general = (control as HTMLInputElement).checked; });
    document.getElementById("settings-add-language")?.addEventListener("click", () => {
      void this.toggleLanguageCatalog();
    });
    document.getElementById("settings-renderer-recheck")?.addEventListener("click", () => {
      void this.refreshRendererCompatibility();
    });
    document.getElementById("settings-renderer-restart")?.addEventListener("click", () => {
      void this.restartForRendererCompatibility();
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

  private async persist(): Promise<boolean> {
    const status = document.getElementById("settings-save-status");
    if (status) status.textContent = "Saving...";
    try {
      this.filePath = await invoke<string>("save_app_settings", { settings: this.settings });
      this.loadError = null;
      localStorage.removeItem("typsastra-theme");
      localStorage.removeItem("typsastra-word-wrap");
      if (status) status.textContent = "Saved";
      const path = document.getElementById("settings-file-path");
      if (path) path.textContent = this.filePath;
      return true;
    } catch (error) {
      console.error("Failed to save settings.json", error);
      if (status) status.textContent = `Save failed: ${String(error)}`;
      return false;
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
    const cursorSync = document.getElementById("settings-cursor-sync") as HTMLInputElement | null;
    if (cursorSync) {
      cursorSync.disabled = true;
      cursorSync.title = "Forward sync is disabled until the v0.9.0 prerelease reliability work.";
    }
    setChecked("settings-khmer-prep", preview.khmerRenderPreparation);
    setChecked("settings-disable-webkit-dmabuf", this.settings.compatibility.disableWebkitDmabufRenderer);
    setChecked("settings-developer-mode", this.settings.developerMode);
    setChecked("settings-dev-log-preview", this.settings.developerLogs.preview);
    setChecked("settings-dev-log-inverse-sync", this.settings.developerLogs.inverseSync);
    setChecked("settings-dev-log-forward-sync", this.settings.developerLogs.forwardSync);
    setChecked("settings-dev-log-performance", this.settings.developerLogs.performance);
    setChecked("settings-dev-log-memory", this.settings.developerLogs.memory);
    setChecked("settings-dev-log-lsp", this.settings.developerLogs.lsp);
    setChecked("settings-dev-log-spellcheck", this.settings.developerLogs.spellcheck);
    setChecked("settings-dev-log-general", this.settings.developerLogs.general);
    const developerLogFilters = document.getElementById("settings-developer-log-filters");
    developerLogFilters?.classList.toggle("disabled", !this.settings.developerMode);
    developerLogFilters?.querySelectorAll<HTMLInputElement>("input").forEach(control => {
      control.disabled = !this.settings.developerMode;
    });
    this.populateTerminology();
    this.populateRendererCompatibility();

    const path = document.getElementById("settings-file-path");
    if (path) {
      path.textContent = this.filePath || "settings.json path unavailable";
      path.title = this.filePath;
    }
    const status = document.getElementById("settings-save-status");
    if (status && this.loadError) status.textContent = `Using defaults: ${this.loadError}`;
  }

  private async refreshRendererCompatibility(): Promise<void> {
    this.rendererCompatibilityError = null;
    const status = document.getElementById("settings-renderer-status");
    if (status) status.textContent = "Checking Linux display and WebKitGTK compatibility...";
    try {
      this.rendererCompatibility = await invoke<LinuxRendererCompatibility>("get_linux_renderer_compatibility");
    } catch (error) {
      this.rendererCompatibility = null;
      this.rendererCompatibilityError = String(error);
    }
    this.populateRendererCompatibility();
  }

  private populateRendererCompatibility(): void {
    const section = document.getElementById("settings-linux-renderer-compatibility");
    const status = document.getElementById("settings-renderer-status");
    const details = document.getElementById("settings-renderer-details");
    const restart = document.getElementById("settings-renderer-restart") as HTMLButtonElement | null;
    const compatibility = this.rendererCompatibility;

    section?.classList.toggle("hidden", compatibility?.supported !== true && !this.rendererCompatibilityError);
    if (!status || !details || !restart) return;
    status.classList.remove("warning", "error");

    if (this.rendererCompatibilityError) {
      status.classList.add("error");
      status.textContent = `Compatibility check failed: ${this.rendererCompatibilityError}`;
      details.textContent = "You can still set the renderer override; it will be applied on the next Linux startup.";
      restart.classList.add("hidden");
      return;
    }
    if (!compatibility) return;
    if (!compatibility.supported) return;

    const desiredDisabled = this.settings.compatibility.disableWebkitDmabufRenderer;
    const externallyDisabled = compatibility.dmabufDisabled && !compatibility.dmabufAppliedByTypsastra;
    const restartRequired = desiredDisabled !== compatibility.dmabufDisabled
      && !(externallyDisabled && !desiredDisabled);

    if (restartRequired) {
      status.classList.add("warning");
      status.textContent = "Renderer setting changed. Restart Typsastra to apply it before WebKitGTK starts.";
    } else if (externallyDisabled) {
      status.textContent = "The DMA-BUF renderer is disabled for this run by an external environment variable.";
    } else if (compatibility.dmabufDisabled) {
      status.textContent = "The WebKitGTK DMA-BUF renderer is disabled for this run.";
    } else if (compatibility.riskLevel === "reported") {
      status.classList.add("warning");
      status.textContent = "This Wayland, AMD, and WebKitGTK 2.52.x profile has a reported white-preview issue.";
    } else if (compatibility.riskLevel === "possible") {
      status.textContent = "Wayland is active. Use this workaround only if the PDF preview is white or flashes while resizing.";
    } else {
      status.textContent = "No reported DMA-BUF preview compatibility profile was detected.";
    }

    const platform = [
      compatibility.distribution ?? "Linux",
      compatibility.sessionType ? `session ${compatibility.sessionType}` : "session unknown",
      compatibility.webkitVersion ? `WebKitGTK ${compatibility.webkitVersion}` : "WebKitGTK version unknown",
      compatibility.gpuVendor ? `${compatibility.gpuVendor} graphics` : "GPU vendor unknown",
      compatibility.architecture,
    ];
    details.textContent = platform.join(" | ");
    restart.classList.toggle("hidden", !restartRequired);
  }

  private async restartForRendererCompatibility(): Promise<void> {
    if (!await confirm(
      "Restart Typsastra now to apply the WebKitGTK renderer setting?",
      { title: "Restart Typsastra", kind: "warning" },
    )) return;

    if (this.saveTimer) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (!await this.persist()) return;
    try {
      await invoke("prepare_linux_renderer_relaunch", {
        disableDmabuf: this.settings.compatibility.disableWebkitDmabufRenderer,
      });
      await relaunch();
    } catch (error) {
      await message(`Typsastra could not restart automatically: ${String(error)}`, {
        title: "Restart failed",
        kind: "error",
      });
    }
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
    this.populateUnicodeFontOverrides([...fallbackFamilies].sort());
  }

  private populateUnicodeFontOverrides(families: readonly string[]): void {
    const container = document.getElementById("settings-unicode-fonts");
    if (!container) return;
    const rows = unicodeEditorFonts.map(candidate => {
      const label = document.createElement("label");
      label.textContent = candidate.language;
      const select = document.createElement("select");
      select.setAttribute("aria-label", `${candidate.language} editor fallback`);
      select.replaceChildren(
        ...[
          { id: "", label: "Use default policy" },
          { id: "auto", label: `Automatic (${candidate.label})` },
          { id: "none", label: "No fallback" },
          ...families.map(family => ({ id: family, label: family }))
        ].map(option => {
          const element = document.createElement("option");
          element.value = option.id;
          element.textContent = option.label;
          return element;
        })
      );
      select.value = this.settings.editor.unicodeFonts[candidate.id] ?? "";
      select.addEventListener("change", () => this.update(settings => {
        if (select.value === "") delete settings.editor.unicodeFonts[candidate.id];
        else settings.editor.unicodeFonts[candidate.id] = select.value;
      }));
      const row = document.createElement("div");
      row.className = "settings-unicode-font-row";
      row.append(label, select);
      return row;
    });
    container.replaceChildren(...rows);
  }

  private populateTerminology(): void {
    const container = document.getElementById("settings-terminology");
    if (!container) return;
    const entries = [
      ...this.settings.editor.globalTerminology.map((entry, index) => ({
        entry,
        scope: "Global",
        remove: () => this.update(settings => { settings.editor.globalTerminology.splice(index, 1); }),
      })),
      ...this.projectTerminology.map((entry, index) => ({
        entry,
        scope: "Project",
        remove: () => {
          const next = this.projectTerminology.filter((_, candidate) => candidate !== index);
          this.projectTerminology = next;
          this.updateProjectTerminology(next);
          this.populateTerminology();
        },
      })),
      ...this.settings.editor.languageTerminology.map((entry, index) => ({
        entry,
        scope: entry.languageFamily,
        remove: () => this.update(settings => { settings.editor.languageTerminology.splice(index, 1); }),
      })),
    ];
    if (!entries.length) {
      const empty = document.createElement("small");
      empty.textContent = "No accepted terminology has been added.";
      container.replaceChildren(empty);
      return;
    }
    container.replaceChildren(...entries.map(({ entry, scope, remove }) => {
      const row = document.createElement("div");
      row.className = "settings-language-provider";
      const term = document.createElement("span");
      term.textContent = entry.term;
      const meta = document.createElement("small");
      meta.textContent = `${scope} · ${entry.exactCase ? "exact case" : "case insensitive"}`;
      const text = document.createElement("span");
      text.className = "settings-language-provider-text";
      text.append(term, meta);
      const button = document.createElement("button");
      button.type = "button";
      button.className = "settings-secondary-button";
      button.textContent = "Remove";
      button.setAttribute("aria-label", `Remove ${entry.term} from ${scope} terminology`);
      button.addEventListener("click", remove);
      row.append(text, button);
      return row;
    }));
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
    let installedProviders: LanguageProviderCapabilities[] = [];
    try {
      installedProviders = parseLanguageProviderCapabilitiesList(
        await invoke<unknown>("get_provider_capabilities")
      );
    } catch (error) {
      console.warn("Failed to load installed language providers.", error);
    }
    const supplemental = supplementalLanguageProviders(entries, installedProviders);

    const header = document.createElement("div");
    header.className = "settings-language-catalog-header";
    header.textContent = "Downloadable dictionaries provide Basic support unless Typsastra has a tested language-specific provider. Basic support does not imply reliable segmentation or word completion.";
    const list = document.createElement("div");
    list.className = "settings-language-catalog-list";
    const rows = [
      ...entries.map(entry => ({ name: entry.displayName, row: this.renderLanguageCatalogRow(entry) })),
      ...supplemental.map(entry => ({ name: entry.displayName, row: this.renderBundledLanguageProviderRow(entry) })),
    ].sort((left, right) => left.name.localeCompare(right.name));
    list.replaceChildren(...rows.map(entry => entry.row));
    catalog.replaceChildren(header, list);
  }

  private renderBundledLanguageProviderRow(entry: LanguageProviderCapabilities): HTMLElement {
    const title = document.createElement("div");
    title.className = "settings-language-catalog-title";
    title.textContent = entry.displayName;
    const support = supportLevelPresentation(entry.supportLevel);
    const titleRow = document.createElement("div");
    titleRow.className = "settings-language-provider-title-row";
    titleRow.append(
      title,
      this.createSupportBadge(support.level, support.label, support.description),
      this.createStabilityBadge(entry.stability),
    );

    const meta = document.createElement("div");
    meta.className = "settings-language-catalog-meta";
    const typeLabel = entry.providerType === "deep" ? "Deep provider" : "Installed provider";
    meta.textContent = [
      entry.languageTag,
      "bundled",
      typeLabel,
      entry.engine,
      entry.version,
      entry.license,
      "Bundled with Typsastra",
    ].filter(Boolean).join(" · ");

    const features = document.createElement("div");
    features.className = "settings-language-provider-features";
    features.textContent = providerFeatureLabels(entry).join(" · ") || "No active language-tool capabilities";
    const text = document.createElement("div");
    text.append(titleRow, meta, features);

    const button = document.createElement("button");
    button.type = "button";
    button.className = "settings-secondary-button";
    button.textContent = "Bundled";
    button.disabled = true;

    const row = document.createElement("div");
    row.className = "settings-language-catalog-row";
    row.title = support.description;
    row.append(text, button);
    return row;
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
      this.onLanguageProvidersChanged(providers);
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
      this.onLanguageProvidersChanged(providers);
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
      for (const [id, preference] of Object.entries(this.settings.editor.unicodeFonts)) {
        if (preference !== "auto" && preference !== "none"
          && !this.systemFonts.all.some(family => family.toLocaleLowerCase() === preference.toLocaleLowerCase())) {
          delete this.settings.editor.unicodeFonts[id];
          this.scheduleSave();
        }
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
