# Complex-Script-First Implementation Plan

## Product direction

Typstry is a complex-script-first writing environment for Typst, designed for research papers, technical documentation, theses, books, and other long-form documents.

Khmer is the first language with deep support. It is the reference implementation for script-aware editing and language tooling, but it must not become a special case embedded throughout the editor. New languages must be able to add their own editing policy, tokenizer, dictionary provider, completion behavior, and capabilities without changing or weakening Khmer behavior.

The project should solve the complete authoring workflow:

- Unicode-safe source editing;
- script-aware navigation, selection, composition, and deletion;
- extensible spellcheck and word completion;
- reliable Typst diagnostics and PDF preview;
- scalable multi-file research projects;
- portable Typst source and clean PDF output.

## Direction record: context that must be preserved

Typstry must not be reduced to a “Unicode-friendly Typst editor” or presented as “Typst with better Khmer rendering.” Unicode correctness is foundational, but it is not the complete product.

The project exists to address the whole academic and technical writing workflow for languages that traditional technical-writing tools often treat as edge cases. That includes source editing, language-aware interaction, project organization, diagnostics, preview, navigation, and final output.

The intended positioning is:

> Typstry is a complex-script-first Typst writing environment, with Khmer as the first deeply supported language.

This positioning has four consequences:

1. **Khmer demonstrates depth, not exclusivity.** Khmer receives tailored editing and language tools, while the underlying contracts must allow other languages to reach the same depth independently.
2. **Complex scripts are first-class requirements.** Unicode-safe offsets, shaping, grapheme behavior, font fallback, IME input, bidirectional text, and language boundaries must influence architecture from the beginning.
3. **The document is a project, not one file.** A serious research document may contain a main file, templates, chapters, includes, bibliography databases, figures, data, and files that can also be previewed independently.
4. **The workflow must scale.** The same design must remain understandable and responsive for a short note, a thesis, a technical proposal, or a long book without making the Typst source dependent on Typstry.

Typstry’s long-term goal is to make academic and technical writing more accessible for languages that have historically been underserved by documentation and publishing tools. Product and architecture decisions should be evaluated against that goal.

## Scope

This plan targets the code-based Typst authoring experience through the v1.x series. A WYSIWYM editor is not part of this plan and remains a possible v2.0 direction.

The plan does not promise identical features for every language. Each provider must report its actual capabilities and boundary quality. Basic Hunspell compatibility is useful fallback support, but it must not be described as deep support for a language that requires a dedicated segmenter or editing policy.

## Tracking convention

Every task has a stable phase ID such as `P2.3`. Use that ID in issues, commits, and progress reports. A task is complete only when its implementation, tests, and documentation are committed together. A phase is complete only when every task and acceptance criterion in that phase is checked.

Task dependencies are written as `Depends on`. Tasks without an explicit dependency may be implemented independently within their phase.

## Design principles

1. **Complex scripts are a baseline requirement.** UTF-16 offsets, grapheme boundaries, shaping, bidirectional text, IME input, and font fallback must be considered in generic editor code.
2. **Khmer is the regression baseline, not the global default.** Khmer-specific behavior stays inside Khmer policy and provider modules.
3. **Editing policy and language tooling remain separate.** Cursor behavior must not depend on a dictionary or native request. Spellcheck must not alter editor navigation.
4. **Capabilities are explicit.** The UI only exposes spellcheck, correction, completion, segmentation, or script-aware editing when the selected provider supports it reliably.
5. **Partial support is labeled honestly.** A fallback dictionary may provide useful spellcheck without claiming reliable tokenization or completion.
6. **Source remains portable.** Typstry metadata and caches must not contaminate saved Typst source or become required to compile a project elsewhere.
7. **Long documents are normal workloads.** Multi-file projects and large PDFs are design targets, not exceptional cases.
8. **No provider may interfere with another.** Mixed-script documents must route each range to its owning policy or provider and merge independent results safely.

## Existing foundation

Typstry already has several parts of this architecture:

- the script editing policy registry under `src/editor/editingPolicies/`;
- Khmer-tailored grapheme navigation, deletion, and temporary composition boundaries;
- a native language-provider registry with Khmer and Hunspell-compatible providers;
- provider-neutral analysis, completion, and suggestion commands;
- downloadable language dictionaries and bundled English support;
- CodeMirror editing, Tinymist diagnostics, PDF preview, and multi-file workspaces;
- document revision guards for asynchronous language results;
- persistent project settings and language-tool preferences.

The next work should harden these foundations, expose their limits clearly, and prove that another complex script can be added without Khmer regressions.

## Scalable research-document workflow

This section is the reference workflow for implementation. Individual tasks may change internally, but the ownership boundaries and ordering below should remain stable unless this document is deliberately revised.

