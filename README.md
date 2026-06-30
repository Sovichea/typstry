# Typstry - A Unicode-Aligned Typst Editor

<p align="center">
  <img src="./assets/typstry-wordmark.png" alt="Typstry" width="400"/>
</p>

A lightweight, local-first Typst code editor with advanced Unicode font fallbacks and real-time Tinymist LSP previews. Built with Tauri, Bun, and CodeMirror 6.

## Screenshots

<p align="center">
  <img src="./assets/screenshot-welcome.png" alt="Typstry application view" width="800"/>
  <br/><br/>
  <img src="./assets/screenshot-editor.png" alt="Typstry Welcome Screen" width="800"/>
</p>

## Key Features
* **Unicode-First Philosophy**: Traditional code editors treat complex non-Latin scripts as an afterthought. Typstry is engineered from the ground up to perfectly render and align Unicode text, ensuring seamless co-existence of code and complex scripts (like Khmer, Arabic, and Laos) without breaking cursor alignment or word-wrap.
* **Rich IDE-Grade Autocompletion**: Smart, context-aware suggestions with LSP `sortText` prioritization (which correctly places specific parameters like `numbering` or `supplement` at the top of the list). Intelligently blocks autocomplete from triggering on brackets, punctuation, or spaces to ensure a distraction-free typing flow.
* **True Local-First Experience**: No cloud dependencies. Everything compiles instantly on your local machine.
* **Live Document Preview**: Powered by Tinymist with bidirectional source synchronization and compiler-rendered SVG fallback.
* **Managed Toolchain**: The settings panel installs stable Tinymist releases. Tinymist's embedded Typst compiler handles preview, diagnostics, and export; no separate Typst installation is required.
* **Focus-Driven UI**: A custom, frameless window design, persistent multi-tab workspace state (preserving open tabs, split ratios, and cursor positions), and integrated native-feel search and replace.
* **Native Settings System**: A compact settings panel with live editor reconfiguration and a versioned `settings.json` stored in the platform application-config directory.
* **Context-Aware Editor & Bracket Colorizer**: Implements intelligent syntax recognition, skipping bracket coloring inside comments, strings, and equations. Integrates theme-aware monospace coloring for raw code/equations, nested function coloring without requiring `#` prefixes, and precise parsing of escaped symbols (like `\$` for literal dollars and ignoring URL comments).
* **Blazing Fast**: Built on Tauri v2 and Bun, resulting in a tiny memory footprint compared to Electron-based editors.

## Keyboard Shortcuts
* `Ctrl + N`: New File
* `Ctrl + K`, `Ctrl + O`: Open Workspace
* `Ctrl + B`: Toggle Explorer Sidebar
* `Ctrl + ,`: Open Settings
* `Alt + Z`: Toggle Word Wrap
* `Ctrl + ` `: Toggle Log Console

## Settings

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
    "wordWrap": true,
    "tabSize": 2,
    "lineNumbers": true,
    "highlightActiveLine": true,
    "autoCloseBrackets": true,
    "indentationGuides": true
  },
  "preview": {
    "cursorSync": true,
    "syncDebounceMs": 120,
    "highlightDurationMs": 2200
  },
  "toolchain": {
    "tinymistVersion": null
  }
}
```

Invalid or missing fields fall back to bounded defaults. Existing theme and word-wrap values from older releases are migrated from `localStorage` the first time the settings file is created.

The Toolchain panel installs stable Tinymist releases and shows each release's embedded Typst version. Tinymist is the only toolchain download: its embedded compiler handles diagnostics, fallback SVG compilation, and PDF export, so a separate Typst installation is not required.

Each preview root has a uniquely identified Tinymist task whose iframe is cached across tab switches. When an open file is imported by another Typst file, Typstry previews the top-level importing document and updates that preview on save. Put `//@allow-preview` on the imported file's first line to preview that file itself and update it live while editing.

Only MiSans Latin and Fira Mono are bundled. Typstry installs them in the current user's font directory on first launch, avoiding administrator access on Windows, Linux, and macOS. Settings enumerates the operating system's fonts: the code-font selector contains monospace families, while Unicode fallback accepts any installed family. Automatic detection recommends the matching MiSans family when one exists and a script-specific Noto Sans family otherwise. It never downloads without confirmation and does not repeat a recommendation the user declines. Recommendations are optional; users can select any installed fallback or disable fallback entirely. MiSans downloads and use are subject to Xiaomi's [MiSans license agreement](https://hyperos.mi.com/font/en/download/); Noto fonts use the [SIL Open Font License](https://openfontlicense.org/).

