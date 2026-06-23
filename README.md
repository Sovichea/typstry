# Typstry - A Unicode-Aligned Typst Editor

<p align="center">
  <img src="./assets/typstry-ico.svg" alt="Typstry Logo" width="150"/>
</p>

A lightweight, local-first Typst editor with seamless Code and WYSIWYM toggles, advanced Unicode font fallbacks, and real-time Tinymist LSP previews. Built with Tauri, Bun, and CodeMirror 6.

## Screenshots

<p align="center">
  <img src="./assets/screenshot-editor.png" alt="Typstry Editor View" width="800"/>
  <br/><br/>
  <img src="./assets/screenshot-welcome.png" alt="Typstry Welcome Screen" width="800"/>
</p>

## Key Features
* **Unicode-First Philosophy**: Traditional code editors treat complex non-Latin scripts as an afterthought. Typstry is engineered from the ground up to perfectly render and align Unicode text, ensuring seamless co-existence of code and complex scripts (like Khmer, Arabic, and Thai) without breaking cursor alignment or word-wrap.
* **True Local-First Experience**: No cloud dependencies. Everything compiles instantly on your local machine.
* **Live PDF Preview**: Powered by the highly optimized Tinymist LSP running in a Rust background process.
* **Focus-Driven UI**: A custom, frameless window design with an intelligent, distraction-free workspace.
* **Blazing Fast**: Built on Tauri v2 and Bun, resulting in a tiny memory footprint compared to Electron-based editors.

## Keyboard Shortcuts
* \`Ctrl + N\`: New File
* \`Ctrl + K\`, \`Ctrl + O\`: Open Workspace
* \`Ctrl + B\`: Toggle Explorer Sidebar
* \`Ctrl + M\`: Switch Layout (Code vs WYSIWYM)
* \`Ctrl + \` \`: Toggle Log Console

## Tech Stack & Architecture
* **Core Framework**: [Tauri v2](https://v2.tauri.app/)
* **Backend (`src-tauri/`)**: Rust (Handles window configuration, system file I/O, and LSP lifecycle management)
* **Frontend Runtime (`src/`)**: Bun + Vite (TypeScript + Vanilla DOM logic with zero-React overhead)
* **Editor Component**: CodeMirror 6

## Getting Started

### Prerequisites

To run and build Typstry locally, you will need the following installed:
- [Rust](https://www.rust-lang.org/tools/install) (for the Tauri backend)
- [Bun](https://bun.sh/) (as the lightning-fast JS package manager and runtime)
- [Node.js](https://nodejs.org/) (for Vite/TS tooling compatibility)

### Installation

1. **Clone the repository**
   ```bash
   git clone https://github.com/Sovichea/typstry.git
   cd typstry
   ```

2. **Install dependencies**
   ```bash
   bun install
   ```

3. **Run in Development Mode**
   This will spin up the Vite frontend and compile the Rust backend.
   ```bash
   bun run tauri dev
   ```

### Building for Production

To compile a highly-optimized, standalone native executable for your operating system:
```bash
bun run tauri build
```
The compiled binaries will be placed in `src-tauri/target/release/`.

## TODO / Roadmap

- [x] Basic UI layout (Sidebar, Code Editor, Preview Pane)
- [x] Integrate Tinymist LSP for real-time preview and diagnostics
- [x] Custom Titlebar & Menu system
- [x] Welcome screen & Recent projects cache
- [x] Dynamic file explorer with Material icons
- [ ] Implement robust WYSIWYM (What You See Is What You Mean) layout parsing
- [ ] Persistent workspace state (tabs, cursor position, split ratios)
- [ ] Global project-wide search (`Ctrl+Shift+F`)
- [ ] Advanced Git integration
- [ ] Snippets and custom auto-complete
- [ ] Settings panel / configuration file (`settings.json`)
- [ ] Integrate Khmer word segmentation engine for accurate text highlighting and selection in the preview pane
- [ ] Embed an AI Copilot / Agent for context-aware Typst auto-completion and document drafting
- [ ] Establish cross-compilation CI/CD pipelines and verify Tauri builds for Linux and macOS
- [ ] Interactive Document Outline (Table of Contents) sidebar for quick navigation
- [ ] Integrated Typst Package Manager UI
- [ ] Multi-tab support for editing multiple files simultaneously
- [ ] Advanced Export Dialog (PDF, SVG, PNG) with configuration options
- [ ] Visual Toolbar for inserting Typst math symbols, fractions, and code snippets