### Workflow overview

```text
Open workspace
  -> identify project and main document
  -> discover file roles and dependencies
  -> restore editor buffers and project state
  -> edit canonical in-memory source
  -> publish ordered LSP and language-tool revisions
  -> create a revision-consistent compilation snapshot
  -> update one project preview session
  -> navigate between source files without replacing the document preview
  -> save or export portable Typst source and PDF
```

### Step 1: Establish project identity

The workspace root is the stable project identity. The configured main Typst file identifies the full compiled document. Open tabs are views into project files; they do not define separate documents merely because they are active.

Required state:

```text
workspaceKey
workspaceRoot
mainFilePath | null
projectRevision
activeFilePath | null
previewSessionKey | null
```

Rules:

- A workspace can exist without a configured main file.
- A configured main file remains the document root when an included file becomes active.
- A file becomes a separate preview document only through an explicit standalone-preview action or directive.
- Paths must use one canonical comparison form while preserving their display form.

Tracked by `P6.1`, `P6.2`, `P6.3`, and `P6.8`.

### Step 2: Classify project files by role

Typstry should recognize that files participate in different parts of the writing workflow:

```text
main source
included chapter or section
template or library
bibliography database
figure or image
data file
standalone Typst document
generated Typstry cache
```

File roles control navigation and preview behavior, not whether the files remain ordinary portable project files. Typstry metadata must never be required by the Typst compiler.

The explorer should hide generated cache files, preserve ordinary project organization, and allow navigation from include, import, bibliography, image, and template references.

Tracked by `P6.3`, `P6.4`, `P6.9`, and `P6.10`.

### Step 3: Maintain one canonical editing state per open file

Each open source file needs a stable document key and a monotonically increasing revision. The CodeMirror document is the canonical unsaved state while the file is open. Disk content is the last saved state, not a competing editor state.

Required state per file:

```text
documentKey
filePath
editorDocumentIdentity
revision
savedRevision
diskFingerprint
dirty
```

Rules:

- Increment the revision synchronously for every content or identity change.
- Never apply diagnostics, language results, completion, or source-map results to a different revision.
- Opening, promoting, restoring, or switching tabs must not mark an unchanged file as dirty.
- External changes must be reconciled through an explicit ordered path rather than silently replacing newer editor content.

Tracked by `P2.7`, `P6.5`, `P6.7`, and `P6.8`.

### Step 4: Build and update a project dependency graph

The main document depends on includes, imports, templates, bibliographies, figures, and data. Typstry should maintain a lightweight dependency graph so a change can invalidate the correct document without rescanning or restarting every open preview.

The graph should record:

```text
source file -> referenced project files
referenced file -> affected document roots
reference kind and source range
last resolved project revision
```

Start with Typst syntax information and LSP data where reliable. Fall back conservatively when a dependency is dynamic. A dynamic dependency may require invalidating the main document, but it must not create a new preview session.

Tracked by `P6.1`, `P6.2`, `P6.4`, `P6.5`, and `P6.10`.

### Step 5: Route every edit through one ordered change pipeline

An editor transaction should produce one project change event. Consumers may debounce their own work, but they must observe the same document revision.

```text
CodeMirror transaction
  -> update document revision and dirty state
  -> update dependency information when relevant
  -> notify LSP with that revision
  -> schedule incremental language analysis
  -> schedule preview according to render policy
  -> persist recoverable workspace state
```

No consumer should watch and reinterpret editor text independently. Duplicate file watchers, mirror writers, and preview schedulers create races where LSP diagnostics and rendered content refer to different source revisions.

Tracked by `P6.5`, `P6.6`, `P6.7`, `P7.3`, and `P7.6`.

### Step 6: Keep render policies as explicit state machines

Render behavior must not be inferred from incidental save events or file-watcher notifications.

#### Render on type

```text
edit committed
  -> debounce
  -> capture project revision
  -> prepare one consistent project snapshot
  -> compile
  -> discard result if superseded
  -> replace preview when ready
```

Render-on-type may need temporary snapshot files when the compiler cannot consume unsaved memory overlays. Snapshot writes must be atomic, revisioned, isolated under `.typstry`, and invisible to normal workspace navigation.

#### Render on save

```text
explicit save succeeds
  -> compile ordinary saved project files directly
  -> replace preview when ready
```

Render-on-save must not maintain or compile continuously updated mirror files. It must not render merely because the editor changed or an internal cache file was written.

#### Manual render

```text
explicit render request
  -> choose current saved or unsaved behavior explicitly
  -> compile one captured revision
```

Tracked by `P6.6`, `P6.7`, `P6.9`, `P7.6`, and `P7.7`.

### Step 7: Create revision-consistent compilation snapshots

