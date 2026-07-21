# Typsastra Development Context & Design Constraints

This file serves as a consolidated reference for the architectural decisions, parser configurations, and custom editor behaviors implemented in Typsastra. It is intended to prevent regression and ensure rapid context alignment across development sessions.

---

## Current Implementation Notes (2026-07-11)

- The local `main` branch has been fast-forwarded to `origin/main`; current local work is replayed on top without unresolved merge conflicts.
- Khmer render preparation is experimental and defaults to off. Its Settings row is visible only in dev builds; production users should prefer normal Typst justification/tracking limits unless they intentionally edit settings JSON.
- Khmer typing word suggestions are independent from spellcheck. The completion provider now returns an exact known current word as the first option, for example `ការងារ`, before longer completions so Enter can accept the current word instead of forcing the next suggestion.
- Installed languages can be enabled or disabled in Editor settings. `editor.languageProviders: null` means all installed providers are active; an explicit array stores selected provider IDs. Script-aware editing remains independent. Spellcheck, corrections, and typing suggestions are used only when each provider advertises the corresponding capability.
- Language support depth uses **Basic**, **Enhanced**, and **Deep**; stability is separately **Stable** or **Experimental**. Khmer is Deep · Experimental, bundled English is Enhanced · Stable, and downloaded Hunspell-compatible dictionaries are Basic · Stable. The source of truth is `PRODUCT_DIRECTION.md`.
- Static Typst `text` language scopes are parsed with pinned `typst-syntax` off the UI thread and routed to one primary provider plus ordered disjoint-script embedded providers. Same-script languages never substitute for one another. Keyboard language controls word completion independently from spellcheck scope; see `SCOPE_AWARE_LANGUAGE_TOOLS.md`.
- Language provider capabilities use runtime-validated schema version 1. Mixed-language analysis runs every matching provider, resolves overlaps by support depth and boundary quality, and returns structured per-provider failures without discarding successful results.
- Script editing policies use contract version 1 with declarative ISO 15924 ownership and half-open Unicode code-point ranges. All movement, shift-selection, deletion, and cursor snapping route through the registry; overlapping ownership is rejected before a policy is installed.
- Khmer reference fixtures live under `tests/fixtures/khmer/` and lock editing boundaries, deletion, selection, provider tokens, upstream byte spans, CodeMirror UTF-16 ranges, and completion replacements to submodule commit `9da32875a76a27b142c58e2b13d4ff8938e9feeb`. Run `bun run test:khmer` plus the native `khmer_reference_provider_fixtures_are_locked` test after any related change.
- English (US) language tools are bundled by default as provider `hunspell:en_US`. The resource files live under `src-tauri/resources/dictionaries/hunspell/en_US/` and use Hunspell-format `en_US.aff`/`en_US.dic` from LibreOffice/SCOWL. Typsastra reads them with the pure-Rust `spellbook` engine and builds its own prefix index for typing word suggestions.
- Typst formatting is available from **Edit → Format Document** / `Ctrl+Shift+F`; **Editor → Format on save** is default off and uses Tinymist `textDocument/formatting`.
- Global app shortcuts use physical `KeyboardEvent.code` values instead of localized `event.key`, so Ctrl/Alt shortcuts continue to work under Khmer and other non-Latin keyboard layouts.
- UI text surfaces use `--font-family-sans`, which combines the UI Latin font with the selected complex-script fallback. Search panels, hover popups, fallback preview messages, and other app-rendered text should not hardcode `sans-serif` or `monospace`.
- LSP autocomplete may show a display-only `#` prefix for Typst functions/keywords, but insertion must only add `#` when Tinymist did not provide an explicit `textEdit`.
- Docked preview uses Typsastra's virtualized PDF viewer. Forward and inverse sync use Tinymist source-map positions; PDF text matching and DOM text refinement are intentionally removed because they were unreliable for Khmer, repeated text, and generated preview files. Current behavior is documented in `PREVIEW_INTERCEPTION.md`.
- Recent validation for the current work: `bun test`, `bun run build`, `cargo fmt --check` from `src-tauri/`, `cargo test --lib segmentation -- --nocapture` from `src-tauri/`, and `git diff --check`.

---

