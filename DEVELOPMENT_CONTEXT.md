# Typstry Development Context & Design Constraints

This file serves as a consolidated reference for the architectural decisions, parser configurations, and custom editor behaviors implemented in Typstry. It is intended to prevent regression and ensure rapid context alignment across development sessions.

---

## 1. Core Architecture
- **Tech Stack**: Tauri v2 (Rust backend for system/file operations and Tinymist LSP lifecycle) + Bun/Vite (Frontend) + CodeMirror 6 (Editor).
- **Run Commands**: `bun install`, `bun run tauri dev`, `bun run tauri build`; frontend build is `tsc && vite build`.
- **TypeScript Mode**: `strict`, `noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch`; unused imports/params fail build.
- **Core Files**:
  - `index.html`: Single-page DOM scaffold. Feature controllers bind hardcoded element IDs, so DOM ID changes must be paired with the controller that owns that element.
  - `src/main.ts`: Six-line application entry point; imports CSS and starts `TypstryWorkspaceController` after `DOMContentLoaded`.
  - `src/appController.ts`: Cross-feature orchestrator for workspace/tab/file lifecycle, CodeMirror, LSP coordination, diagnostics mapping, and global commands.
  - `src/settings.ts`: Versioned application-settings schema, defaults, validation, and numeric bounds.
  - `src/settingsController.ts`: Settings JSON persistence, legacy migration, settings-panel DOM, debounced writes, and runtime-change callback.
  - `src/components/explorer.ts`: Lazy workspace tree; reads the root once and loads child directories on first expansion.
  - `src/components/contextMenuController.ts`: Editor/explorer/preview context menus and filesystem actions.
  - `src/compiler/lspTransport.ts`: Sole Tauri IPC transport for Tinymist JSON-RPC; `jsonRpc.ts` parses and narrows untrusted messages.
  - `src/compiler/lsp.ts`: Typed Tinymist client and JSON-RPC request router, not a browser WebSocket.
  - `src/preview/`: Pure source highlighting, iframe ownership, and forward/inverse preview synchronization state.
  - `src/workspace/`: Typed workspace-state persistence and recent-project rendering.
  - `src/wysiwym/adapter.ts`: WYSIWYM block parsing, DOM rendering, and Typst serialization.
  - `src/diagnostics/logConsoleController.ts`, `src/editor/fontManager.ts`, `src/editor/toolbarController.ts`, `src/layout/layoutController.ts`: Feature-local DOM/state controllers.
  - `src/editor/typstLanguage.ts`: StreamLanguage-based parser for Typst.
  - `src/editor/extensions.ts`: Custom CodeMirror extensions (autoclose overrides, LSP bridges, themes).
  - `src/editor/themes.ts`: Global HighlightStyle and editor layouts.
  - `src/editor/bracketColorizer.ts`: Rainbow bracket decorator.
  - `src/editor/autocomplete.ts`: LSP completions with snippet fallback; flushes pending LSP text sync before completion requests.
  - `src/editor/hover.ts`: LSP hover renderer with small local markdown parser and external-link shell open.
  - `src/editor/diagnostics.ts`: CodeMirror diagnostic underline decorations via `StateEffect`/`StateField`.
  - `src-tauri/src/lib.rs`: IPC commands, filesystem operations, toolchain download, Typst check/compile, Tinymist child-process bridge.
  - `src-tauri/capabilities/default.json`: Grants broad FS/plugin permissions; frontend assumes these commands are available.

### A. Frontend Controller Flow (`src/appController.ts`)
- `bootstrap()` order matters: load settings, recent projects, CodeMirror, apply settings, explorer/toolbars/events/settings UI, show window, `ensureDependencies()`, then `initLsp()`.
- `src/main.ts` must remain composition-only. Controllers own feature DOM and local timers/state; the app controller passes callbacks for cross-feature actions.
- App visibility: welcome/editor/preview/explorer are toggled by `updateWorkspaceViewportVisibility()` based on `workspaceRootPath` and `activeFilePath`.
- Open tabs are in-memory `EditorTab` objects with `content`, `savedContent`, dirty flag, preview root, versions, selection, and scroll positions.
- `WorkspaceStateStore` owns localStorage persistence under `typstry-workspace-${workspaceRootPath}`. It normalizes stored values, keeps tab paths/selection/scroll/split widths, and reloads content from disk; unsaved tab contents are not persisted across app restart.
- `RecentProjectsController` owns `typstry-recent-projects` (max 5) and renders paths with DOM APIs rather than interpolated HTML.
- Application preferences live in the platform app-config `settings.json`; `typstry-word-wrap` and `typstry-theme` localStorage keys are migration inputs only and are removed after the first successful JSON save.
- `EditorFontManager` scans active text for non-ASCII script ranges; Khmer bundled fonts load via `FontFace`, other script candidates depend on installed fonts and may require restart.