For render-on-type, all source files used in a compilation must represent one coherent project revision. A main file copied at revision 20 must not include a chapter mirror from revision 18.

Snapshot requirements:

- use a unique generation or revision identifier;
- write changed files atomically before making the snapshot active;
- preserve project-relative paths for includes, imports, figures, and bibliography files;
- never expose a partially written snapshot to Tinymist or the Typst compiler;
- retain the last known-good snapshot until the next snapshot is complete;
- discard obsolete results without deleting files still used by an active compile;
- compile saved files directly for render-on-save.

Tracked by `P6.5`, `P6.6`, `P6.9`, `P7.6`, and `P7.7`.

### Step 8: Own one preview session per document root

The preview session belongs to the compiled document root, normally the configured main file. Changing the active editor tab must not recreate the preview if both files belong to the same document.

The session owns:

```text
document root
compiled project revision
PDF generation
page geometry
scroll and zoom state
source-map generation
docked or undocked presentation
```

Opening an included chapter should change the editor view while retaining the same PDF, current page, scroll position, zoom, and source-map session. A standalone preview creates a different explicit session.

Tracked by `P6.2`, `P6.3`, `P7.5`, `P7.7`, and `P7.9`.

### Step 9: Render large PDFs as a virtualized view

The PDF viewer should allocate expensive canvas and text-layer resources only for visible pages plus a small overscan. Every page still needs stable placeholder geometry so scrolling does not jump when resources are released.

Rules:

- keep page dimensions and offsets independent from rendered canvases;
- cancel obsolete rendering when zoom, PDF generation, or visibility changes;
- rerender visible pages at the current device-pixel ratio after zoom settles;
- release canvases, text layers, and event handlers for distant pages;
- preserve the last valid visible generation until its replacement is ready;
- never let a stale page task blank a newer generation.

Tracked by `P7.5`, `P7.6`, `P7.7`, and `P7.9`.

### Step 10: Treat source synchronization as revisioned navigation

Forward and inverse synchronization must identify the document root, compiled generation, source file, source revision, page, and coordinates involved. A result from an older PDF or source revision must not move the editor or preview.

Inverse sync workflow:

```text
PDF click
  -> resolve compiler source position for the active PDF generation
  -> open or activate the returned source file
  -> wait for the editor document to become active
  -> reveal and place the caret at a safe grapheme boundary
  -> show the navigation ripple at the editor caret
```

Forward sync should remain disabled unless compiler source-map positions are reliable enough for the active preview implementation. PDF text extraction is not a valid source-map fallback for complex scripts.

Tracked by `P6.2`, `P6.4`, `P7.6`, and the preview synchronization tests in `P7.9`.

### Step 11: Recover subsystems independently

An error in one subsystem must not permanently stop unrelated work.

```text
language provider failure -> preserve other provider results
LSP failure              -> keep editor usable and restart diagnostics
compile failure          -> retain last valid PDF and accept later renders
page render failure      -> retry or replace only the affected visible page
source-map failure       -> keep preview and editor navigation usable
external file conflict   -> request an explicit reconciliation decision
```

Every asynchronous operation needs ownership, revision, cancellation, retry limits, and a user-visible or developer-visible failure path. Recovery must be tested after failure, not only startup.

Tracked by `P2.7`, `P6.5`, `P6.7`, `P7.6`, `P7.7`, and `P7.9`.

### Step 12: Persist intent, not transient machinery

Workspace restoration should persist user intent:

```text
workspace and main file
open and active tabs
cursor and editor scroll positions
layout and sidebar state
preview zoom and document scroll position
language and render settings
```

Do not persist transient task handles, stale source-map coordinates, temporary widget offsets, in-progress compile state, or cache paths as authoritative project state. On restart, reconstruct these from current source and settings.

Tracked by `P6.8` and `P6.9`.

### Step 13: Measure the workflow end to end

Performance must be measured at user-visible boundaries rather than isolated functions:

```text
window creation -> usable editor
workspace open -> restored active document
keystroke -> diagnostic
keystroke or save -> updated visible PDF
source navigation -> visible target
zoom -> sharp visible pages
failure -> successful recovery
```

Benchmark short notes and long multi-file projects on release builds. Record project size, page count, platform, WebView engine, memory, latency, and whether the result was cold or warm.

Tracked by `P7.1`, `P7.2`, `P7.9`, and `P7.10`.

### Workflow invariants