## 1. Core Architecture
- **Tech Stack**: Tauri v2 (Rust backend for system/file operations and Tinymist LSP lifecycle) + Bun/Vite (Frontend) + CodeMirror 6 (Editor).
- **Run Commands**: `bun install`, `bun run tauri dev`, `bun run tauri build`; frontend build is `tsc && vite build`. Commit `bun.lock`; use `bun install --frozen-lockfile` for clean setup and CI, and regenerate it with `bun install` whenever `package.json` changes.
- **TypeScript Mode**: `strict`, `noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch`; unused imports/params fail build.
- **Core Files**:
  - `index.html`: Single-page DOM scaffold. Feature controllers bind hardcoded element IDs, so DOM ID changes must be paired with the controller that owns that element.
  - `src/main.ts`: Six-line application entry point; imports CSS and starts `TypsastraWorkspaceController` after `DOMContentLoaded`.
  - `src/appController.ts`: Cross-feature orchestrator for workspace/tab/file lifecycle, CodeMirror, LSP coordination, diagnostics mapping, and global commands.
  - `src/settings.ts`: Versioned application-settings schema, defaults, validation, and numeric bounds.
  - `src/settingsController.ts`: Settings JSON persistence, legacy migration, settings-panel DOM, debounced writes, and runtime-change callback.
  - `src/components/explorer.ts`: Lazy workspace tree; reads the root once and loads child directories on first expansion.
  - `src/components/contextMenuController.ts`: Editor/explorer/preview context menus and filesystem actions.
  - `src/compiler/lspTransport.ts`: Sole Tauri IPC transport for Tinymist JSON-RPC; `jsonRpc.ts` parses and narrows untrusted messages.
  - `src/compiler/lsp.ts`: Typed Tinymist client and JSON-RPC request router, not a browser WebSocket.
  - `src/preview/`: Virtualized PDF preview rendering and forward/inverse preview synchronization state.
  - `src/workspace/`: Typed workspace-state persistence and recent-project rendering.
  - `src/wysiwym/adapter.ts`: WYSIWYM block parsing, DOM rendering, and Typst serialization.
  - `src/diagnostics/logConsoleController.ts`, `src/editor/fontManager.ts`, `src/editor/toolbarController.ts`, `src/layout/layoutController.ts`: Feature-local DOM/state controllers. `fontCatalog.ts` defines the selectable code and Unicode font engines; `documentTypography.ts` generates managed document font rules.
  - `src/editor/templateTypography.ts`: Pure parsing/edit helpers for local `#show: function.with(...)` templates, managed typography blocks, standalone chapter preview entries, and external-reference placeholders.
  - `src/editor/typstLanguage.ts`: StreamLanguage-based parser for Typst.
  - `src/editor/extensions.ts`: Custom CodeMirror extensions (autoclose overrides, LSP bridges, themes).
  - `src/editor/themes.ts`: Global HighlightStyle and editor layouts.
  - `src/editor/bracketColorizer.ts`: Rainbow bracket decorator.
  - `src/editor/autocomplete.ts`: LSP completions with snippet fallback; flushes pending LSP text sync before completion requests.
  - `src/editor/hover.ts`: LSP hover renderer with small local markdown parser and external-link shell open.
  - `src/editor/diagnostics.ts`: CodeMirror diagnostic underline decorations via `StateEffect`/`StateField`.
  - `src-tauri/src/lib.rs`: IPC commands, filesystem operations, toolchain download, Typst check/compile, Tinymist child-process bridge.
  - `src-tauri/src/font_store.rs`: Current-user font installation, operating-system font enumeration, allowlisted MiSans downloads, and obsolete app-cache migration.
  - `src-tauri/src/examples.rs`: Installs version-tracked writable examples under the OS Documents directory without overwriting user-modified copies.
  - `src-tauri/capabilities/default.json`: Grants broad FS/plugin permissions; frontend assumes these commands are available.

### A. Frontend Controller Flow (`src/appController.ts`)
- `bootstrap()` order matters: load settings, recent projects, CodeMirror, apply settings, explorer/toolbars/events/settings UI, show window, `ensureDependencies()`, then `initLsp()`.
- `src/main.ts` must remain composition-only. Controllers own feature DOM and local timers/state; the app controller passes callbacks for cross-feature actions.
- App visibility: welcome/editor/preview/explorer are toggled by `updateWorkspaceViewportVisibility()` based on `workspaceRootPath` and `activeFilePath`.
- Open tabs are in-memory `EditorTab` objects with `content`, `savedContent`, dirty flag, preview root, versions, selection, scroll positions, and a `temporary` flag. Temporary tabs are replaced on single-click and promoted to permanent upon editing, double-clicking, or outline interaction.
- `WorkspaceStateStore` owns versioned project-local persistence under `.typsastra/`. Portable `config.json` stores the stable project id, relative main-file path, and recommended toolchain; ignored `workspace.json` stores relative tab paths, selection/scroll/folds, explorer expansion, layout/sidebar state, and the selected local toolchain. Legacy `typsastra-workspace-${workspaceRootPath}` localStorage data is migrated once. The signed archive manifest remains exclusively `.typsastra/project.json`.
- Workspace opening is gated by a loading view until project/session metadata, main-file pinning, tabs, editor state, layout, and explorer state are restored. Render-cache preparation, Tinymist restart, and PDF compilation begin after the restored workspace is revealed.
- `RecentProjectsController` owns `typsastra-recent-projects` (max 5) and renders paths with DOM APIs rather than interpolated HTML.
- Application preferences live in the platform app-config `settings.json`; `typsastra-word-wrap` and `typsastra-theme` localStorage keys are migration inputs only and are removed after the first successful JSON save.
- Only MiSans Latin Regular/Bold and Fira Mono Regular/Bold are bundled. Rust installs both in the current user's OS font collection on first launch; Typsastra-owned filenames avoid collisions with locked pre-existing font files.
- Settings obtains its choices from `list_system_fonts`: code-font options are OS families identified as monospace, while Unicode fallback may use any installed family. `EditorFontManager` keeps both roles separate.
- Automatic Unicode detection asks for consent before an allowlisted family is downloaded and installed. It recommends MiSans where available and the corresponding Noto Sans family otherwise. Declines are remembered per script, and the user can always choose another installed family in Settings.

### B. Tauri IPC Contract (`src-tauri/src/lib.rs`)
- File commands: `read_workspace_file`, `save_workspace_file`, `create_workspace_dir`, `rename_workspace_file`, `copy_workspace_file`, `read_workspace_dir`, `move_to_trash`, `reveal_in_explorer`.
- Settings commands: `load_app_settings` and `save_app_settings`; Rust owns config-path resolution and pretty JSON disk I/O while TypeScript owns schema normalization.
- Font commands: `list_system_fonts` enumerates OS families and monospace metadata; `install_unicode_font` downloads only allowlisted official MiSans archives or Google Fonts Noto variable TTFs after frontend consent and installs them for the current user.
- Preview/document commands: `resolve_preview_main`, `cleanup_workspace_preview_files`, `check_typst_document`, `compile_typst_preview`, `compile_typst_document`.
- Toolchain/LSP commands: `ensure_toolchain`, `start_tinymist_lsp`, `send_lsp_message`.
- Tinymist is the single managed toolchain on Windows, Linux, and macOS. Stable platform assets are downloaded into app-local data; compilation uses its embedded Typst compiler and never requires a separate `typst` executable.
- `ensure_toolchain()` validates the selected managed Tinymist release and installs the latest supported stable release when necessary.
- `start_tinymist_lsp()` kills any prior child, increments a generation guard, resolves managed Tinymist, spawns `tinymist lsp`, and forwards stdio JSON-RPC as `lsp-rx`/`lsp-status` events.
- `send_lsp_message()` pushes JSON strings into an MPSC channel; frontend must send fully serialized JSON-RPC payloads.
- `check_typst_document()` and `compile_typst_preview()` invoke `tinymist compile` for diagnostics/SVG fallback.
- `compile_typst_document()` invokes `tinymist compile` and exports a PDF beside the active document.