### B. Tauri IPC Contract (`src-tauri/src/lib.rs`)
- File commands: `read_workspace_file`, `save_workspace_file`, `create_workspace_dir`, `rename_workspace_file`, `copy_workspace_file`, `read_workspace_dir`, `move_to_trash`, `reveal_in_explorer`.
- Settings commands: `load_app_settings` and `save_app_settings`; Rust owns config-path resolution and pretty JSON disk I/O while TypeScript owns schema normalization.
- Preview/document commands: `resolve_preview_main`, `check_typst_document`, `compile_typst_document`.
- Toolchain/LSP commands: `ensure_toolchain`, `start_tinymist_lsp`, `send_lsp_message`.
- Executable resolution first checks the OS-appropriate managed filename (`.exe` only on Windows), then falls back to `PATH` for both Typst and Tinymist.
- `ensure_toolchain()` retains the Windows PowerShell download bootstrap. macOS/Linux require `typst` and `tinymist` in `PATH` and receive an actionable error otherwise.
- `start_tinymist_lsp()` kills any prior child, increments a generation guard, resolves managed/PATH Tinymist, spawns `tinymist lsp`, and forwards stdio JSON-RPC as `lsp-rx`/`lsp-status` events.
- `send_lsp_message()` pushes JSON strings into an MPSC channel; frontend must send fully serialized JSON-RPC payloads.
- `check_typst_document()` writes a hidden sibling `.stem.typstry-check.typ`, compiles SVG with short diagnostics, parses stderr, then deletes temp files.
- `compile_typst_document()` writes a hidden sibling `.stem.export.typ`, compiles a real PDF to the active file's sibling `.pdf`, deletes the temp input, and returns the PDF path string.

### C. LSP/Preview Flow (`src/compiler/lsp.ts`)
- Frontend does not connect directly to `ws://127.0.0.1:8589`; Rust owns Tinymist stdio and frontend listens to `lsp-rx`.
- `TauriLspTransport` owns the single `lsp-rx` and `lsp-status` subscription plus serialized message sends. Do not add per-request event listeners.
- `connect()` starts Tinymist, attaches the transport once, sends `initialize`, then `initialized`; responses resolve through one typed pending-request map.
- Initialization disables Tinymist auto export (`exportPdf/exportSvg/exportPng: "never"`) and enables preview background host `127.0.0.1:8589`.
- `startPreview(path)` must pass raw OS paths, not file URIs. It sends `tinymist.pinMain`, `tinymist.focusMain`, then `tinymist.doStartPreview` with `arguments: [[path]]`.
- Preview result normalization handles string results and object shapes containing `staticServerAddr`, `staticServerPort`, or `dataPlanePort`.
- Server requests handled locally: capability registration, message requests, workspace configuration, and `window/showDocument` for inverse sync. `window/showDocument` positions are URI-scoped; switch/load the reported file before applying its line/character.
- LSP positions use the server-negotiated `positionEncoding` from initialize capabilities. Tinymist 0.15.2 advertises `utf-16`; do not hardcode UTF-8 byte offsets. All CodeMirror conversions must go through `TinymistLspClient` helper methods.