- [ ] The active tab never implicitly changes the full-document root.
- [ ] Each applied asynchronous result matches its workspace, document, and revision.
- [ ] Diagnostics and preview never intentionally consume different revisions of the same open file.
- [ ] Render-on-save does not depend on mirror files.
- [ ] Render-on-type never exposes a partially written snapshot.
- [ ] Included-file navigation preserves the main preview session and scroll state.
- [ ] Large-document memory is bounded by the virtualized working set, not total page count.
- [ ] Cached or editor-only data never enters saved Typst source.
- [ ] A project remains compilable using the standard Typst toolchain outside Typstry.
- [ ] Khmer-specific behavior remains owned by Khmer modules while the workflow remains language-neutral.

## Phase 1: Align product language and feature taxonomy

### Implementation

- Adopt **complex-script-first** as the project-level positioning.
- Describe Khmer as the first deeply supported language and reference implementation.
- Use consistent terms throughout the UI and documentation:
  - **Script-aware editing** for navigation, selection, composition, and deletion;
  - **Language tools** for spellcheck, correction, dictionaries, and word completion;
  - **Document workflow** for projects, templates, includes, bibliography, preview, and export.
- Avoid presenting installed Hunspell dictionaries as equivalent to deep language support.
- Add support-level labels such as `Basic`, `Enhanced`, and `Deep` where users choose languages.
- Document which features are local, experimental, or provider-dependent.

### Task checklist

- [x] **P1.1 — Define the terminology source of truth.** Add the approved product description, one-line pitch, feature taxonomy, and support-level definitions to the development documentation.
- [x] **P1.2 — Rewrite public positioning.** Update the README, repository description, About content, and release-document templates to use the complex-script-first description. README, release workflow, and GitHub repository metadata are aligned. Typstry does not currently have an About dialog.
- [x] **P1.3 — Audit user-facing terminology.** Find Khmer-only or ambiguous generic labels in Settings, onboarding, language downloads, logs, dialogs, and tooltips; replace them with the approved terms.
- [x] **P1.4 — Define support levels.** Specify the exact capabilities required for `Basic`, `Enhanced`, and `Deep`, including how experimental support is displayed.
- [x] **P1.5 — Display support metadata.** Add support level and provider-dependent feature labels to installed-language and language-catalog UI entries. Depends on `P1.4`.
- [x] **P1.6 — Document feature independence.** Explain that script-aware editing, spellcheck, correction, and typing suggestions can be enabled independently.

### Acceptance criteria

- [x] The README answers what Typstry is, who it serves, and why Khmer has special depth without implying Khmer-only scope.
- [x] Settings distinguish script-aware editing from spellcheck and typing suggestions.
- [x] A language entry cannot imply completion or reliable segmentation unless its provider advertises those capabilities.

## Phase 2: Stabilize the extension contracts

### Script editing policies

- Keep `ScriptEditingPolicy` synchronous, deterministic, and independent from Rust IPC.
- Route policies by unique ISO 15924 script ownership.
- Define optional hooks for movement, selection, backward deletion, forward deletion, composition boundaries, and editor-only decorations.
- Use Unicode grapheme segmentation as the default baseline.
- Reject duplicate policy IDs and overlapping script ownership during registration.
- Require mixed-script and non-BMP test fixtures for every policy.

### Language providers

- Define a stable provider capability contract covering:
  - spellcheck;
  - correction quality;
  - word completion;
  - tokenization or segmentation;
  - custom dictionaries;
  - boundary-quality level;
  - supported locale and script metadata.
- Keep generic CodeMirror controllers free of language-specific regular expressions.
- Route completion and suggestions using the provider ID that produced the token.
- Allow multiple providers to analyze independent ranges in one document.
- Isolate provider failures so one language cannot suppress successful results from another.

### Task checklist

- [x] **P2.1 — Freeze the editing-policy contract.** Document required and optional hooks, UTF-16 range rules, ownership rules, and fallback behavior in the TypeScript interface.
- [x] **P2.2 — Enforce policy ownership.** Add registry validation for duplicate IDs, duplicate ISO 15924 ownership, overlapping code-point ownership, and cross-script boundary tailoring. Depends on `P2.1`.
- [x] **P2.3 — Centralize policy routing.** Audit CodeMirror keybindings and transaction helpers so all script-specific movement and deletion go through the registry.
- [x] **P2.4 — Define provider capabilities.** Add a versioned Rust and TypeScript capability schema for spellcheck, corrections, completion, segmentation, custom dictionaries, locale, script, stability, and boundary quality.
- [x] **P2.5 — Validate capability serialization.** Add IPC contract tests proving Rust capability responses deserialize into the frontend contract without provider-specific fields leaking into generic controllers. Depends on `P2.4`.
- [x] **P2.6 — Implement multi-provider range routing.** Run every provider that owns submitted text, coalesce input ranges, and merge non-overlapping results deterministically. Depends on `P2.4`.
- [x] **P2.7 — Isolate provider failures.** Return successful provider results alongside structured per-provider failures and prevent rejected requests from clearing valid issues. Depends on `P2.6`.
- [x] **P2.8 — Add conformance fixtures.** Register mock policies and providers in tests and verify ownership, routing, merging, failure isolation, and UTF-16 offsets.

