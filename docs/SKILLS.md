# Typsastra - Developer & AI Skills Reference

This document serves as the core knowledge base and skill reference for the Typsastra repository. AI agents and developers should read this file to understand the framework, technology stack, architecture boundaries, and best practices.

## 1. Technology Stack
- **Package Manager:** Bun (`bun install`, `bun run tauri dev`)
- **Desktop Framework:** Tauri v2 (Rust + Webview)
- **Frontend Core:** Vite + Vanilla TypeScript (No UI frameworks like React or Vue)
- **Editor Engine:** CodeMirror 6
- **Bundled Fonts:** Only MiSans Latin (UI and Latin-script fallback) and Fira Mono (default code font) are bundled. The Rust font store installs both for the current user on first launch.
- **Language Server:** Tinymist LSP spawned by the Rust backend and bridged to the frontend over Tauri IPC (`lsp-rx`, `lsp-status`, `send_lsp_message`). Tinymist preview assets may still use local `127.0.0.1` ports.
- **Toolchain:** Tinymist is the single managed toolchain. `src-tauri/src/toolchain.rs` installs stable platform binaries in Tauri app-local data; compilation and export use Tinymist's embedded Typst compiler. Do not download or require a separate `typst` executable.

## 2. Architecture & Process Boundaries
The application operates across distinct processes and contexts:

### 2.1 Rust Native Layer (`src-tauri/`)
- **Entry Point:** `src/main.rs` hands off to `lib::run()`.
- **Tauri Plugins:** Relies heavily on `@tauri-apps/plugin-fs` (file system), `@tauri-apps/plugin-shell` (CLI invocation), and `@tauri-apps/plugin-dialog` (OS file pickers).
- **Compilation Engine:** The native backend exposes `check_typst_document`, `compile_typst_preview`, and `compile_typst_document` through `tinymist compile`, which is CLI-compatible with `typst compile`.
- **Security:** `tauri.conf.json` allows loopback HTTP, WebSocket, and frame ports because each Tinymist preview task owns a random local data-plane port.

### 2.2 Webview Frontend Layer (`src/`)
- **Entry Point (`main.ts`):** A minimal composition entry that starts `TypsastraWorkspaceController` after `DOMContentLoaded`.
- **Orchestrator (`appController.ts`):** Owns cross-feature state such as the active workspace/file/tab and coordinates editor, preview, diagnostics, and native menu events. Feature behavior should live in dedicated controllers rather than growing this file.
- **Feature Controllers:** Settings, toolbar, context menu, diagnostics console, fonts, layout, preview frame/sync, recent projects, workspace persistence, and WYSIWYM conversion live in their corresponding `src/` subdirectories.
- **File Explorer (`components/explorer.ts`):** A custom DOM tree renderer that loads only the workspace root initially and reads child directories on first expansion. Do not restore eager recursive scanning.
- **CodeMirror Integration (`editor/`):** Contains `extensions.ts` and `themes.ts`. Implements a highly customized, dark-themed Unicode-compliant editor layout with basic Typst token matching.
- **LSP Interface (`compiler/`):** `lspTransport.ts` exclusively owns Tauri IPC transport, `jsonRpc.ts` validates the JSON-RPC boundary, and `lsp.ts` maps typed Tinymist operations such as changes, diagnostics, hover/completion, preview startup, and inverse sync.
- **Preview (`preview/`):** Preview tasks use deterministic unique IDs per root and the user-selected refresh policy. Imported files use the configured main-document preview. Independent standalone roots are disabled for v1.0 and tracked by `V1X-P.1`.
- **Toolchain UI (`toolchain/`):** Owns stable Tinymist release selection and displays the embedded Typst version read-only.

