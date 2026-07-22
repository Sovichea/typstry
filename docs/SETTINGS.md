# Settings

Open Settings from **File → Settings**, the status bar, or `Ctrl + ,`. Changes apply immediately and are persisted to `settings.json`; the panel displays the exact platform-specific file path and can reveal it in the system file manager.

```json
{
  "version": 2,
  "appearance": {
    "theme": "default",
    "editorFontSize": 14,
    "editorLineHeight": 1.7
  },
  "editor": {
    "codeFont": "Fira Mono",
    "unicodeFont": "auto",
    "spellcheck": true,
    "wordCompletion": true,
    "userDictionary": [],
    "wordWrap": true,
    "tabSize": 2,
    "lineNumbers": true,
    "highlightActiveLine": true,
    "autoCloseBrackets": true,
    "indentationGuides": true,
    "formatOnSave": false
  },
  "preview": {
    "renderMode": "on-type",
    "cursorSync": true,
    "syncDebounceMs": 100,
    "highlightDurationMs": 2200,
    "khmerRenderPreparation": false
  },
  "compatibility": {
    "disableWebkitDmabufRenderer": false
  },
  "toolchain": {
    "tinymistVersion": null
  }
}
```

Invalid or missing fields fall back to bounded defaults. Existing theme and word-wrap values from older releases are migrated from `localStorage` the first time the settings file is created.

## Project-local workspace state

Workspace-specific state lives under the project’s `.typsastra/` directory. `config.json` is portable and stores project identity, the relative main document, and the recommended toolchain. `workspace.json` stores the local editing session using relative paths, including tabs, cursor/scroll/fold state, explorer expansion, layout, sidebar visibility, and the selected toolchain override. The session file and preview cache are ignored by the managed `.gitignore`; `config.json` may be committed. Generated fonts never reside in this directory. `.typsastra/project.json` remains reserved for the signed Typsastra project-archive manifest.

Typsastra project exports include `config.json` and `workspace.json` only from this directory. Render caches, generated PDFs, maps, generated fonts, and other internal metadata are never exported. Font binaries are excluded everywhere in project and source ZIP exports regardless of location or license; recipients install required fonts separately.

## Toolchain

The Toolchain panel installs stable Tinymist releases and shows each release's embedded Typst version. Tinymist is the only toolchain download: its embedded compiler handles diagnostics, fallback SVG compilation, and PDF export, so a separate Typst installation is not required.

## Preview

`renderMode` accepts `"on-type"` or `"on-save"`. Imported files currently preview through their configured main document. The former standalone-preview directive remains disabled; its portable replacement is planned for v0.5.3 and hardened in v1.x.

`syncDebounceMs` controls the quiet period before on-type cache preparation and PDF compilation. Increasing it reduces editor contention while typing quickly; the default is 500 ms.

Forward cursor sync is temporarily disabled. Its reliability redesign and re-enablement are scheduled for the v0.9.0 prerelease.

### Linux preview compatibility

On Linux, the Preview panel reports the desktop session, WebKitGTK version, graphics vendor when detectable, CPU architecture, and whether the DMA-BUF renderer is active. A Wayland, AMD, and WebKitGTK 2.52.x combination is marked as a reported-risk profile for an all-white preview that may flash briefly while resizing. Detection is advisory and never changes the renderer automatically.

**Disable WebKitGTK DMA-BUF renderer** persists `compatibility.disableWebkitDmabufRenderer` globally. After confirmation and restart, Typsastra sets `WEBKIT_DISABLE_DMABUF_RENDERER=1` before creating the WebKit webview. This workaround may reduce rendering performance and should remain off unless the preview is affected. An environment variable supplied by an AppImage manager, shell, or desktop launcher remains authoritative and is identified separately in the compatibility status.

## Fonts and typography

Only MiSans Latin and Fira Mono are bundled. Typsastra installs them in the current user's font directory on first launch, avoiding administrator access on Windows, Linux, and macOS.

Settings enumerates the operating system's fonts:

- The code-font selector contains monospace families.
- The Unicode fallback selector accepts any installed family.
- Automatic detection recommends the matching MiSans family when one exists and a script-specific Noto Sans family otherwise.

Typsastra never downloads fonts without confirmation and does not repeat a recommendation the user declines. MiSans downloads and use are subject to Xiaomi's [MiSans license agreement](https://hyperos.mi.com/font/en/download/); Noto fonts use the [SIL Open Font License](https://openfontlicense.org/).

The selected Unicode fallback is also included in Typsastra's own UI font stack for app-rendered text such as search controls, hover popups, and preview status messages.