### Acceptance criteria

- [x] Registering a mock second script policy does not change any Khmer movement or deletion result.
- [x] Registering a mock second language provider requires no CodeMirror integration change.
- [x] A mixed Khmer, Latin, and mock-script document produces independent results with correct UTF-16 ranges.

## Phase 3: Make Khmer the documented reference implementation

### Implementation

- Preserve the pinned Khmer segmenter output as the reproducible lexical baseline.
- Maintain exact source mappings through Khmer normalization.
- Consolidate Khmer editing fixtures for:
  - dependent vowels and registers;
  - multiple COENG sequences;
  - malformed and incomplete clusters;
  - composition at a temporary boundary;
  - forward and backward deletion;
  - selection and multiple cursors;
  - mixed Khmer, Latin, punctuation, emoji, ZWSP, and ZWNJ.
- Keep correction suggestions disabled until the provider can return a reliable intended-word span.
- Document known segmentation limitations rather than applying heuristic repairs that cannot be reproduced.
- Add a reference diagram showing which behavior belongs to the frontend policy and which belongs to the Rust provider.

### Task checklist

- [x] **P3.1 — Inventory Khmer behavior.** Record every Khmer-specific editor rule, provider behavior, setting, native command, test fixture, and known limitation.
- [x] **P3.2 — Consolidate editing fixtures.** Create table-driven movement, selection, deletion, multi-cursor, malformed-input, and temporary-boundary tests.
- [x] **P3.3 — Consolidate provider fixtures.** Add canonical, non-canonical, mixed-script, emoji, ZWSP, ZWNJ, known-word, unknown-word, and completion range cases.
- [x] **P3.4 — Lock reproducible segmentation.** Record the pinned upstream commit and expected token output for reference fixtures; reject undocumented heuristic post-processing.
- [x] **P3.5 — Verify normalization mapping.** Assert exact source byte and UTF-16 ranges for reordered or combined Khmer sequences and non-BMP text before Khmer.
- [x] **P3.6 — Document correction limitations.** Keep correction capability disabled and add a tracked condition for enabling it only after reliable intended-word spans exist.
- [x] **P3.7 — Publish the reference architecture.** Add the frontend-policy versus Rust-provider diagram and an end-to-end request example to the Khmer documentation.
- [x] **P3.8 — Add a permanent regression suite.** Run the locked Khmer fixtures whenever a policy, provider, completion controller, or Unicode utility changes.

### Acceptance criteria

- [x] Khmer navigation and deletion tests remain unchanged when other policies are registered.
- [x] No editor-only boundary marker enters the saved document, LSP input, preview input, or clipboard.
- [x] Spellcheck issues and completion replacements retain exact source ranges after normalization.
- [x] Known segmentation limitations are visible in developer documentation.

## Phase 4: Build honest language onboarding

### Implementation

- Replace a flat language list with a catalog driven by provider metadata.
- Bundle English by default and keep additional Hunspell-compatible dictionaries optional.
- Show download size, source, license, locale, script, installed state, and support level.
- Separate three onboarding paths:
  1. **Dictionary-only provider** for basic whitespace-delimited spellcheck;
  2. **Dictionary plus tokenizer** for improved boundaries and completion;
  3. **Deep provider** with script-aware policy, segmentation, completion, and language-specific tests.
- Allow a deep provider to supersede a fallback provider for the same locale without changing frontend code.
- Keep spelling, typing suggestions, and script-aware editing independently configurable.

### Task checklist

- [x] **P4.1 — Define catalog metadata.** Specify locale, scripts, provider type, support level, capabilities, download size, source, license, version, and checksum fields.
- [x] **P4.2 — Migrate the starter catalog.** Populate and validate metadata for bundled English and every downloadable dictionary. Depends on `P4.1`.
- [x] **P4.3 — Redesign language rows.** Show installed state, support level, provider source, download state, and only the controls supported by that language.
- [x] **P4.4 — Harden installation.** Verify checksums, write downloads atomically, retain license metadata, recover interrupted downloads, and refresh providers without restart.
- [x] **P4.5 — Implement clean removal.** Unregister the provider, remove its files, clear only its cached issues, and preserve unrelated language settings.
- [x] **P4.6 — Implement provider precedence.** Select a deep provider over a fallback for the same locale while retaining a reversible fallback path. Depends on `P2.4`.
- [x] **P4.7 — Label boundary quality.** Mark segmentation-dependent Hunspell languages as fallback support until a tokenizer-backed provider passes its fixtures.
- [x] **P4.8 — Test offline behavior.** Confirm installed provider metadata, license details, and capabilities remain visible without network access.

