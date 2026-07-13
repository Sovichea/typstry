# Settings

Open Settings from **File → Settings**, the status bar, or `Ctrl + ,`. Changes apply immediately and are persisted to `settings.json`; the panel displays the exact platform-specific file path and can reveal it in the system file manager.

```json
{
  "version": 1,
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
    "languageProviders": null,
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
    "syncDebounceMs": 120,
    "highlightDurationMs": 2200,
    "khmerRenderPreparation": false
  },
  "toolchain": {
    "tinymistVersion": null
  }
}
```

Invalid or missing fields fall back to bounded defaults. Existing theme and word-wrap values from older releases are migrated from `localStorage` the first time the settings file is created.

## Toolchain

The Toolchain panel installs stable Tinymist releases and shows each release's embedded Typst version. Tinymist is the only toolchain download: its embedded compiler handles diagnostics, fallback SVG compilation, and PDF export, so a separate Typst installation is not required.

## Preview

`renderMode` accepts `"on-type"` or `"on-save"`. Imported files preview through their configured main document. The former standalone-preview directive is disabled for v1.0 and tracked for redesign in the v1.x plan.

Forward cursor sync is temporarily disabled. Its reliability redesign and re-enablement are scheduled for the v0.9.0 prerelease.

## Fonts and typography

Only MiSans Latin and Fira Mono are bundled. Typstella installs them in the current user's font directory on first launch, avoiding administrator access on Windows, Linux, and macOS.

Settings enumerates the operating system's fonts:

- The code-font selector contains monospace families.
- The Unicode fallback selector accepts any installed family.
- Automatic detection recommends the matching MiSans family when one exists and a script-specific Noto Sans family otherwise.

Typstella never downloads fonts without confirmation and does not repeat a recommendation the user declines. MiSans downloads and use are subject to Xiaomi's [MiSans license agreement](https://hyperos.mi.com/font/en/download/); Noto fonts use the [SIL Open Font License](https://openfontlicense.org/).

The selected Unicode fallback is also included in Typstella's own UI font stack for app-rendered text such as search controls, hover popups, and preview status messages.

The typography toolbar controls the fonts used by the compiled document, separately from the editor font settings. Enable either the Latin family, the complex-script fallback family, or both. **Apply to document** writes a source-preserving fallback stack in a managed `typstella:typography` block. **Apply as template** updates the local function used by the main document's `#show: ...with(...)` rule, or creates `typstella-template.typ` when no editable local template can be identified.

The complex-script scale is uniform in both dimensions. Values other than `1.0` generate a render-only font under `.typstella/fonts/generated` and restart Tinymist with that directory as a project font path. Typstella does not create script-matching regex show rules because they break character-level inverse sync. Raw code keeps Typst's original raw font. See [Document typography](DOCUMENT_TYPOGRAPHY.md).

## Language tools

Script-aware editing, spellcheck, correction suggestions, and typing word suggestions are independent capabilities. Script-aware editing is applied automatically where Typstella has a tested policy; it does not depend on a dictionary or on spellcheck being enabled.

Spellcheck and typing word suggestions can be controlled independently in Editor settings. Corrections are shown only when the active provider advertises reliable correction support.

The **Language tools** setting chooses which installed providers participate:

- `languageProviders: null` means all available providers are enabled.
- An explicit array stores the selected provider IDs.

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
