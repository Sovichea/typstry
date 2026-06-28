# Typstry Editor - Developer & AI Skills Reference

This document serves as the core knowledge base and skill reference for the Typstry Editor repository. AI agents and developers should read this file to understand the framework, technology stack, architecture boundaries, and best practices.

## 1. Technology Stack
- **Package Manager:** Bun (`bun install`, `bun run tauri dev`)
- **Desktop Framework:** Tauri v2 (Rust + Webview)
- **Frontend Core:** Vite + Vanilla TypeScript (No UI frameworks like React or Vue)
- **Editor Engine:** CodeMirror 6
- **Language Server:** Tinymist LSP spawned by the Rust backend and bridged to the frontend over Tauri IPC (`lsp-rx`, `lsp-status`, `send_lsp_message`). Tinymist preview assets may still use local `127.0.0.1` ports.
- **CLI Dependencies:** On macOS/Linux, `typst` and `tinymist` must be available in `PATH`. Windows can use managed executables downloaded into Tauri app-local data; all platforms fall back to `PATH`.

## 2. Architecture & Process Boundaries
The application operates across distinct processes and contexts:

### 2.1 Rust Native Layer (`src-tauri/`)
- **Entry Point:** `src/main.rs` hands off to `lib::run()`.
- **Tauri Plugins:** Relies heavily on `@tauri-apps/plugin-fs` (file system), `@tauri-apps/plugin-shell` (CLI invocation), and `@tauri-apps/plugin-dialog` (OS file pickers).
- **Compilation Engine:** The native backend exposes `check_typst_document` for SVG-based diagnostics and `compile_typst_document` for exporting the active document to a sibling PDF path via the local `typst` CLI.
- **Security:** `tauri.conf.json` enforces a strict CSP that explicitly allows `ws://127.0.0.1:8589` for Tinymist LSP SVG streaming.

### 2.2 Webview Frontend Layer (`src/`)
- **Entry Point (`main.ts`):** A minimal composition entry that starts `TypstryWorkspaceController` after `DOMContentLoaded`.
- **Orchestrator (`appController.ts`):** Owns cross-feature state such as the active workspace/file/tab and coordinates editor, preview, diagnostics, and native menu events. Feature behavior should live in dedicated controllers rather than growing this file.
- **Feature Controllers:** Settings, toolbar, context menu, diagnostics console, fonts, layout, preview frame/sync, recent projects, workspace persistence, and WYSIWYM conversion live in their corresponding `src/` subdirectories.
- **File Explorer (`components/explorer.ts`):** A custom DOM tree renderer that loads only the workspace root initially and reads child directories on first expansion. Do not restore eager recursive scanning.
- **CodeMirror Integration (`editor/`):** Contains `extensions.ts` and `themes.ts`. Implements a highly customized, dark-themed Unicode-compliant editor layout with basic Typst token matching.
- **LSP Interface (`compiler/`):** `lspTransport.ts` exclusively owns Tauri IPC transport, `jsonRpc.ts` validates the JSON-RPC boundary, and `lsp.ts` maps typed Tinymist operations such as changes, diagnostics, hover/completion, preview startup, and inverse sync.
- **Preview (`preview/`):** Pure source highlighting is separated from iframe DOM ownership and the preview synchronization state machine. Temporary highlight versions must never become saved editor content.

## 3. Implementation Rules & Best Practices
1. **Never use React/Vue/Svelte:** This project strictly uses `document.createElement`, `DocumentFragment`, and Vanilla TS/HTML/CSS for maximum performance and minimum footprint.
2. **File Paths:** Use `@tauri-apps/api/path` for filesystem path construction and `src/platform/paths.ts` for file URI conversion, file-name extraction, and comparison keys. Unix keys remain case-sensitive; Windows drive/UNC keys are case-folded.
3. **Event Driven:** Tinymist JSON-RPC travels through the Rust-owned Tauri IPC bridge. Do not add a frontend Tinymist WebSocket transport; local sockets are reserved for preview assets.
4. **Controller Boundaries:** DOM-heavy feature controllers own their elements and local state. `appController.ts` coordinates them through callbacks; do not move feature implementations back into the orchestrator.
5. **WYSIWYM Parsing:** Use `WysiwymAdapter.render()` and `.serialize()` when mapping DOM blocks to Typst. Preserve structural prefixes such as `= ` and table metadata.
6. **Validation:** Run `bun test`, `bun run build`, `cargo fmt --check`, `cargo check --lib`, and `cargo test --lib` after cross-boundary changes.

## 4. Common Troubleshooting
- **LSP Offline Warnings:** Verify `tinymist --version` succeeds or that the managed Windows executable exists. Port `8589` is used for preview assets, not frontend JSON-RPC.
- **LNK1104 msvcrt.lib / Rust Compile Errors on Windows:** Tauri requires the MSVC toolchain. Ensure that **Desktop development with C++** and the **Windows 10/11 SDK** are installed via the Visual Studio Installer.

## 5. Development Cycle & AI Session Handover
At the end of a session, when the user states that a task is finished and successful, the AI agent **MUST** update `DEVELOPMENT_CONTEXT.md` in the repository root. To prevent token bloat, do not write long paragraphs. Instead, record the learnings as a new row in the **Architectural Lessons & Pitfalls Log** table, specifying:
- **Feature / Bug**: The targeted feature or bug.
- **Failed Approach (Anti-pattern)**: What failed or caused regressions during implementation.
- **Working Pattern / Fix**: The successful code fix or regex pattern.
- **Rationale / Gotcha**: The key warning or explanation to prevent future regression.

*(This file should be continually updated as the project's architectural scope expands).*