### Acceptance criteria

- [x] Installing a dictionary refreshes capabilities without restarting Typstry.
- [x] Thai or another segmentation-dependent language is labeled as fallback support until a tokenizer exists.
- [x] Removing a downloaded language cleanly unregisters it without affecting Khmer or English.
- [x] Provider source and license information remain available offline after installation.

## Phase 5: Audit complex-script behavior across the whole UI

### Implementation

- Audit every text-rendering surface for the configured complex-script fallback font:
  - editor and gutters;
  - autocomplete and context menus;
  - search and replace;
  - outline and explorer labels;
  - tabs, settings, logs, dialogs, and notifications.
- Test IME composition without prematurely triggering completion, spellcheck, saves, or preview compilation.
- Verify bidirectional text behavior in editor content and UI labels.
- Ensure search, selection highlighting, diagnostics, and issue navigation use Unicode-safe offsets.
- Keep invisible-character decorations from changing line height, caret geometry, or source offsets.
- Add platform fixtures for Chromium/WebView2 and WebKitGTK differences.

### Task checklist

- [x] **P5.1 — Create a text-surface inventory.** List every component that renders user, file, diagnostic, dictionary, or document text and identify its font stack and direction behavior.
- [x] **P5.2 — Centralize font tokens.** Define reusable UI, code, and complex-script fallback font variables and apply them to all inventoried surfaces. Depends on `P5.1`.
- [x] **P5.3 — Verify Unicode-safe search.** Test query entry, match ranges, replacement, whole-word behavior, and navigation with Khmer, combining sequences, emoji, and right-to-left text.
- [x] **P5.4 — Harden IME transactions.** Suppress premature completion, spellcheck publication, save, and render requests until composition is committed.
- [x] **P5.5 — Audit editor geometry.** Test gutters, caret, selections, autocomplete, invisible characters, and line measurement after runtime font-size changes.
- [x] **P5.6 — Add bidirectional fixtures.** Verify mixed left-to-right and right-to-left UI labels and editor lines without applying global direction changes.
- [x] **P5.7 — Add platform visual checks.** Cover Windows WebView2 and Linux WebKitGTK for the same font, popup, caret, and selection fixtures.
- [x] **P5.8 — Add accessibility checks.** Verify keyboard navigation, focus order, contrast, zoom, and screen-reader labels for language controls and completion lists.

### Acceptance criteria

- [x] Increasing the UI or editor font size does not misalign gutters, selections, or caret placement.
- [x] Search finds complete complex-script sequences and highlights the correct range.
- [x] Autocomplete rows render one consistent popup with visible keyboard selection in every theme.
- [x] IME composition does not publish partial text as a spelling issue or destructive completion.

## Phase 6: Harden research-document workflows

### Implementation

- Treat the workspace and configured main file as the document identity.
- Preserve one preview session and scroll context while navigating between main and included files.
- Make standalone preview explicit for files intended to compile independently.
- Keep main-file, include, import, bibliography, image, and template paths navigable from source.
- Ensure external file changes update the editor, LSP, and preview through one ordered synchronization path.
- Keep render-on-type and render-on-save behavior distinct and testable.
- Hide Typstry caches from the workspace and never require them for external Typst compilation.
- Preserve tabs, cursor positions, active file, main-file selection, and layout across workspace restoration.

### Task checklist

- [x] **P6.1 — Define document identity.** Specify how workspace root, main file, included file, standalone file, preview session, and cache paths are keyed.
- [x] **P6.2 — Unify preview ownership.** Keep one full-document preview session when navigating between the main file and included files. Depends on `P6.1`.
- [x] **P6.3 — Implement standalone preview rules.** Parse and document the standalone-preview directive, scope it correctly, and prevent accidental main-document replacement.
- [x] **P6.4 — Harden source navigation.** Test Ctrl-hover and open behavior for includes, imports, bibliography files, images, templates, repeated filenames, spaces, and Unicode paths.
- [x] **P6.5 — Order external updates.** Route file watcher changes through editor state, mirror state where required, LSP notifications, and preview compilation with revision guards.
- [x] **P6.6 — Separate render modes.** Add deterministic tests proving render-on-save compiles only after a successful save and render-on-type compiles debounced document revisions.
- [x] **P6.7 — Add compiler recovery.** Ensure a failed render or LSP restart cannot permanently stop later diagnostics or preview updates.
- [x] **P6.8 — Harden workspace restoration.** Restore the main file and active tab from an empty-tab state, then restore cursor, scroll, split, and preview state.
- [x] **P6.9 — Isolate caches.** Hide `.typstry`, clean obsolete cache entries safely, and verify external Typst compilation never depends on cache contents.
- [x] **P6.10 — Add a research-project fixture.** Maintain a multi-file project containing a template, chapters, bibliography, figures, Khmer, Latin, and standalone-preview content.