### D. Live Sync, Diagnostics, and Preview Highlight
- Typing calls `handleContentMutation()`, queues `pendingLspSyncText`, and debounces `textDocument/didChange` by 350 ms.
- Completion flushes pending text sync before asking Tinymist for completions so server state matches the typed prefix.
- Fallback diagnostics run via `typst compile --diagnostic-format short --format svg` after each sync and are ignored if version/path is stale.
- LSP diagnostics are ignored for stale versions, temporary preview-only versions, package/preview files, and the known multi-image page template message.
- `PreviewSyncController` owns forward-sync timers, temporary versions, diagnostic suppression, inverse mapping, and revert scheduling. `PreviewFrame` owns iframe mounting/click capture/scrolling; `sourceHighlight.ts` contains testable pure syntax-range logic.
- Forward preview sync is a controlled hack: selected word is temporarily wrapped with `#text(fill:rgb("#fe0102"))[...]`, sent as a preview-only version, scrolled into view in the iframe, then reverted to editor text.
- Preview root resolution checks the active tab's in-memory content first: renderable active files preview themselves even when `main.typ` exists; declaration-only/library files fall back to the nearest `main.typ`, `index.typ`, or `document.typ`.
- Preview highlight only runs when `activeFilePath === previewRootPath`; library/template files receive diagnostics but no live preview highlight.
- Highlightable ranges exclude comments, raw inline code, math, block comments, and Typst code-expression spans (`#set`, `#show`, function calls, etc.).
- Inverse sync maps Tinymist `window/showDocument` source positions back through the temporary highlight mapping when present, then optionally refines the collapsed CodeMirror cursor using the clicked iframe text node/offset. Preview HTML is mounted as `srcdoc` with a `<base>` tag when available so the iframe DOM stays readable while Tinymist assets still resolve. It does not trigger forward preview sync/highlighting.

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
- **Latin Monospace Stack**: Latin monospace fonts are placed *before* language-specific Unicode fallback fonts (like *MiSans Khmer*) in the CSS font stack. This prevents the Unicode font (which has non-monospace Latin glyphs) from overriding monospace rendering for code.
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
| **Coarse Preview Source Spans** | Trusting Tinymist `window/showDocument` character offsets as exact inside rendered text runs, or guessing with parenthetical heuristics. | Mount preview HTML through same-origin `srcdoc`, capture clicked iframe text node/offset, and search that text within Tinymist's reported source line. | Tinymist can map a whole rendered run to an earlier inline span; DOM text context is needed to place the cursor after inline constructs. |
| **Preview Highlight Sync** | Persisting the red `#text(...)` wrapper as document content. | Track preview-only versions, suppress diagnostics briefly, then immediately send a revert `didChange`. | Forward sync mutates only Tinymist's transient document state; saved/editor text must stay untouched. |
| **Preview Root Files** | Resolving ancestor `main.typ` before inspecting the active file. | Prefer renderable in-memory active content, then fall back to nearest `main.typ`, `index.typ`, or `document.typ`. | Otherwise merely having `main.typ` prevents every other renderable file from previewing itself; declaration-only libraries still need the entry-point fallback. |
| **Workspace Restore** | Assuming unsaved tabs survive restart. | Restore tab paths and reload file contents from disk. | `localStorage` stores layout/selection only; dirty content is intentionally not serialized. |
| **Export PDF Action** | Trusting SVG preview compilation to satisfy "Export PDF". | `compile_typst_document` now compiles `.stem.export.typ` to `file_stem.pdf` and returns that PDF path. | Preview SVG and export PDF are separate workflows; keep future preview changes out of the export command. |
| **Function Highlighting Themes** | Relying on third-party CodeMirror themes where function tokens can match content color, or overriding broad syntax layers. | Set per-theme `--editor-function-color` and add only a narrow function-token highlighter after theme/font layers. | This preserves existing theme syntax while making Typst functions distinct from prose/content across all themes. |
| **Markup Content Blocks** | Ignoring `]` in markup mode. | Detect `]` in markup mode and pop `[` from the bracket stack. | Without this, the parser remained permanently trapped in markup mode after inline content blocks (like `[*Hello*]`), preventing function calls on subsequent lines from being highlighted. |
| **Function Bold Styling** | Bold function names (`fontWeight: "700"`). | Remove bold weight styling from all function highlights. | The user requested normal font weight for functions. |
| **Contextual Typst Highlighting** | Giving every `#` or identifier one fixed tag and styling only markup delimiters. | Track markup ranges, exclude trailing labels, classify `#` from its following expression, and tag references separately from declarations. | `StreamLanguage` styles only emitted spans; `#emph`, `#values.at(0)`, strings, keywords, heading whitespace, and labels require explicit semantic boundaries. |
| **Application Settings** | Keeping theme/wrap in scattered localStorage keys or rebuilding CodeMirror for each preference. | Normalize one versioned `settings.json`, persist it through Rust IPC, and apply editor toggles through compartments. | Native config paths are platform-specific; schema validation, migration, debounced writes, and live reconfiguration must remain separate concerns. |
| **Frontend Controller Decomposition** | Keeping DOM, timers, persistence, JSON-RPC, preview mapping, and feature actions in a 3,800-line `main.ts`. | Keep `main.ts` composition-only; place orchestration in `appController.ts` and feature state in callback-driven controllers/pure libraries. | Moving one giant class only renames the problem; extract ownership first, keep a single LSP transport, and test pure boundaries before reducing the entry point. |
| **Workspace Portability** | Recursive explorer startup scans, manual file-URI concatenation, Unix path case-folding, and hardcoded `.exe` names. | Lazy-load folders, centralize path/URI helpers, preserve Unix case, and resolve managed executables with PATH fallback. | Windows, macOS, and Linux differ in path identity and executable naming; portability logic must stay out of feature controllers. |
