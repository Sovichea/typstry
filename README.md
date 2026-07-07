# Typstry

> A local-first Typst editor with first-class Khmer and complex-script support.

## Download Typstry

Typstry has pre-built desktop releases.

[Download the latest release](https://github.com/Sovichea/typstry/releases/latest)

Available packages:

- Windows: `.msi`
- Linux: `.AppImage` and `.deb`
- macOS: experimental build

Typstry is currently beta software. The latest public release is v0.2.2.

[![Release](https://img.shields.io/github/v/release/Sovichea/typstry?include_prereleases)](https://github.com/Sovichea/typstry/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Built with Tauri](https://img.shields.io/badge/Built%20with-Tauri-24C8DB)](https://tauri.app/)

<p align="center">
  <img src="./assets/typstry-wordmark.png" alt="Typstry" width="400"/>
</p>

## Screenshots

<!--
Recommended capture list:

1. Replace or update ./assets/screenshot-editor.png with the main editor + docked live preview.
2. Add ./assets/demo-live-preview.gif showing typing in Typst and live preview updating.
3. Add ./assets/demo-khmer-suggestions.gif showing Khmer word suggestions and spellcheck.
4. Add ./assets/screenshot-language-settings.png showing separate spellcheck, word suggestion, and language download settings.
5. Add ./assets/screenshot-template-preview.png showing main.typ + included chapter preview if you want to highlight thesis/book workflows.

Keep images around 1600px wide or smaller so GitHub README loading stays reasonable.
-->

### Editor and live preview

<p align="center">
  <img src="./assets/screenshot-editor.png" alt="Typstry editor and preview" width="800"/>
</p>

<!-- TODO: Add an animated preview demo later.
<p align="center">
  <img src="./assets/demo-live-preview.gif" alt="Typing in Typstry with live Typst preview updating" width="800"/>
</p>
-->

### Khmer and complex-script language tools

<p align="center">
  <img src="./assets/screenshot-khmer-word-suggestion.png" alt="Khmer word suggestion in Typstry" width="800"/>
</p>

<!-- TODO: Add animated Khmer language-tools demo later.
<p align="center">
  <img src="./assets/demo-khmer-suggestions.gif" alt="Khmer spellcheck and word suggestions in Typstry" width="800"/>
</p>
-->

### Welcome screen

<p align="center">
  <img src="./assets/screenshot-welcome.png" alt="Typstry welcome screen" width="800"/>
</p>

<!-- TODO: Add settings screenshot after the language download UI is visually final.
<p align="center">
  <img src="./assets/screenshot-language-settings.png" alt="Typstry language settings with spellcheck, word suggestions, and downloadable dictionaries" width="800"/>
</p>
-->

## Why Typstry?

Typstry is built for Typst documents where Unicode quality matters: Khmer, Arabic, Hebrew, Lao, Thai, Vietnamese, mixed-script technical writing, and long local documents with live preview.

Most code editors can open Typst files. Typstry focuses on the editing details that become painful in complex-script documents: font fallback, cursor behavior, local preview, language tools, and source/preview synchronization.

## Highlights

- Local-first desktop editor built with Tauri, Bun, Rust, and CodeMirror 6.
- Tinymist-powered Typst preview, diagnostics, export, and source synchronization.
- First-class complex-script font fallback for editor text and Typstry UI text.
- Khmer spellcheck and word suggestions through a custom Khmer segmenter.
- English spellcheck bundled by default, with downloadable Hunspell dictionaries for additional languages.
- Separate settings for spellcheck and typing word suggestions.
- Template-aware preview for included chapter files.
- Writable example workspace for Unicode-heavy Typst documents.

## Quick start

1. Download the latest installer from [Releases](https://github.com/Sovichea/typstry/releases/latest).
2. Install and open Typstry.
3. Open a Typst workspace or use the included examples from the welcome screen.
4. Open Settings to configure fonts, language tools, preview behavior, and the managed Tinymist toolchain.

Typstry downloads and manages Tinymist for preview/diagnostics. A separate Typst installation is not required for normal use.

## Documentation

- [Install and build from source](./docs/INSTALL.md)
- [Development guide](./docs/DEVELOPMENT.md)
- [Settings reference](./docs/SETTINGS.md)
- [Roadmap](./docs/ROADMAP.md)
- [Troubleshooting](./docs/TROUBLESHOOTING.md)
- [Language tools providers](./docs/LANGUAGE_TOOLS.md)
- [Script-aware editor policy guide](./docs/SCRIPT_EDITING_POLICIES.md)
- [Khmer spellcheck and word completion](./docs/KHMER_SPELLCHECK.md)
- [Preview interception notes](./docs/PREVIEW_INTERCEPTION.md)

## Beta status

Typstry is beta software. Windows and Linux builds are the most actively tested. macOS builds are experimental and may require additional verification, signing, and notarization work before broad distribution.

Please report issues with:

- Operating system and installer used.
- Typst document type.
- Language/script used.
- Preview, inverse sync, font, cursor, wrapping, or spellcheck problems.

## For developers

Clone and run the desktop app:

```bash
git clone --recurse-submodules https://github.com/Sovichea/typstry.git
cd typstry
bun install --frozen-lockfile
bun run tauri dev
```

Run validation before submitting changes:

```bash
bun test
bun run build
cargo fmt --manifest-path src-tauri/Cargo.toml --package typstry -- --check
cargo check --manifest-path src-tauri/Cargo.toml --lib
cargo test --manifest-path src-tauri/Cargo.toml --lib
```

More details are in [docs/DEVELOPMENT.md](./docs/DEVELOPMENT.md).

## License

Typstry is released under the [MIT License](./LICENSE).