### Acceptance criteria

- [x] Opening an included chapter does not start an unrelated full-document preview session.
- [x] Restarting a workspace can open the configured main file even when no other tab is open.
- [x] A change in any included source reaches diagnostics and preview exactly once in the correct order.
- [x] Render-on-save does not compile while typing, and render-on-type recovers after a compiler error.
- [x] The same source project compiles with the standard Typst toolchain outside Typstry.

## Phase 7: Set reliability and performance gates

### Editor and language tools

- No stale asynchronous result may mutate a different document revision.
- A single edit in a 100,000-character document must not resend the entire document for spellcheck.
- Interactive suggestion lookup must use bounded candidate sets.
- Language providers should initialize lazily after the main UI becomes usable.

### Preview and project workflows

- Use virtualized PDF rendering so memory grows with visible pages rather than total page count.
- Cancel obsolete page renders and compilation requests.
- Preserve visible pages while a new PDF is loading to avoid flicker and blank-page transitions.
- Test 1-page, 30-page, and 100-page fixtures on Windows and Linux release builds.
- Record startup, first-editor, first-diagnostic, first-preview, memory, and recovery timings in developer diagnostics.

### Task checklist

- [x] **P7.1 — Establish benchmark fixtures.** Add reproducible 1-page, 30-page, 100-page, 100,000-character, mixed-script, and repeated-edit workloads.
- [x] **P7.2 — Add measurement hooks.** Record startup, provider initialization, first diagnostic, first preview, compile, render, zoom, memory, and recovery timings in developer output.
- [x] **P7.3 — Make language analysis incremental.** Submit changed logical ranges, preserve unaffected issues, coalesce edits, and bound active and queued work.
- [x] **P7.4 — Bound interactive suggestions.** Index candidates at provider startup and forbid unrestricted dictionary scans on the typing path.
- [x] **P7.5 — Virtualize PDF pages.** Render the visible window plus a small overscan, release distant page resources, and preserve page geometry.
- [x] **P7.6 — Cancel obsolete work.** Add revision or cancellation guards to PDF loads, page renders, compilations, language analysis, and source-map requests.
- [x] **P7.7 — Preserve visible preview state.** Keep the last valid pages visible until replacements are ready and prevent blank-page or low-resolution zoom races.
- [x] **P7.8 — Defer noncritical startup work.** Show a usable editor before loading optional language providers, dictionary indexes, catalogs, and expensive font metadata.
- [x] **P7.9 — Automate release benchmarks.** Run the fixture matrix on Windows and Linux release builds and retain results for regression comparison.
- [x] **P7.10 — Set numeric budgets.** Record approved startup, latency, memory, and recovery thresholds after measuring representative hardware. Depends on `P7.1`, `P7.2`, and `P7.9`.

### Gate checklist

- [x] A 100-page document remains navigable without multi-gigabyte preview memory growth.
- [x] Zooming cannot leave visible pages blank or permanently blurry.
- [x] A syntax error followed by a valid edit recovers diagnostics and preview without restarting the LSP.
- [ ] Release and debug builds render the same editor layout and document content.
- [ ] Opening an undocked preview does not expose an uninitialized intermediate UI.

## Phase 8: Prove portability with a second complex script

Lao is the selected second portability implementation. It validates the contracts without copying Khmer behavior: Unicode grapheme handling remains the editing baseline, while ICU4X supplies dictionary word boundaries and the optional licensed `lo_LA` Hunspell provider supplies spelling data.

### Task checklist

- [ ] **P8.1 — Select the validation language.** Confirm a maintainer, reliable linguistic fixtures, dictionary licensing, and tokenizer or segmenter availability.
- [x] **P8.2 — Add Unicode fixtures.** Cover movement, deletion, selection, composition, malformed text, mixed scripts, and non-BMP neighbors.
- [x] **P8.3 — Evaluate the Unicode baseline.** Register a script policy only where fixtures prove default grapheme behavior is insufficient. Depends on `P8.2`.
- [x] **P8.4 — Add fallback spellcheck.** Install and label a Hunspell-compatible provider where licensing and dictionary quality permit.
- [x] **P8.5 — Integrate tokenization.** Add a tokenizer or segmenter behind the provider contract with exact UTF-16 source mappings.
- [x] **P8.6 — Add completion.** Enable it only after segmented active-word and replacement-range fixtures pass. Depends on `P8.5`.
- [x] **P8.7 — Run cross-language regressions.** Compare all locked Khmer results before and after the new registrations.
- [x] **P8.8 — Publish support limits.** Document unsupported behavior, support level, provider sources, and experimental status.