### C. LSP/Preview Flow (`src/compiler/lsp.ts`)
- Frontend does not connect directly to `ws://127.0.0.1:8589`; Rust owns Tinymist stdio and frontend listens to `lsp-rx`.
- `TauriLspTransport` owns the single `lsp-rx` and `lsp-status` subscription plus serialized message sends. Do not add per-request event listeners.
- `connect()` starts Tinymist, attaches the transport once, sends `initialize`, then `initialized`; responses resolve through one typed pending-request map.
- Initialization disables Tinymist auto export (`exportPdf/exportSvg/exportPng: "never"`). Preview tasks request random loopback data-plane ports.
- `startPreview(path, taskId, refreshStyle)` must pass a raw OS path, not a file URI. It executes `tinymist.doStartPreview` with a stable task ID, `--not-primary`, a random loopback data-plane port, and either `on-type` or `on-save` refresh.
- Preview result normalization handles string results and object shapes containing `staticServerAddr`, `staticServerPort`, or `dataPlanePort`.
- Server requests handled locally: capability registration, message requests, workspace configuration, and `window/showDocument` for inverse sync. `window/showDocument` positions are URI-scoped; switch/load the reported file before applying its line/character.
- LSP positions use the server-negotiated `positionEncoding` from initialize capabilities. Tinymist 0.15.2 advertises `utf-16`; do not hardcode UTF-8 byte offsets. All CodeMirror conversions must go through `TinymistLspClient` helper methods.

### D. Live Sync, Diagnostics, and Preview Highlight
- Typing calls `handleContentMutation()`, queues `pendingLspSyncText`, and debounces `textDocument/didChange` using the configured preview delay.
- Completion flushes pending text sync before asking Tinymist for completions so server state matches the typed prefix.
- Manual document formatting sends `textDocument/formatting` to Tinymist and applies returned LSP text edits through CodeMirror. Format-on-save runs only in code mode and is opt-in.
- Fallback diagnostics and SVG/PDF compilation use the managed Tinymist executable's embedded Typst compiler; no standalone `typst` binary is required.
- LSP diagnostics are ignored for stale versions, package/preview files, placeholder-managed external references, and the known multi-image page-template message.
- `PreviewSyncController` owns forward/inverse navigation state. `PreviewFrame` owns direct loopback iframe sessions, retains up to five sessions by LRU, and safely hides (rather than destroys) them when rendering fallback SVG compilations for temporary tabs to avoid split-view overlapping bugs.
- `ctrl+click` on editor text uses a CodeMirror `ViewPlugin` for underline-on-hover and triggers LSP `textDocument/definition` or `textDocument/references` requests, seamlessly navigating across documents using the LSP-provided URI and UTF-16 cursor position.
- Imported sources preview through the configured main document. Independent standalone roots are disabled for v1.0 and tracked for redesign under `V1X-P.1`; the Preview setting independently selects on-type or on-save refresh.
- Research documents are keyed by normalized workspace root plus configured main file. Included sources share that preview owner; external changes flow through editor reload, render preparation, LSP notification, and one preview refresh. Example 11 is the portability fixture. See `RESEARCH_DOCUMENT_WORKFLOWS.md`.
- Reliability budgets, mixed-script benchmark fixtures, runtime performance metrics, and the seven-page PDF residency limit are defined in `PERFORMANCE_GATES.md`. Provider initialization happens after the main window is usable; performance reports are retained by Windows and Linux CI.
- Lao is the second portability implementation: installed `lo_LA` Hunspell data is tokenized by ICU4X and advertised as experimental enhanced support. Lao uses the Unicode editing baseline and registers no script policy, so Khmer ownership and behavior remain unchanged. See `LAO_LANGUAGE_SUPPORT.md`.
- If that chapter's main document applies a local `#show: function.with(...)` template, `prepareTemplateAwarePreview()` maintains a hidden workspace-root entry that imports the template and includes the chapter. Managed preview files are excluded from dependency scanning and removed on project boundaries.
- Standalone chapter entries install targeted `show ref.where(...)` placeholders for references whose labels are outside the chapter. The active chapter is still pinned to its real main document for LSP completion; placeholder-managed missing-label diagnostics are filtered without altering source.
- Changing the configured main file is a process lifecycle operation: cancel
  stale render preparation, terminate the existing Tinymist process, clear open
  documents, diagnostics, preview tasks, and source-map sockets, then start a
  fresh process for the new document graph. Ordinary tab activation within the
  same main-document project may reuse the process and execute `tinymist.pinMain`
  followed by a versioned `didChange`.
- Forward sync sends the source location directly to the matching preview task. Inverse sync honors the URI reported by Tinymist and switches source files before placing a collapsed cursor.
- Manual forward sync sends exactly one likely rendered source column. Do not
  restore timed nearby-column retries: Tinymist 0.15.2 scans the complete paged
  document for each `panelScrollTo`, so speculative retries multiply latency
  and CPU use on long documents.
- The hidden source-map WebSocket must not send Tinymist's `current` command.
  Typsastra does not consume the vector document, and forcing a full snapshot
  can block the first source lookup on thousand-page documents.
