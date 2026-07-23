# Typsastra v0.5.3 Active File Preview Implementation Plan

## Objective

Add a portable, memory-bounded preview workflow for authors who split long
documents into included files. This milestone begins after the v0.5.2 bug-fix
and font-variant-cache release is complete.

Typsastra exposes exactly two preview modes:

```text
Full Document
Active File
```

Full Document remains authoritative. Active File deliberately trades complete
project layout and cross-chapter reference rendering for a smaller compilation
root and faster chapter iteration. Typsastra must communicate that boundary
without introducing private Typst syntax or hidden generated entry points.

Preview scope and refresh policy are separate. The existing PDF renderer
supports debounced on-type updates for short documents and on-save updates for
long or resource-intensive documents:

```text
short responsive document     -> PDF after typing pauses
long/resource-heavy document  -> PDF on save
```

v0.5.3 must qualify that implementation before deciding whether a separate SVG
live renderer is justified. If an SVG experiment proceeds, qualification must
use measured compiled output and runtime resource budgets, not source-file size
alone. Typsastra must never retain both complete document representations and
must preserve PDF export regardless of the interactive renderer.

### Decoded-image preflight

The experimental v0.5.2 detector remains disabled until this milestone. Before
enabling it:

- verify PNG, JPEG, GIF, BMP, and WebP metadata parsing with malformed,
  truncated, animated, high-bit-depth, and unusually encoded fixtures;
- traverse statically reachable local Typst dependencies without treating
  comments, raw blocks, strings, package paths, URLs, or dynamic expressions as
  direct image references;
- estimate preview pressure from decoded pixel area, not compressed file size;
- warn before compilation when detection is reliable, preserve the last
  successful preview, and require explicit **Render Anyway** approval;
- invalidate approval when the source asset changes;
- fail open and document the limitation when dimensions or ownership cannot be
  established safely.

Typsastra must never automatically downsample, convert, replace, hide, or
rewrite the author's source image.

## Product contract

### Full Document

- Compile the configured main file.
- Preserve authoritative pagination, counters, cross-chapter references,
  links, diagnostics, source synchronization, and export.
- Use this mode for final layout verification.

### Active File

- Preview only the configured main file or a file directly or transitively
  reachable from it through `#include`.
- Do not treat `#import`-only libraries, templates, unrelated `.typ` files, or
  non-Typst files as eligible preview targets.
- Compile a visible, ordinary Typst entry point associated with the included
  file. Do not generate a hidden wrapper in `.typsastra`.
- Replace the full-document Tinymist context instead of retaining it beside the
  active-file compiler.
- Treat numbering, pagination, cross-chapter links, and external-reference
  rendering as isolated-preview results rather than final-document truth.

## Portable project structure

The recommended layout is:

```text
template.typ
main.typ
chapters/
  chapter-01.typ
previews/
  chapter-01.typ
  reference-placeholders.typ
```

`main.typ` and each preview entry point apply the same shared template. A
chapter remains content-only so including it in the main document cannot apply
the template twice.

Every created file must compile with standard Typst outside Typsastra. The
`.typsastra` directory may cache discovery metadata and UI state, but it must
not own source required to compile an active-file preview.

## Include graph and eligibility

- Build a workspace-rooted graph from the configured main file's static
  `#include` edges.
- Follow transitive includes and normalize paths cross-platform.
- Refresh affected edges after save, create, rename, move, or delete.
- Reject include cycles safely.
- Treat dynamically computed paths as unresolved unless a successful main
  compilation provides a trustworthy dependency relation.
- If a file is included through multiple paths, disclose the ambiguity and use
  the explicitly associated portable preview entry point.

When an ineligible file becomes active, replace the preview surface with a
theme-aware state message. Do not display the previous PDF and do not compile
or silently fall back to the file:

```text
Active File Preview Unavailable

This file is not included by main.typ. Active File mode only previews
documents reachable through #include from the configured main file.
```

Offer **Switch to Full Document**, **Open Main File**, and, for an eligible
Typst candidate, **Set as Main File**. Disable page navigation and source-sync
actions while this state is visible.

## Portable-preview preparation

If an eligible included file has no portable entry point using the main
document's common template, show **Prepare Portable Active-File Preview**.

The migration must:

1. Identify reusable top-level formatting in the main file conservatively.
2. Propose a visible common template and chapter preview entry point.
3. Show the complete diff and require confirmation.
4. Update the main file to use the common template without applying it twice.
5. Create the visible preview entry point and shared placeholder helper.
6. Compile both main and active-file targets.
7. Roll back the complete migration if either validation fails.

Dynamic or ambiguous formatting must produce guidance instead of an unsafe
automatic rewrite.

## Formatting and page-boundary advisories

Attach one stable gutter warning to the relevant `#include` line when static
analysis cannot establish standalone-preview fidelity. The tooltip can combine
multiple findings without adding gutter columns:

- no common formatting entry point was detected;
- no explicit page break precedes the include or begins the included file.

The page-break finding is advisory. Continuous flow may be intentional, and
templates or dynamic code may introduce a boundary that static analysis cannot
prove. Phrase it as "No explicit page break detected" and allow the user to
keep continuous flow without changing source.

An active-file preview without the same preceding page state may move headings,
figures, footnotes, counters, and other layout. Only Full Document is
authoritative even when a page break exists.

## Project reference catalog

Active File mode must not keep Tinymist pinned to the full main document merely
to provide reference completion.

Build a lightweight, revision-safe project catalog containing:

- statically discoverable labels;
- associated element kind and title when available;
- source file and source range;
- bibliography keys;
- cached dynamic labels from the last successful Full Document compilation,
  clearly marked as cached.

Update changed files incrementally. Merge catalog entries into editor reference
completion and Ctrl/Cmd-click navigation while Tinymist is pinned to the active
portable entry point. Duplicate, removed, dynamic, and stale labels must remain
distinguishable.

## External-reference placeholders

The portable preview helper may use an ordinary Typst `show ref` rule and a
materialized list of known external labels. When a reference target exists in
the project catalog but not in the active compilation, render neutral text such
as:

```text
External reference: results
```

Requirements:

- Placeholder only a label known to exist outside the active compilation.
- Leave an unknown or misspelled label as a compiler error.
- Do not invent or cache visible section, figure, equation, or page numbers.
- Do not imply that the placeholder is a working PDF link.
- Load the shared bibliography normally where the portable entry point supports
  it.
- Refresh the portable placeholder data when project references change, without
  rewriting chapter content.

Full Document mode remains responsible for final numbers, links, reference
diagnostics, and export.

## Tinymist and memory lifecycle

Use one owned Tinymist compiler context at a time:

```text
Full Document  -> Tinymist pinned to main.typ
Active File    -> terminate main context, start portable chapter entry
```

- Do not run a main-document LSP beside an active-file preview compiler.
- Terminate and restart Tinymist when the preview root changes because repinning
  alone may retain the previous compiled document.
- Cancel obsolete starts and reject stale diagnostics, preview, reference, and
  source-map results by generation.
- Hide the old PDF during an ineligible-file state.
- Keep compiled preview artifacts on disk rather than retaining inactive PDF.js
  documents or canvases.
- Debounce rapid tab changes so intermediate files do not repeatedly restart
  Tinymist.

Active File mode consequently provides only the semantic context available to
its portable entry point plus Typsastra's lightweight reference catalog.

## Workspace state and UI

- Persist `full-document` or `active-file` per workspace.
- Do not persist transient compiler handles or generated cache paths.
- Show the actual active entry point in the preview toolbar.
- Label Active File as an isolated preview whose final validation requires Full
  Document.
- Switching to the main file in Active File mode previews the main file itself.
- Opening an unrelated file shows the unavailable state rather than stale or
  unrelated output.

## Implementation phases

### Phase 0 — contracts and fixtures

- Add multi-file fixtures covering direct, nested, repeated, cyclic, dynamic,
  import-only, page-broken, and continuous includes.
- Add malformed and representative raster-header fixtures and lock the
  non-destructive decoded-image warning contract.
- Record baseline Tinymist memory and switch latency.

### Phase 1 — modes and eligibility

- Add the two-mode state model, include graph, toolbar control, unavailable
  state, and workspace persistence.

### Phase 2 — portable entry points

- Add conservative formatting comparison, migration preview, shared-template
  extraction, visible entry creation, validation, and rollback.
- Add combined formatting/page-boundary gutter advisories.

### Phase 3 — isolated compiler lifecycle

- Replace Tinymist roots safely, debounce tab changes, clear stale state, and
  verify bounded memory across repeated switches.

### Phase 4 — references

- Add the project reference catalog, completion/navigation integration,
  portable placeholder helper, live updates, and unknown-label protection.

### Phase 5 — qualification and documentation

- Update examples and tutorials.
- Qualify decoded-image warnings across supported formats and platforms,
  including false positives, false negatives, approval invalidation, and
  preservation of the last successful preview.
- Test source sync, recovery, renames, unsaved changes, project export, and
  compilation outside Typsastra.

## Release gates

- All preview entry points compile with the managed compiler and ordinary Typst
  without `.typsastra` source dependencies.
- Active File never previews an import-only, unrelated, or unsupported file.
- The unavailable state never exposes a stale PDF as if it belonged to the
  active file.
- Known external labels complete and render as placeholders; unknown labels
  remain errors.
- Full Document restores authoritative cross-references and layout.
- After repeated main/chapter switches, only one Tinymist context and one PDF.js
  document remain active and settled memory is bounded.
- Failed migration or compiler switching cannot modify source partially or lose
  unsaved work.
