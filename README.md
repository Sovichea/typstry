# Typstry

> A complex-script-first Typst environment for research and long-form multilingual writing.

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

## What is Typstry?

Typstry is a local-first writing environment for Typst, designed for research papers, technical documentation, theses, books, and other long-form documents.

It serves writers and researchers whose languages are not always well supported by traditional technical-writing tools. Typstry focuses on Unicode-safe editing, script-aware interaction, responsive PDF preview, extensible language tools, and multi-file project workflows while keeping the underlying Typst source portable.

Khmer is the first language with deep support, including tailored cursor and deletion behavior, spellcheck, and word completion. Khmer demonstrates the depth Typstry aims to provide; it is not the boundary of the project. The editing-policy and language-provider architecture is designed so other languages can add their own behavior without changing or weakening Khmer support.

## Screenshots

<!--
Recommended capture list:

1. Replace or update ./assets/screenshot-editor.png with a multi-file research project, editor, and docked PDF preview.
2. Add ./assets/demo-live-preview.gif showing an included chapter updating the shared full-document preview.
3. Add ./assets/demo-khmer-script-editing.gif showing Khmer cursor movement, deletion, completion, and spellcheck.
4. Add ./assets/screenshot-language-settings.png showing support levels, separate spellcheck and typing-suggestion controls, and downloadable dictionaries.
5. Add ./assets/screenshot-project-workflow.png showing main.typ, templates, chapters, bibliography, and figures in one workspace.

Keep images around 1600px wide or smaller so GitHub README loading stays reasonable.
-->

### Editor and document preview

<p align="center">
  <img src="./assets/screenshot-editor.png" alt="Typstry editor with docked document preview" width="800"/>
</p>

<!-- TODO: Add an animated multi-file preview demo.
<p align="center">
  <img src="./assets/demo-live-preview.gif" alt="Editing an included Typst chapter while the full document preview updates" width="800"/>
</p>
-->

### Khmer script-aware editing and language tools

<p align="center">
  <img src="./assets/screenshot-khmer-word-suggestion.png" alt="Khmer word completion in Typstry" width="800"/>
</p>

<!-- TODO: Add the Khmer script-aware editing demo.
<p align="center">
  <img src="./assets/demo-khmer-script-editing.gif" alt="Khmer script-aware navigation, deletion, spellcheck, and completion in Typstry" width="800"/>
</p>
-->

### Project workspace

<p align="center">
  <img src="./assets/screenshot-welcome.png" alt="Typstry welcome screen" width="800"/>
</p>

<!-- TODO: Add project-workflow and language-settings screenshots after their layouts are final.
<p align="center">
  <img src="./assets/screenshot-project-workflow.png" alt="A multi-file Typstry project with templates, chapters, bibliography, and figures" width="800"/>
</p>
<p align="center">
  <img src="./assets/screenshot-language-settings.png" alt="Typstry language settings with support levels and downloadable dictionaries" width="800"/>
</p>
-->

## Why Typstry?

Most editors treat complex-script support as a font or rendering concern. Reliable authoring also depends on cursor boundaries, deletion behavior, IME input, Unicode-safe ranges, language segmentation, completion, search, diagnostics, and consistent source-to-preview navigation.

Typstry treats these as core editor responsibilities. Script-aware editing policies remain separate from dictionaries and language tools, allowing each language to tailor only the behavior it owns. Khmer is the reference implementation for this architecture.

Typstry also treats a document as a project rather than an isolated file. A real research document may contain a main file, templates, chapters, includes, bibliography databases, figures, data, and files that can be previewed independently. Typstry is being designed around that structure while preserving compatibility with the standard Typst ecosystem.

## Highlights

- Local-first desktop authoring with ordinary, portable Typst source files.
- CodeMirror editing with Unicode-safe ranges and complex-script font fallback.
- Script-aware editing-policy registry with deeply tailored Khmer behavior.
- Khmer spellcheck and word completion through the pinned Khmer segmenter.
- English spellcheck bundled by default, with optional Hunspell-compatible dictionaries for additional languages.
- Independent controls for script-aware editing, spellcheck, and typing suggestions.
- Tinymist diagnostics and managed Typst tooling.
- Virtualized PDF preview designed for long documents and constrained memory use.
- Main-document and standalone-preview workflows for multi-file projects.
- Workspace support for templates, chapters, includes, bibliography files, figures, and external assets.

## Language support

Language support is capability-based rather than all-or-nothing:

- **Deep support** can include a script editing policy, reliable segmentation, spellcheck, and word completion. Khmer is the first deep implementation.
- **Enhanced support** can add a tokenizer or other language-specific boundary logic without requiring custom editor behavior.
- **Basic support** uses a compatible dictionary where available. This can provide useful spellcheck, but it is not presented as reliable segmentation for languages that require a dedicated tokenizer.

The long-term goal is for contributors to add a language through explicit policy and provider modules without modifying generic CodeMirror integration or another language’s implementation.

## Research-document workflow

Typstry is designed around one project identity and one configured main document. Opening an included chapter should keep the full-document preview, scroll context, and source relationships intact instead of treating every active file as a separate document.

The planned scalable workflow covers:

- project and main-document identity;
- included chapters, templates, imports, bibliographies, figures, and data;
- explicit standalone previews;
- render-on-type and render-on-save policies;
- revision-safe diagnostics, language analysis, compilation, and source navigation;
- virtualized preview rendering for long PDFs;
- workspace restoration and recovery after compiler or LSP failures.

The detailed architecture and trackable work are recorded in the [complex-script-first implementation plan](./docs/COMPLEX_SCRIPT_FIRST_IMPLEMENTATION_PLAN.md).

## Quick start

1. Download the latest installer from [Releases](https://github.com/Sovichea/typstry/releases/latest).
2. Install and open Typstry.
3. Open a Typst workspace or use an included example from the welcome screen.
4. Configure fonts, language tools, preview behavior, and the managed Tinymist toolchain in Settings.

Typstry downloads and manages Tinymist for preview and diagnostics. A separate Typst installation is not required for normal use.

## Documentation

- [Complex-script-first implementation plan](./docs/COMPLEX_SCRIPT_FIRST_IMPLEMENTATION_PLAN.md)
- [Install and build from source](./docs/INSTALL.md)
- [Development guide](./docs/DEVELOPMENT.md)
- [Settings reference](./docs/SETTINGS.md)
- [Roadmap](./docs/ROADMAP.md)
- [Troubleshooting](./docs/TROUBLESHOOTING.md)
- [Language tools providers](./docs/LANGUAGE_TOOLS.md)
- [Script-aware editor policy guide](./docs/SCRIPT_EDITING_POLICIES.md)
- [Khmer spellcheck and word completion](./docs/KHMER_SPELLCHECK.md)
- [Preview implementation notes](./docs/PREVIEW_INTERCEPTION.md)

## Beta status

Typstry is beta software. Windows and Linux builds are the most actively tested. macOS builds are experimental and require broader verification, signing, and notarization work before general release.

When reporting an issue, include:

- operating system and installer;
- Typst project structure and main-file configuration;
- language and script;
- a minimal source example where possible;
- preview, diagnostics, font, cursor, wrapping, search, or language-tool symptoms.

## For developers

```bash
git clone --recurse-submodules https://github.com/Sovichea/typstry.git
cd typstry
bun install --frozen-lockfile
bun run tauri dev
```

See the [development guide](./docs/DEVELOPMENT.md) for validation commands and contributor requirements.

## License

Typstry is released under the [MIT License](./LICENSE).