## 3. Implementation Rules & Best Practices
1. **Never use React/Vue/Svelte:** This project strictly uses `document.createElement`, `DocumentFragment`, and Vanilla TS/HTML/CSS for maximum performance and minimum footprint.
2. **File Paths:** Use `@tauri-apps/api/path` for filesystem path construction and `src/platform/paths.ts` for file URI conversion, file-name extraction, and comparison keys. Unix keys remain case-sensitive; Windows drive/UNC keys are case-folded.
3. **Event Driven:** Tinymist JSON-RPC travels through the Rust-owned Tauri IPC bridge. Do not add a frontend Tinymist WebSocket transport; local sockets are reserved for preview assets.
4. **Controller Boundaries:** DOM-heavy feature controllers own their elements and local state. `appController.ts` coordinates them through callbacks; do not move feature implementations back into the orchestrator.
5. **WYSIWYM Parsing:** Use `WysiwymAdapter.render()` and `.serialize()` when mapping DOM blocks to Typst. Preserve structural prefixes such as `= ` and table metadata.
6. **Validation:** Run `bun test`, `bun run build`, `cargo fmt --check`, `cargo check --lib`, and `cargo test --lib` after cross-boundary changes.
7. **Font Management:** `font_store.rs` installs fonts per user and enumerates operating-system families; Settings must list only enumerated monospace families for code and all enumerated families for fallback. `editor/fontCatalog.ts` owns optional script recommendations, not selector inventory: prefer the matching MiSans family and use script-specific Noto Sans when MiSans has no family. Never download before explicit consent, and remember declined recommendations. Only Fira Mono and MiSans Latin may be bundled.
8. **Stable Toolchains Only:** Filter GitHub drafts, prereleases, semantic prerelease identifiers, and Tinymist's odd-patch nightly releases.
9. **Cross-Platform Compatibility:** Ensure cross-platform compatibility in every code edit and fix. When dealing with file paths, system paths, line endings, or OS-specific APIs, always implement solutions that work robustly across Windows, macOS, and Linux (e.g., using `filePathKey()` for case-insensitive path comparisons on Windows, or `@tauri-apps/api/path` utilities instead of hardcoding delimiters).

## 4. Common Troubleshooting
- **LSP Offline Warnings:** Check the Toolchain settings panel and the managed Tinymist binary. Frontend JSON-RPC uses Tauri IPC; only preview assets use random loopback ports.
- **LNK1104 msvcrt.lib / Rust Compile Errors on Windows:** Tauri requires the MSVC toolchain. Ensure that **Desktop development with C++** and the **Windows 10/11 SDK** are installed via the Visual Studio Installer.

## 5. Development Cycle & AI Session Handover
At the end of a session, when the user states that a task is finished and successful, the AI agent **MUST** update `docs/DEVELOPMENT_CONTEXT.md`. To prevent token bloat, do not write long paragraphs. Instead, record the learnings as a new row in the **Architectural Lessons & Pitfalls Log** table, specifying:
- **Feature / Bug**: The targeted feature or bug.
- **Failed Approach (Anti-pattern)**: What failed or caused regressions during implementation.
- **Working Pattern / Fix**: The successful code fix or regex pattern.
- **Rationale / Gotcha**: The key warning or explanation to prevent future regression.
 
## 6. Language Segmentation & Spellchecking Boundary (Contributor Contract)
To add support for a new localized script or language segmenter:
1. **Implement `LanguageSegmenter` Trait (`src-tauri/src/segmentation/provider.rs`):**
   - Implement `id()`, `pattern()` (regular expression matching the script range), `supports()`, `analyze()`, `suggestions()`, and `render_replacements()`.
2. **Register in `SegmentationRegistry` (`src-tauri/src/segmentation/registry.rs`):**
   - Add the provider instance to the registry in `SegmentationRegistry::new()`.
3. **Zero-Config Frontend Integration:**
   - The generic frontend controllers (`spellcheck.ts` and `autocomplete.ts`) dynamically fetch provider capabilities via the `get_provider_capabilities` command.
   - Never hardcode script-specific regular expressions (e.g. Khmer RegExp) or routing rules in the frontend controllers. Let the generic controllers match against the retrieved provider patterns and route requests with `provider` ID.

## 7. Script-Aware Editor Policy Boundary

Cursor movement and deletion are separate from spellcheck providers. Implement frontend script tailoring through `src/editor/editingPolicies/` and register exactly one policy per ISO 15924 script in `createDefaultEditingPolicyRegistry()`. Generic CodeMirror commands must not contain new script-specific branches. Optional composition state and decorations are exposed through the policy's `editorExtensions` and `temporaryBoundary` fields. Follow [SCRIPT_EDITING_POLICIES.md](./SCRIPT_EDITING_POLICIES.md) for the complete contract and isolation tests.

*(This file should be continually updated as the project's architectural scope expands).*