## Tech Stack & Architecture
* **Core Framework**: [Tauri v2](https://v2.tauri.app/)
* **Backend (`src-tauri/`)**: Rust (Handles window configuration, system file I/O, and LSP lifecycle management)
* **Frontend Runtime (`src/`)**: Bun + Vite (TypeScript + Vanilla DOM logic with zero-React overhead)
* **Editor Component**: CodeMirror 6

## Getting Started

Typstry supports native development on Windows, Linux, and macOS. Install the prerequisites for the host operating system, then follow the shared project setup.

Node.js and the standalone `typst` CLI are not required. Bun runs the frontend toolchain, while Typstry downloads and manages Tinymist on first launch.

### Windows

Effective minimum: Windows 10 version 1809 or later, as required by Bun.

1. Install [Microsoft C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/). Select **Desktop development with C++** and a Windows 10 or 11 SDK.
2. Ensure the [Microsoft Edge WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/) is installed. It is normally already present on supported Windows versions.
3. Install Rust with the MSVC toolchain:

   ```powershell
   winget install --id Rustlang.Rustup
   rustup default stable-msvc
   ```

4. Install Bun:

   ```powershell
   powershell -c "irm bun.sh/install.ps1|iex"
   ```

5. Restart the terminal so the new `PATH` entries are visible.

If MSI packaging fails with `light.exe` or VBSCRIPT errors, enable **VBSCRIPT** under Windows Optional Features. This is needed only for MSI generation.

### macOS

Effective minimum: macOS 13 or later, as required by current Bun releases. Both Apple Silicon and Intel hosts are supported.

1. Install the Xcode Command Line Tools. Full Xcode is only necessary for Apple signing, notarization, or iOS development.

   ```bash
   xcode-select --install
   ```

2. Install Rust and Bun:

   ```bash
   curl --proto '=https' --tlsv1.2 https://sh.rustup.rs -sSf | sh
   curl -fsSL https://bun.com/install | bash
   ```

3. Restart the terminal or load the shell profile updated by the installers.

### Linux

Install the WebKitGTK 4.1 and native build dependencies for your distribution.

Debian/Ubuntu:

```bash
sudo apt update
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file \
  libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev unzip
```

Fedora:

```bash
sudo dnf install webkit2gtk4.1-devel openssl-devel curl wget file \
  libappindicator-gtk3-devel librsvg2-devel libxdo-devel unzip
sudo dnf group install "c-development"
```

Arch Linux:

```bash
sudo pacman -Syu
sudo pacman -S --needed webkit2gtk-4.1 base-devel curl wget file openssl \
  appmenu-gtk-module libappindicator-gtk3 librsvg xdotool unzip
```

Then install Rust and Bun:

```bash
curl --proto '=https' --tlsv1.2 https://sh.rustup.rs -sSf | sh
curl -fsSL https://bun.com/install | bash
```

Restart the terminal or load the updated shell profile before continuing. For other distributions, use the equivalent packages from the [official Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).

### Project setup

The following commands are the same in PowerShell, bash, and zsh:

```bash
git clone https://github.com/Sovichea/typstry.git
cd typstry
bun install --frozen-lockfile
```

`bun.lock` is committed and is the reproducible dependency source for local development and CI. After changing `package.json`, run `bun install` and commit both files; routine setup and CI should keep using `bun install --frozen-lockfile` so an outdated lockfile fails immediately.

Verify the environment:

```bash
git --version
rustc --version
cargo --version
bun --version
```

Start the complete desktop development environment:

```bash
bun run tauri dev
```

The first launch requires internet access to retrieve the selected stable Tinymist binary from GitHub. Later launches use the managed copy in the platform application-data directory.

`bun run dev` starts only Vite in a browser. It is useful for isolated styling work, but native filesystem access, dialogs, settings persistence, Tinymist, and Tauri IPC will not work there.

### Validation

Run the frontend and Rust checks before submitting changes:

```bash
bun test
bun run build
cd src-tauri
cargo fmt --all -- --check
cargo check --lib
cargo test --lib
```

### Native release build

Build on each target operating system; a normal local Tauri build does not produce installers for the other operating systems.

```bash
bun run tauri build
```

The native executable is written under `src-tauri/target/release/`. Installers and application bundles are written under `src-tauri/target/release/bundle/`, with platform-specific subdirectories such as `nsis`/`msi`, `deb`/`rpm`/`appimage`, or `dmg`/`macos`.

Windows signing and macOS signing/notarization are not required for local development, but they are required for trusted public distribution. Linux package availability depends on the packaging tools supported by the build distribution.

The current development release is `v0.1.1`.

### Common setup problems

- `LNK1104: cannot open file 'msvcrt.lib'`: install the Visual Studio **Desktop development with C++** workload and Windows SDK, then restart the terminal.
- `webkit2gtk-4.1` or `javascriptcoregtk-4.1` missing: install the Linux packages listed above for the current distribution.
- `bun` or `cargo` is not found after installation: restart the terminal and verify that `~/.bun/bin` and `~/.cargo/bin` are on `PATH`.
- Tinymist cannot be downloaded: verify GitHub access and retry from **Settings → Toolchain**. A system `typst` executable does not replace the managed Tinymist requirement.
- Native features fail under `bun run dev`: use `bun run tauri dev` so the frontend runs inside the Tauri webview.

## TODO / Roadmap

- [x] Basic UI layout (Sidebar, Code Editor, Preview Pane)
  - [x] Code Editor pane integration
  - [x] Live Preview pane layout
  - [x] Sidebar layout for tools and file explorer
- [x] Integrate Tinymist LSP for real-time preview and diagnostics
  - [x] Rust-based background process management for stable preview server
  - [x] Forward-sync functionality between code editor and preview
  - [x] Cross-zoom-level scrolling synchronization
- [x] Custom Titlebar & Menu system
  - [x] Frameless window design
  - [x] Native-feel titlebar controls
- [x] Welcome screen & Recent projects cache
  - [x] Hide editor panes when no file is active
  - [x] Automate transition from welcome screen to workspace
- [x] Dynamic file explorer with Material icons
  - [x] Material icon integration
  - [x] Custom Rust backend commands for secure file operations (create, rename, copy)
- [-] Implement robust WYSIWYM (What You See Is What You Mean) layout parsing
  - [x] Intelligent toggle-formatting logic for inline editing
  - [x] DOM-to-markup serialization pipeline
  - [x] Hide technical syntax markers during active editing
  - [ ] Block-level element parsing and visual rendering
- [x] Persistent workspace state (tabs, cursor position, split ratios)
  - [x] Multi-tab support for editing multiple files simultaneously
  - [x] Show welcome screen on app startup, loading workspace state only when opening a recent project
  - [x] Remember open files and cursor positions across sessions
  - [x] Persistent split ratios
  - [x] Save status indicator tracking unsaved changes
- [x] Visual Toolbar for inserting Typst math symbols, fractions, and code snippets
  - [x] UI implementation for visual toolbar
  - [x] Logic to insert symbols and markup correctly
- [ ] Global project-wide search (`Ctrl+Shift+F`)
  - [ ] Search interface and UI
  - [ ] Result navigation and highlighting
- [ ] Advanced Git integration
  - [ ] Status indicators in file explorer
  - [ ] Inline diff viewing
  - [ ] Commit, push, and pull UI
- [x] Snippets and custom auto-complete
  - [x] Context-aware snippets for Typst
  - [x] Auto-complete UI integration
- [x] Context-aware syntax highlighting & editor enhancements
  - [x] Theme-aware unified styling for equations and code blocks
  - [x] Bracket colorizer exclusions (ignores comments, strings, and monospace)
  - [x] Nested function/identifier highlighting without `#` in code mode
  - [x] Escaped character handling (correctly parses `\$` as literal and prevents false comment/reference triggers)
  - [x] Escaped symbol auto-closing prevention
- [x] Settings panel / configuration file (`settings.json`)
  - [x] UI for appearance, editor, and preview preferences
  - [x] Native persistent settings storage and legacy preference migration
- [ ] Integrate Khmer word segmentation engine for accurate text highlighting and selection in the preview pane
  - [ ] Implement [Khmer Segmenter](https://github.com/Sovichea/khmer_segmenter)
  - [ ] Hook engine into preview highlight logic
- [ ] Embed an AI Copilot / Agent for context-aware Typst auto-completion and document drafting
  - [ ] API integration for language model
  - [ ] Inline UI for code suggestions
- [ ] Establish cross-compilation CI/CD pipelines and verify Tauri builds for Linux and macOS
  - [x] GitHub Actions workflow for automated builds
  - [x] Verify and fix Linux builds
  - [ ] Verify and fix macOS builds
- [x] Interactive Document Outline (Table of Contents) sidebar for quick navigation
  - [x] Parse document headers via LSP
  - [x] Outline UI sidebar
- [ ] Integrated Typst Package Manager UI
  - [ ] Package search and discovery interface
  - [ ] Package installation and update handling