The typography toolbar controls the fonts used by the compiled document, separately from the editor font settings. Enable either the Latin family, the complex-script fallback family, or both. **Apply to document** writes a source-preserving fallback stack in a managed `typsastra:typography` block. **Apply as template** updates the local function used by the main document's `#show: ...with(...)` rule, or creates `typsastra-template.typ` when no editable local template can be identified.

Document Typography assigns one font and uniform scale to each configured script. Typsastra emits native Typst `covers` descriptors using Unicode Script Extensions (`scx`), so a font's extra glyphs cannot consume text assigned to another script and the entries may appear in any order. Values other than `1.0` use a render-only variant from Typsastra's private global application-data cache and restart Tinymist with only the selected cache directories as font paths. Compiler-embedded fonts remain locked to `1.0` unless the same family is installed locally; manually assigning them another scale produces an error and resets the directive to `1.0` because Typsastra does not extract embedded font files. Matching variants are reused across projects without rescaling, and no font data is stored in `.typsastra`. Typsastra recommends at most 10 cached scale variants per font face and asks before creating another; it never deletes variants automatically. Non-unit scaling is experimental for PDF output because Typst may normalize generated fonts while subsetting them; use `1.0` when dependable PDF export is required. Typsastra does not create script-matching show rules because they break character-level inverse sync, and it does not patch the resulting PDF or make preview differ from export. Raw code keeps Typst's original raw font. See [Document typography](DOCUMENT_TYPOGRAPHY.md).

## Language tools

Script-aware editing, spellcheck, correction suggestions, and typing word suggestions are independent capabilities. Script-aware editing is applied automatically where Typsastra has a tested policy; it does not depend on a dictionary or on spellcheck being enabled.

Spellcheck and typing word suggestions can be controlled independently in Editor settings. Corrections are shown only when the active provider advertises reliable correction support.

Settings installs language providers globally. A provider participates in a
document only after its language is assigned to a script through the Typography
toolbar and stored in the configured main file's `typsastra:document-scripts`.
That one assignment is inherited by included chapters, imported templates, and
imported local libraries; it does not need to be copied into those files.
Unrelated files inherit nothing and may declare their own routing.

**Add language...** opens the catalog dialog to download additional Hunspell dictionaries. Each catalog entry row displays detailed onboarding metadata:
- **Provider Type:** Displays the type level (e.g. `Deep provider` or `Dictionary only`).
- **Support Level:** Displays support depth (Basic, Enhanced, Deep) and stability (Stable, Experimental).
- **Download Size:** The combined byte size of the `.aff` and `.dic` files.
- **License & Version:** Explicit license terms (e.g. `MPL 2.0 / GPL` or `LGPL`) and dictionary version.

Each installed downloadable language can be uninstalled from this menu. Clicking the red **Remove** button deletes the files from the local storage folder and cleanly unregisters the language provider dynamically.

Installed languages display both support depth and stability:

- **Basic** provides dictionary-backed spelling with general boundaries and does not imply reliable segmentation or completion.
- **Enhanced** adds a tested tokenizer, word completion, or another language-aware capability.
- **Deep** combines dedicated language tooling with script-aware editing where the script requires tailoring.
- **Experimental** is a separate stability label and may appear alongside any depth level.

Bundled providers include:

- Khmer through the custom Khmer segmenter.
- English (US) through Hunspell-format dictionary resources.

Khmer is currently **Deep · Experimental** (advertised as `Deep provider`). Bundled English is **Enhanced · Stable** (advertised as `Dictionary only`). Downloaded Hunspell-compatible dictionaries are **Basic · Stable** unless a tested language-specific provider supersedes them.

Provider architecture is documented in [LANGUAGE_TOOLS.md](./LANGUAGE_TOOLS.md), and modern Khmer encoding policy is documented in [KHMER_SPELLCHECK.md](./KHMER_SPELLCHECK.md).

Khmer render preparation leaves source files unchanged and, when explicitly enabled, generates preview/export input with zero-width word-break opportunities. This renderer path is experimental, defaults off, and its Settings row is shown only in dev builds.

## Formatting

Typst formatting is available from **Edit → Format Document** or `Ctrl+Shift+F`. **Format on save** is an Editor setting and defaults off.

## Keyboard shortcuts

- `Ctrl + N`: New File
- `Ctrl + K`, `Ctrl + O`: Open Workspace
- `Ctrl + B`: Toggle Explorer Sidebar
- `Ctrl + ,`: Open Settings
- `Ctrl + Shift + F`: Format Document
- `Alt + Z`: Toggle Word Wrap
- `Ctrl + ~`: Toggle Log Console

Shortcuts are matched by physical key position, so they continue to work under Khmer and other non-Latin keyboard layouts.