- Start the hidden source-map task after PDF presentation and treat socket-open
  only as transport readiness. The initial vector frame can precede WebSocket
  attachment, so warm-up retries a disposable `panelScrollTo` probe until a
  `jump` confirms that source mapping is usable. A real synchronization request
  remains serialized behind that readiness signal.

### E. WYSIWYM Mode
- WYSIWYM is a secondary DOM editing view, not the source of truth. `WysiwymAdapter.render()` maps Typst to blocks and `.serialize()` maps blocks back to Typst.
- Block parsing is lightweight and line-oriented: headings, tables, quotes, math blocks, raw blocks, functions, lists, and body text. It is not a full Typst AST.
- Inline formatting is regex-based after HTML escaping. Markup markers are hidden in normal view and revealed during serialization with `.serialize-mode`.
- Table parsing preserves named args in `dataset.namedArgs`, tracks columns in `dataset.cols`, and serializes each cell back as `[cell]`.
- `EditorToolbarController` has two branches: WYSIWYM mutates DOM selection/blocks then serializes to CodeMirror; Code mode inserts Typst snippets/wrappers directly into CodeMirror.
- Ctrl-click WYSIWYM links ask for confirmation before opening external URLs through Tauri shell.

---

## 2. Editor & Syntax Highlight Rules

### A. Font Fallbacks & Monospace Rendering
- **UI vs Code**: MiSans Latin is the primary UI family. Fira Mono is the default editor family; the code selector is populated from OS fonts whose metadata marks them as monospace.
- **Unicode Fallback Stack**: The chosen monospace code font precedes an optional installed fallback family. `unicodeFont: "none"` disables it, `"auto"` follows consent-based script detection, and any other value names an enumerated system family.
- **Detector Catalog**: Recommendations are optional consistency aids, not selector inventory or advertisements. Never download before confirmation. Greek/Cyrillic can use bundled MiSans Latin; scripts without a MiSans family recommend the corresponding Noto Sans family while retaining every installed fallback as a user choice.
- **String Literals**: Rendered using a monospace font (`var(--editor-code-font)`) because they serve as internal parameters/code arguments rather than output text.
- **Equations & Raw Blocks**: Rendered in monospace. Both are assigned a unified theme-aware monospace color (`--ui-monospace-color`).

### B. Bracket Colorizer Exclusions
- Rainbow bracket styling is restricted **only** to nodes classified as `"punctuation"`.
- It skips comments, strings, equations/raw blocks (`"monospace"`), and plain text parentheses/brackets (`"content"`).

### C. Context-Aware Bracket Stack (`typstLanguage.ts`)
- **Code Mode vs Markup Mode**:
  - `isCodeMode` is active if `state.inCodeLine` is true or if the top of the bracket stack is a code bracket (i.e., not a content block `[`).
  - Parentheses `(` and curly braces `{` are **only** pushed to the bracket stack if `isCodeMode` is active. Standing parentheses/braces in normal text markup (like prose parentheses) are ignored by the stack, rendered in sans-serif, and not colored.
- **Content Blocks (`[...]`)**:
  - When matched, they reset `inCodeLine = false`.
  - Pushed as `[` if matched in code mode (represents a code content block; returns `"punctuation"`, colored).
  - Pushed as `"[standalone]"` if matched in markup/text mode (returns `"content"`, not colored).
  - Popping matches either `[` or `[standalone]`, preserving correct token types.
  - In markup mode, matching `]` checks if the stack top is `[` and pops it, ensuring the parser correctly returns to code mode after inline content blocks (like `[*Hello*]`).

### D. Keywords and Functions in Nested Code
- **Without Hash (`#`)**: Inside code mode (e.g. inside function arguments), keywords like `none`, `auto`, `true`, `false`, `let`, etc. are highlighted without requiring the `#` prefix.
- **Nested Functions**: Functions called inside code blocks or parameters (e.g., `cetz.canvas(...)` or `draw-line(...)`) are matched using `/[A-Za-z_][\w.-]*(?=\s*(?:\(|\[))/` and highlighted as function names. Note that function names in code mode can contain hyphens and dots. All bold styling (`fontWeight: "700"`) has been removed from functions to keep function name rendering clean and consistent.
- **Strong & Emphasis Styling**: Strong (`*text*`) and Emphasis (`_text_`) markup are explicitly styled with `fontWeight: "bold"` and `fontStyle: "italic"` respectively in the color theme style definition.

### E. Escape Sequences & Edge Cases
- **High-Priority Escape Matching**: Escaped characters (`\\.` like `\$`) are parsed first. They return `"content"` (or `null` in code), ensuring a literal `\$` does not prematurely trigger or close equation blocks.
- **URLs as Comments**: To prevent URLs like `https://example.com` from starting single-line comments via `//`, comments are only parsed if not immediately preceded by a colon (`:`).
- **Email Domain References**: To prevent domain names in email addresses (`user@example.com`) from being matched as label references (`@example`), references starting with `@` are only matched if they are not preceded by an alphanumeric character.

