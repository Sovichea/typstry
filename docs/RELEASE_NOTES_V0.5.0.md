# Typsastra v0.5.0 release notes

Status: development draft. The latest public release remains v0.4.1 until the
v0.5.0 release artifacts are published.

First-class right-to-left editing is scheduled for the v0.9.0 pre-release
milestone and is not part of the v0.5.0 release scope.

Typsastra v0.5.0 is a substantial beta update focused on multilingual language
scope, long-document responsiveness, portable workspace behavior, and a more
complete desktop application. These notes cover commits after tag `v0.4.1`.

The minor-version bump is intentional. Scope-aware language tooling and the
schema-v2 archive contract are new architectural surfaces, and font packaging
was deliberately removed before 1.0. Calling this collection v0.4.2 would
understate both the feature scope and the migration impact.

## Highlights

### Scope-aware multilingual writing

- Spellcheck follows Typst `#set text(lang: ...)`, `#text(lang: ...)[...]`, and
  content-block language scopes instead of applying one document-wide language.
- Explicit language scopes fail closed when their provider is unavailable. The
  `lang:` value and gutter show an actionable warning instead of silently using
  another language.
- Embedded providers remain script-disjoint, preventing a valid English word
  from hiding a French or Spanish typo merely because all three use Latin.
- Typing completion follows the current keyboard input language, independently
  from the spellcheck language scope.
- Global, project, and language-family terminology can be managed separately.
- Khmer completion, word selection at line starts, and mixed-script examples
  received additional regression coverage.

### Faster and more predictable PDF preview

- The PDF.js preview now uses hardware-accelerated canvas rendering, motion-aware
  scheduling, two settled render lanes, bounded page ownership, and destination
  prediction for gesture deceleration.
- Scrollbar release renders all visible destination pages and includes a fallback
  for WebView environments that lose the native pointer-release event.
- Forward-sync and manual page jumps are immediate rather than animated across
  hundreds or thousands of pages.
- The shared preview toolbar shows an editable current page and total page count.
- PDF files can be opened directly in Typsastra and share the live-preview zoom
  controls. Image preview behavior and zoom controls are also consistent.
- Preview scroll position survives pane resize and main-file rename refreshes.

### Large files and workspace restoration

- Inactive restored tabs are loaded lazily, so a large source file or PDF no
  longer delays workspace startup merely because it was previously open.
- Opening a large text file or PDF requires confirmation in the editor pane
  before Typsastra performs the expensive load.
- Outline parsing, Unicode font detection, and language-scope text materialization
  are deferred while typing, keeping large Typst files responsive.
- Workspace state is stored under `.typsastra` with portable relative paths for
  the main file, tabs, selections, scroll positions, folds, explorer expansion,
  layout, and selected toolchain.
- Project export excludes generated PDFs, caches, and other managed output while
  retaining portable workspace configuration.

### Tinymist lifecycle and main-document ownership

- Closing a project now terminates Tinymist.
- Restarting or replacing a workspace starts a fresh Tinymist process.
- Changing the configured main file cancels stale preparation, terminates the old
  compiler process, clears obsolete diagnostics and source-map sessions, and
  starts a new process before loading the new document graph.
- Set/Unset Main File is available from both Explorer and Typst tab context menus.
  The action is restricted to `.typ` files.

### Desktop workflow and accessibility

- Recent-project history stores up to 32 workspaces and provides fuzzy search,
  keyboard navigation, welcome-screen access, and File-menu access.
- Explorer supports copy, paste, delete, and rename shortcuts while preserving
  pane focus after operations.
- Explorer, outline, editor, logs, tabs, and navigation indicators use
  theme-aware selection colors. Typsastra Green light and dark themes were added.
- Cross-platform overlay scrollbars replace platform-dependent scrollbar styling.
- Modal focus is contained, welcome-screen Tab and arrow navigation are unified,
  and ordinary Tab navigation never enters the code editor.
- The editor status bar reports Unicode-aware row and column positions, including
  wrapped visual-line navigation with a persistent goal column.
- Folding controls, persistent fold state, gutter warnings, active tabs, and
  selection contrast were refined.
- macOS uses native traffic-light window controls; Linux receives native control
  theming and an opt-in WebKitGTK DMA-BUF workaround for affected Wayland/AMD
  systems.

### Distribution and application identity

- Typsastra checks for signed updates silently and shows an update badge only
  when a newer version is available. Installation still requires confirmation.
- The About dialog reports the application version, license, and project details.
- Release builds no longer fail merely because updater signing secrets are absent
  from a non-release workflow.
- Application icons and screenshots were refreshed.

## Breaking and migration notes

### Font-free project archives

`.typsastra` archives now use schema version 2 and deliberately contain no font
redistribution option. Project and source-ZIP export exclude recognized font
binaries regardless of license, and import rejects embedded font binaries.
Recipients must install the fonts required by the document separately.

This is an intentional pre-1.0 format break that keeps archives small and avoids
making Typsastra responsible for determining third-party redistribution rights.

### Workspace state

Project identity and the relative main-file path now live in
`.typsastra/config.json`; local session state lives in the ignored
`.typsastra/workspace.json`. Legacy absolute-path local-storage state is migrated
once when possible.

### Main-file changes

Changing the main file is now a compiler lifecycle boundary. It may briefly show
a restarting status, but it prevents multiple large compilation graphs from
accumulating in one Tinymist process.

### Forward-sync shortcut

Manual **Reveal Cursor in Preview** now uses `Alt+Enter` on Windows and Linux and
`Option+Enter` on macOS. Automatic cursor-driven preview movement remains
disabled.

## Performance and validation

- The preview retains at most seven final page canvases.
- Gesture scrolling and scrollbar-release behavior have deterministic scheduler
  tests, including deceleration, direction reversal, re-grab, split-page
  visibility, and lost pointer release.
- The published CLI and incremental-range measurements remain in
  [BENCHMARKS.md](./BENCHMARKS.md). They are not presented as desktop memory or
  end-to-end WebView measurements.

Before publishing v0.5.0, run the complete frontend, native, conformance,
installer, updater, project-import, Linux compatibility, and long-document
interaction release gates.