`P8.1` remains open for promotion: Lao was selected and its Unicode, ICU4X, dictionary, version, and license sources are confirmed, but Typstry still needs a fluent Lao maintainer or reviewer. The provider therefore remains experimental enhanced support rather than deep/stable support.

### Acceptance criteria

- [x] The new language is added without modifying Khmer policy or Khmer provider logic.
- [x] Generic editor controllers contain no new language-specific regular expressions.
- [x] Mixed Khmer and second-script content retains independent navigation and language results.
- [x] Removing the new provider restores fallback behavior without changing saved documents.

## Phase 9: Contributor experience and governance

### Implementation

- Provide templates for a script editing policy, native language provider, capability manifest, dictionary metadata, and test fixture set.
- Add a contributor checklist covering Unicode sources, dictionary licensing, normalization, UTF-16 mapping, mixed-script boundaries, and performance.
- Require each deep provider to name maintainers or upstream sources for dictionaries and segmentation data.
- Define compatibility rules for provider IDs and persisted settings.
- Add a provider conformance test suite that can be run without launching the desktop UI.
- Keep experimental providers behind an explicit setting until their acceptance tests pass.

### Task checklist

- [x] **P9.1 — Create a policy template.** Include a minimal implementation, registration step, ownership constraints, pure tests, and optional composition extension.
- [x] **P9.2 — Create a provider template.** Include capabilities, locale and script metadata, range conversion, error isolation, dictionary metadata, and native tests.
- [x] **P9.3 — Create fixture templates.** Provide canonical, non-canonical, malformed, mixed-script, non-BMP, completion, suggestion, and performance fixture formats.
- [x] **P9.4 — Write the contributor walkthrough.** Document the complete path from language proposal through experimental registration and stable support.
- [x] **P9.5 — Add conformance commands.** Run policy and provider suites without launching Tauri and return actionable failures.
- [x] **P9.6 — Enforce licensing metadata.** Reject bundled or downloadable dictionaries without source, version, license, and redistribution information.
- [x] **P9.7 — Define compatibility policy.** Version provider IDs, capability contracts, installed metadata, and persisted settings migrations.
- [x] **P9.8 — Define promotion criteria.** Require named maintainers, passing fixtures, performance gates, documented limitations, and release-platform verification before stable status.
- [x] **P9.9 — Add CI enforcement.** Detect duplicate ownership, invalid ranges, unbounded suggestions, missing licenses, generic language-specific regexes, and Khmer regressions.

### Acceptance criteria

- [x] A contributor can implement a provider by following documentation without editing generic CodeMirror integration.
- [x] CI detects duplicate script ownership, invalid offsets, unbounded suggestions, missing licenses, and Khmer regressions.
- [ ] Experimental and stable providers are visibly distinguishable in Settings. *(requires Settings UI update — deferred)*

## Release milestones

### Beta stabilization

- Finish Phases 1 through 3.
- Resolve release-build editor and preview regressions.
- Establish deterministic Khmer and mixed-script test fixtures.

### v1.0 readiness

- Complete the cross-UI audit and core research-workflow reliability work.
- Pass the Windows and Linux release-build matrix.
- Meet the long-document memory and recovery gates.
- Publish a stable editing-policy and language-provider contributor contract.
- Clearly label the support level of every bundled or downloadable language.

### v1.x expansion

- Add or improve language providers without changing the core editor contracts.
- Validate the architecture with a second deeply supported complex script.
- Expand research workflows based on real thesis, book, and technical-document projects.

### Deferred to v2.0

- WYSIWYM editing;
- structural round-trip editing of arbitrary Typst markup;
- any visual editor that can modify source without proven lossless behavior.

## Validation matrix

Run the relevant checks for every phase:

```text
bun test
bun run conform
bun run build
cargo fmt --check        (from src-tauri/)
cargo check --lib        (from src-tauri/)
cargo test --lib         (from src-tauri/)
git diff --check
```

Release validation must additionally cover:

- Windows and Linux release builds;
- Khmer, Latin, and mixed-script fixtures;
- at least one right-to-left fixture;
- IME composition;
- multi-file projects with includes, bibliography, figures, and templates;
- external file reload and LSP recovery;
- 1-page, 30-page, and 100-page PDFs;
- cold start, workspace restore, preview docking, and preview undocking.

## Definition of success

This direction is successful when Typstry can add another deeply supported language through explicit policy and provider modules, without changing Khmer behavior or generic editor integration, while remaining reliable for real multi-file research documents.

Khmer should demonstrate the depth of Typstry's language support. It should not define the limit of who Typstry can serve.