### F. Escaped Symbol Auto-Close Blocking
- A custom input handler in `src/editor/extensions.ts` intercepts characters that typically auto-close (like `$`, `(`, `[`, `{`, `"`, `'`, `*`, `_`).
- If the character is preceded by `\`, the handler manually inserts only the single character, blocking CodeMirror's auto-close mechanism.

---

## 3. UI Theme System
- CSS custom variables (`--ui-bg`, `--ui-text`, `--ui-monospace-color`, etc.) are updated dynamically on theme switch via `applyUIThemeVariables` in `src/editor/extensions.ts`.
- Themes define a custom `monospace` hex value to ensure that equation/code block text matches the active editor theme palette.
- Cursor, selection, rainbow brackets, matching bracket outlines, and Typst function/reference-variable tokens are theme-scoped CSS variables. Keep their highlighting as narrow override layers using `--editor-function-color` and `--editor-variable-color`; do not replace the whole syntax theme.

### Settings Persistence and Runtime Application
- `src/settings.ts` is the canonical v1 schema. Always normalize loaded or edited values; do not trust manually edited JSON or bypass numeric bounds.
- `settings.json` is global application configuration under Tauri's `app_config_dir`, not a workspace file. The UI shows and reveals the resolved path.
- Appearance/editor/preview changes apply immediately. CodeMirror features are reconfigured through dedicated compartments; never reconstruct the editor to apply a setting.
- Settings writes are debounced. Invalid JSON falls back in memory without silently overwriting the user's file until the user changes or resets a setting.

---

## 4. Architectural Lessons & Pitfalls Log

| Feature / Bug | Failed Approach (Anti-pattern) | Working Pattern / Fix | Rationale / Gotcha |
| :--- | :--- | :--- | :--- |
| **Text Parentheses** | Pushing `(` and `{` globally to `bracketStack`. | Only push in `isCodeMode`. | Prose parentheses (e.g. `(text)`) were treated as code parameters, making their text monospace. |
| **Escaped Symbols** | Parsing escape `\` and symbol separately. | High-priority `\\.` match at start of loop. | Escaped `\$` was split, leaving `$` to start an equation block that consumed the line. |
| **URL Comments** | Generic `//` comment matching. | Require preceding char `!== ":"`. | URLs like `https://example.com` matched `//` and turned the rest of the line green. |
| **Email References** | Matching all `@identifier` globally. | Reject if preceded by alphanumeric. | Email domain names (`user@example.com`) were colored as label references. |
| **String Font** | Sans-serif font for `tags.string`. | Monospace font (`var(--editor-code-font)`). | Strings are internal configuration arguments (e.g. `lang: "en"`), not output visual content. |
| **Escaped Auto-Close**| Keymaps or custom command overrides. | `EditorView.inputHandler` checking `from - 1 === "\\"`. | Keymaps didn't intercept autocomplete insertions; `inputHandler` filters them first. |
| **Tinymist Transport** | Frontend raw WebSocket client assumptions. | Rust spawns Tinymist stdio and frontend uses `lsp-rx`/`send_lsp_message` IPC. | CSP allows local sockets for preview assets, but JSON-RPC currently flows through Tauri events/commands. |
| **LSP Positions** | Hardcoding LSP `character` as UTF-8 bytes or plain JS offsets. | Read Tinymist `capabilities.positionEncoding` and convert through `TinymistLspClient` helpers. | Tinymist 0.15.2 uses `utf-16`; wrong encoding breaks Khmer/non-ASCII inverse sync, diagnostics, hover, and completion positions. |
| **Inverse Sync Target File** | Applying `window/showDocument` line/character to whichever tab is active. | Read `params.uri`, normalize slash/case differences, switch/load that file, then compute the CodeMirror cursor. | Preview clicks can target `main.typ` or an included source while another tab is active; ignoring URI lands on the wrong code location. |
| **Inverse Sync Selection** | Selecting a word around the mapped preview-click cursor. | Use a collapsed CodeMirror cursor at the exact mapped `window/showDocument` position. | Word expansion is unreliable for Khmer, punctuation, short words, and numbers; source position accuracy is the only stable contract. |
| **Coarse Preview Source Spans** | Guessing source words from rendered text or rewriting the document to manufacture finer spans. | Treat Tinymist's URI-scoped `window/showDocument` position as the navigation contract and place a collapsed cursor. | Preview DOM access is not reliable across loopback origins; source mutation introduces compilation lag and diagnostics churn. |
| **Preview Highlight Sync** | Persisting the red `#text(...)` wrapper as document content. | Track preview-only versions, suppress diagnostics briefly, then immediately send a revert `didChange`. | Forward sync mutates only Tinymist's transient document state; saved/editor text must stay untouched. |
| **Preview Root Files** | Selecting `main.typ` only by filename or coupling root selection to refresh timing. | Build the local import/include graph and keep imported files on the configured main-document preview; select on-type/on-save refresh independently in Settings. | Filename-only routing breaks imported files, while multiple roots are deferred until source sync is reliable. |
| **Workspace Restore** | Binding state to an absolute workspace path or revealing a half-restored editor. | Store relative paths in `.typsastra/config.json` and `.typsastra/workspace.json`, restore all UI state behind the loading gate, then start compiler/preview services asynchronously. | Dirty contents are intentionally not serialized; missing paths are skipped and unsafe relative paths are rejected. |
| **Export PDF Action** | Trusting SVG preview compilation to satisfy "Export PDF". | `compile_typst_document` now compiles `.stem.export.typ` to `file_stem.pdf` and returns that PDF path. | Preview SVG and export PDF are separate workflows; keep future preview changes out of the export command. |
| **Function Highlighting Themes** | Relying on third-party CodeMirror themes where function tokens can match content color, or overriding broad syntax layers. | Set per-theme `--editor-function-color` and add only a narrow function-token highlighter after theme/font layers. | This preserves existing theme syntax while making Typst functions distinct from prose/content across all themes. |
| **Markup Content Blocks** | Ignoring `]` in markup mode. | Detect `]` in markup mode and pop `[` from the bracket stack. | Without this, the parser remained permanently trapped in markup mode after inline content blocks (like `[*Hello*]`), preventing function calls on subsequent lines from being highlighted. |
| **Function Bold Styling** | Bold function names (`fontWeight: "700"`). | Remove bold weight styling from all function highlights. | The user requested normal font weight for functions. |
| **Contextual Typst Highlighting** | Giving every `#` or identifier one fixed tag and styling only markup delimiters. | Track markup ranges, exclude trailing labels, classify `#` from its following expression, and tag references separately from declarations. | `StreamLanguage` styles only emitted spans; `#emph`, `#values.at(0)`, strings, keywords, heading whitespace, and labels require explicit semantic boundaries. |
| **Application Settings** | Keeping theme/wrap in scattered localStorage keys or rebuilding CodeMirror for each preference. | Normalize one versioned `settings.json`, persist it through Rust IPC, and apply editor toggles through compartments. | Native config paths are platform-specific; schema validation, migration, debounced writes, and live reconfiguration must remain separate concerns. |
| **Frontend Controller Decomposition** | Keeping DOM, timers, persistence, JSON-RPC, preview mapping, and feature actions in a 3,800-line `main.ts`. | Keep `main.ts` composition-only; place orchestration in `appController.ts` and feature state in callback-driven controllers/pure libraries. | Moving one giant class only renames the problem; extract ownership first, keep a single LSP transport, and test pure boundaries before reducing the entry point. |
| **Workspace Portability** | Recursive explorer startup scans, manual file-URI concatenation, Unix path case-folding, and hardcoded `.exe` names. | Lazy-load folders, centralize path/URI helpers, preserve Unix case, and resolve managed executables with PATH fallback. | Windows, macOS, and Linux differ in path identity and executable naming; portability logic must stay out of feature controllers. |
| **Editor Font Roles** | Hardcoding a small selector catalog, auto-downloading into app cache, and treating MiSans as mandatory. | Enumerate OS fonts, restrict code choices by monospace metadata, ask before per-user MiSans/Noto installation, and remember script-level declines. | Removing a system font cannot affect a privately loaded app cache; OS installation plus explicit consent makes font ownership and user choice predictable. |
| **Bun Dependency Lock** | Changing `package.json` without refreshing or committing `bun.lock`. | Run `bun install`, commit both files, and use `bun install --frozen-lockfile` in setup/CI. | Bun can otherwise resolve a different graph or omit a newly direct dependency; the frozen install makes drift fail early. |
| **Release Build Preview Blank** | Using `VSCODE_PROXY_URI` environment variable (set to `tauri.localhost`) and complex `srcdoc` HTML/JS/CSS resource inlining. | Remove `VSCODE_PROXY_URI` env, let Tinymist preview server default to loopback IP (`127.0.0.1`), and mount `iframe.src` directly. | WebView2/Chromium exempts loopback addresses (`127.0.0.1` and `localhost`) from Mixed Content blocks. The custom `tauri.localhost` domain was not exempted, causing direct loads to block and necessitating the fragile `srcdoc` inlining bypass, which broke WebSocket URL host resolution (resulting in permanent preview failure on restart/tab-switch). |
| **Forward Sync Ripple Jitter** | Triggering the scroll ripple prematurely, dispatching multiple redundant scrolls, and matching stale highlights. | Remove the red-highlight mutation hack entirely, clean up all document reverts and polling loops, and scroll directly to the cursor coordinates. | Document-mutation highlight overlays are fragile and cause compile latency and sync lag. Directly sending scroll commands to the preview coordinates is faster, cleaner, and completely reliable. |
| **Template Typography** | Assuming Latin is the base script, trusting unrestricted fallback order when fonts cover several scripts, using script show rules, or writing chapter-only rules that disappear under a main template. | Assign each script a font and scale, emit native Typst descriptors restricted by Unicode `scx`, and update the local function used by `#show: ...with(...)`. Non-unit scaling uses reusable variants in Typsastra's private global application-data cache; no fonts enter `.typsastra`. | Coverage descriptors prevent cross-script glyph capture without reconstructing content, preserving character-level source sync. Project-wide typography belongs inside the applied template. Raw content retains Typst's default font behavior. |
| **Standalone Chapter References** | Compiling an imported chapter directly and expecting labels from sibling chapters to resolve. | Build a temporary entry with the real local template and targeted external-reference placeholders; pin LSP analysis to the real main document. | Typst labels exist only within one compiled document. The helper must preserve ordinary `@label` source so other editors and final main compilation behave normally. |
| **Preview Cache After Tab Close** | Clearing `previewPane.innerHTML` while retaining iframe entries in the preview-session map. | Call `PreviewFrame.clear()` when the last tab closes and make `activateSession()` discard detached iframes. | A detached iframe can still exist as a JavaScript object, causing activation to report success while the preview pane remains blank. |
| **Live Placeholder Updates** | Generating the standalone preview entry only when the chapter tab opens. | Regenerate it during debounced on-type synchronization when the set of external references changes. | Newly typed `@labels` otherwise lack matching placeholder rules until the tab or project is reopened. |
| **Temporary Preview Tabs** | Opening a separate SVG preview path for every file peeked in the explorer. | Use the same live-preview activation path for temporary and permanent tabs, then promote temporary tabs on edit/double-click/outline interaction. | The SVG fast path did not provide a meaningful speed gain and forced a second render when a tab became permanent. |
| **Temporary Preview DOM Leak** | Wiping the `previewPane` DOM while cached live-session iframes still existed. | Hide or replace preview panes through `PreviewFrame` ownership instead of direct pane wipes. | Wiping the pane destroys the live-preview cache. Re-mounting a permanent tab can otherwise create duplicate or stale preview DOM. |
| **Ctrl+Click LSP Navigation** | Assuming `textDocument/definition` always returns a `Location` object. | Handle both `Location` (`uri`/`range`) and `LocationLink` (`targetUri`/`targetRange`) formats. | Tinymist LSP optimization returns `LocationLink` objects for definitions; strictly reading `uri` resulted in `undefined` and silent UI failures. |
| **Keyboard Shortcuts under Khmer IME** | Matching commands by localized `KeyboardEvent.key` values like `s`, `o`, or `,`. | Match physical `KeyboardEvent.code` values while preserving modifier checks. | Under Khmer and other non-Latin layouts, the printable key changes but the physical shortcut location should still activate app commands. |
| **Typst Formatting** | Saving exactly as typed or hand-rolling formatter behavior in the frontend. | Use Tinymist `textDocument/formatting` and apply LSP edits; keep format-on-save default off. | Formatting belongs to the toolchain and can be disruptive, so users need a manual command plus an explicit save-time opt-in. |
| **Hash-Prefix Autocomplete** | Prefixing both the label and `apply` text with `#` even when Tinymist supplied a `textEdit`. | Treat `#` as display-only when there is a server edit; only synthesize an inserted `#` for fallback text without a server edit. | Server edits already include the exact replacement. Prefixing them again duplicates `#` in the editor. |
| **UI Complex-Script Fallback** | Hardcoding UI surfaces as `sans-serif`, `monospace`, or `MiSans Latin`. | Use `--font-family-sans` for app text and `--font-family-mono` for code-like UI content. | Search, hover, fallback preview messages, and other non-editor UI still need the selected complex-script fallback font. |
| **Language Segmentation & Spellchecking** | Hardcoding script-specific patterns (like Khmer RegExp), scanning dictionaries sequentially, and checking spelling by whole documents. | Build generic backend registries, expose capabilities dynamically, segment/complete via UTF-16 byte range conversion, and run incremental range-based edits. Khmer uses a custom segmenter; English uses bundled Hunspell-format resources via the pure-Rust `spellbook` engine. | Unicode script ranges must not pollute frontend controllers; Rust byte offsets differ from JS UTF-16 offsets; dictionary lookups must be bounded by provider-specific indexes rather than full scans. |
| **Khmer Current-Word Completion** | Returning only longer completion candidates after a known word was fully typed. | If the active provider recognizes the typed token, insert that exact token as the first completion before ranked longer candidates. | Users can press Enter to accept the already-correct word without being forced into the next dictionary suggestion. |
| **Khmer Render Preparation Scope** | Treating generated ZWS insertion as a generally enabled typography improvement. | Keep it experimental/default off and hide its Settings row outside dev builds. | Typst justification and tracking limits can already produce reasonable Khmer output; generated segmentation remains useful for testing but should not be a normal-user default. |
| **Scoped Justification Limits** | Trying to apply `justification-limits` through `#text(...)[...]`. | Use a scoped paragraph set rule inside `#block[...]`, or a template helper that wraps content and calls `set par(justification-limits: ...)`. | `justification-limits` is a `par` property, not a `text` property. Global template `set text(...)` does not block local paragraph overrides; `#text` is simply the wrong element. |
| **Quadratic UTF-16 Offset Mapping** | Calling `utf16_to_byte_range` (which loops from index 0) for every token in a document analysis. | Build a single UTF-16 to byte offset lookup vector in a linear $O(N)$ pass, then do $O(1)$ lookup for each token. | On startup, files are analyzed in full. Quadratic scans ($O(T \times N)$) trigger millions of iterations, lagging the app by 16s in dev mode. |
| **Standalone Chapter References** | Compiling an imported chapter directly and expecting labels from sibling chapters to resolve. | Build a temporary entry with the real local template and targeted external-reference placeholders; pin LSP analysis to the real main document. | Typst labels exist only within one compiled document. The helper must preserve ordinary `@label` source so other editors and final main compilation behave normally. |
| **Preview Cache After Tab Close** | Clearing `previewPane.innerHTML` while retaining iframe entries in the preview-session map. | Call `PreviewFrame.clear()` when the last tab closes and make `activateSession()` discard detached iframes. | A detached iframe can still exist as a JavaScript object, causing activation to report success while the preview pane remains blank. |
| **Live Placeholder Updates** | Generating the standalone preview entry only when the chapter tab opens. | Regenerate it during debounced on-type synchronization when the set of external references changes. | Newly typed `@labels` otherwise lack matching placeholder rules until the tab or project is reopened. |
| **Temporary Preview Tabs** | Opening a separate SVG preview path for every file peeked in the explorer. | Use the same live-preview activation path for temporary and permanent tabs, then promote temporary tabs on edit/double-click/outline interaction. | The SVG fast path did not provide a meaningful speed gain and forced a second render when a tab became permanent. |
| **Temporary Preview DOM Leak** | Wiping the `previewPane` DOM while cached live-session iframes still existed. | Hide or replace preview panes through `PreviewFrame` ownership instead of direct pane wipes. | Wiping the pane destroys the live-preview cache. Re-mounting a permanent tab can otherwise create duplicate or stale preview DOM. |
| **Ctrl+Click LSP Navigation** | Assuming `textDocument/definition` always returns a `Location` object. | Handle both `Location` (`uri`/`range`) and `LocationLink` (`targetUri`/`targetRange`) formats. | Tinymist LSP optimization returns `LocationLink` objects for definitions; strictly reading `uri` resulted in `undefined` and silent UI failures. |
| **Keyboard Shortcuts under Khmer IME** | Matching commands by localized `KeyboardEvent.key` values like `s`, `o`, or `,`. | Match physical `KeyboardEvent.code` values while preserving modifier checks. | Under Khmer and other non-Latin layouts, the printable key changes but the physical shortcut location should still activate app commands. |
| **Typst Formatting** | Saving exactly as typed or hand-rolling formatter behavior in the frontend. | Use Tinymist `textDocument/formatting` and apply LSP edits; keep format-on-save default off. | Formatting belongs to the toolchain and can be disruptive, so users need a manual command plus an explicit save-time opt-in. |
| **Hash-Prefix Autocomplete** | Prefixing both the label and `apply` text with `#` even when Tinymist supplied a `textEdit`. | Treat `#` as display-only when there is a server edit; only synthesize an inserted `#` for fallback text without a server edit. | Server edits already include the exact replacement. Prefixing them again duplicates `#` in the editor. |
| **UI Complex-Script Fallback** | Hardcoding UI surfaces as `sans-serif`, `monospace`, or `MiSans Latin`. | Use `--font-family-sans` for app text and `--font-family-mono` for code-like UI content. | Search, hover, fallback preview messages, and other non-editor UI still need the selected complex-script fallback font. |
| **Language Segmentation & Spellchecking** | Hardcoding script-specific patterns (like Khmer RegExp), scanning dictionaries sequentially, and checking spelling by whole documents. | Build generic backend registries, expose capabilities dynamically, segment/complete via UTF-16 byte range conversion, and run incremental range-based edits. Khmer uses a custom segmenter; English uses bundled Hunspell-format resources via the pure-Rust `spellbook` engine. | Unicode script ranges must not pollute frontend controllers; Rust byte offsets differ from JS UTF-16 offsets; dictionary lookups must be bounded by provider-specific indexes rather than full scans. |
| **Khmer Current-Word Completion** | Returning only longer completion candidates after a known word was fully typed. | If the active provider recognizes the typed token, insert that exact token as the first completion before ranked longer candidates. | Users can press Enter to accept the already-correct word without being forced into the next dictionary suggestion. |
| **Khmer Render Preparation Scope** | Treating generated ZWS insertion as a generally enabled typography improvement. | Keep it experimental/default off and hide its Settings row outside dev builds. | Typst justification and tracking limits can already produce reasonable Khmer output; generated segmentation remains useful for testing but should not be a normal-user default. |
| **Scoped Justification Limits** | Trying to apply `justification-limits` through `#text(...)[...]`. | Use a scoped paragraph set rule inside `#block[...]`, or a template helper that wraps content and calls `set par(justification-limits: ...)`. | `justification-limits` is a `par` property, not a `text` property. Global template `set text(...)` does not block local paragraph overrides; `#text` is simply the wrong element. |
| **Quadratic UTF-16 Offset Mapping** | Calling `utf16_to_byte_range` (which loops from index 0) for every token in a document analysis. | Build a single UTF-16 to byte offset lookup vector in a linear $O(N)$ pass, then do $O(1)$ lookup for each token. | On startup, files are analyzed in full. Quadratic scans ($O(T \times N)$) trigger millions of iterations, lagging the app by 16s in dev mode. |
| **Autocomplete Candidate Noise** | Suggesting full dictionary sentences/phrases (e.g. from translation corpora) as word-level autocompletions. | Filter candidates to exclude characters like spaces, ASCII punctuation, Khmer full stops (`។`/`៕`), and digits. | Dictionary word lists often contain full units containing spaces and punctuation; these must be cleaned to retain only single-word completions. |
| **Khmer Spelling Words Filtering** | Using only the official 2022 list (flags correct compound words as errors) or loading the combined list unfiltered (adds noisy, long phrases with punctuation). | Revert to the combined `khmer_dictionary_words.txt` and filter out candidates containing punctuation, spaces, or digits during backend load. | Lemma-only dictionaries lack modern vocabulary/compounds; filtering noisy strings at load keeps the dictionary clean and prevents false positives. |
| **Global Hunspell Storage** | Installing hunspell dictionaries inside workspace folders or individual project paths. | Use global local data directory path (`com.typsastra.editor/dictionaries/hunspell/<locale>/`) via `app_local_data_dir()`. | Dictionaries are large and language-generic, so installing them globally avoids duplicate downloads and keeps project folders clean. |
| **Dictionary Download Integrity** | Writing stream responses directly to final paths without hashing or atomic transaction checks. | Validate downloaded aff/dic SHA-256 hashes against static catalog values and write to named temp files before renaming atomically. | Partial or failed downloads can result in corrupted dictionary files on disk that break the parser runtime or cause silent validation failures. |
| **Dictionary Uninstallation** | Deleting dictionary files without updating the active provider registry. | Clear the locale folder, unregister from settings, and call `registry.reload_installed(&data_dir)` to refresh the active provider list dynamically. | Deleting files alone keeps the old segmenter instance cached in the active provider registry until app restart. |
| **Malformed Dictionary Conditions** | Loading dictionaries with typos in condition expressions (like missing `[` before a negated character class). | Detect unmatched brackets (`]` without `[`) in rule lines and automatically prepend `[` to make the condition syntactically valid before parsing. | Upstream dictionaries (e.g., Bengali `bn_BD.aff`) can have typos that C++ Hunspell ignores but crash strict Rust regex/parser engines. |
| **Contributor Governance — Template Placement** | Placing policy and provider templates inside compiled source trees (e.g., `src/` or `src-tauri/src/`). | Place TypeScript policy templates in `src/editor/editingPolicies/template/` (not imported, not registered), and Rust provider templates in `docs/templates/` (not compiled). | Templates inside the module graph force incorrect type-checking and compilation; templates in `docs/` and a non-imported `template/` folder remain as pure documentation while still being copy-able into the real source tree. |
| **Contributor Governance — License Enforcement** | Relying on code-review process alone to catch missing dictionary licenses. | Add `validate_license(id, license())` in `SegmentationRegistry::load_providers()` and a dedicated `license_tests::all_registered_providers_have_licenses` cargo test. | Runtime rejection at startup and a dedicated test together catch new providers without licenses both locally (immediate `Err`) and in CI (test failure), without requiring reviewers to remember the check. |
| **Contributor Governance — Conformance Script** | Requiring contributors to know the exact test file list to validate policy and provider contracts. | Add `"conform"` to `package.json` scripts as a curated subset: `bun test editingPolicies khmerReference laoReference languageSupport`. | A named script is discoverable (`bun run conform`), does not require launching Tauri, and gives CI a stable target that can evolve independently of `bun test` (which runs all tests). |
