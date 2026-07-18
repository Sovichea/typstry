# Roadmap

## v0.4.x — stabilization

The v0.4.x line builds on the current feature set. Its priorities are:

- Bug fixes and regression prevention, especially for Unicode, Khmer, project workflows, preview, and data safety.
- Performance, responsiveness, memory use, and startup/build optimization.
- A limited number of minor features that extend existing workflows without introducing a new architectural track.
- No major editor subsystem or broad language-support expansion; larger features move to v0.5.0 or later.

## v0.5.0 — right-to-left writing

Introduce first-class right-to-left (RTL) editing as the next major Unicode-writing milestone, covering Arabic-family scripts, Hebrew, and mixed-direction research documents.

- Establish an RTL conformance suite before adding custom behavior, including Arabic and Hebrew prose, combining marks, selections, cursor movement, deletion, search, copy/paste, and multi-cursor edits.
- Support automatic, LTR, and RTL paragraph direction without reimplementing the Unicode Bidirectional Algorithm.
- Make mixed-direction content reliable when RTL prose contains Latin citations, URLs, numbers, equations, and Typst syntax.
- Add direction-aware alignment and editor controls, plus explicit Unicode direction-isolate commands for ambiguous mixed-direction text.
- Verify diagnostics, completion, spellcheck ranges, source navigation, and editor-to-preview synchronization under bidi layout.
- Keep text direction, script-specific editing policies, language tools, and Typst rendering as separate architectural concerns.
- Add RTL-aware font coverage and recommendations without changing the user's chosen typography automatically.
- Preserve Khmer, Lao, other complex-script, and ordinary LTR editing behavior through regression tests.

## v0.6.0 — research productivity and discoverability

Make Typsastra's document-engineering strengths easier to discover while adding broadly useful research-authoring tools. This milestone does not expand into discipline-specific computation or visual tooling.

- Add table, figure, caption, equation, and matrix builders that produce clean, editable, portable Typst source.
- Add bibliography entry management with DOI/arXiv-assisted metadata retrieval, duplicate detection, citation-key control, and ordinary `.bib` output.
- Add a template browser with rendered previews, compatibility metadata, and a clear distinction between bundled, local, and Typst Universe templates.
- Add project-outline restructuring for moving headings or chapters while preserving explicit file ownership, labels, references, and main-document preview context.
- Preserve and clearly communicate the last successful preview across main-document and standalone-preview compilation failures.
- Add a toolchain health panel showing active Typst/Tinymist versions, provenance, validation state, download status, and recovery actions.
- Publish reproducible benchmark reports covering startup, compilation, long-document preview, project indexing/search, memory boundaries, installer size, and enabled language-provider cost.
- Improve feature visibility with short demonstrations of complex-script editing, included-file preview ownership, source synchronization, language installation, long-document virtualization, and compiler-failure recovery.
- Add an onboarding project that deliberately demonstrates Khmer and mixed-script editing, Unicode-safe navigation, project structure, bibliography/figure relationships, and preview behavior.

- [ ] **v0.9.0 prerelease:** Rebuild and re-enable automatic forward sync only after rapid-click, long-paragraph, included-file, persistent data-plane, timeout, and source-offset reliability tests pass. Explicit toolbar/keyboard forward sync is available; cursor-driven scrolling remains disabled before this milestone.
- [ ] Improve manual forward sync beyond Tinymist's current page-and-line result when the compiler can provide a reliable exact cursor x/y coordinate; do not use PDF text matching as a fallback.

## Completed

- Basic UI layout with sidebar, CodeMirror editor, and live preview pane.
- Tinymist LSP integration for preview, diagnostics, forward sync, and cross-zoom scroll synchronization.
- Custom frameless titlebar and native-feel window controls.
- Welcome screen and recent project cache.
- Dynamic file explorer with Material icons and native file operations.
- Persistent workspace state for tabs, cursor positions, split ratios, and save status.
- Visual toolbar for Typst math symbols, snippets, and typography controls.
- Context-aware syntax highlighting, bracket colorizer exclusions, and escaped character handling.
- Native settings panel and versioned `settings.json`.
- Modular local language tools with Khmer and English providers.
- Dynamic language catalog onboarding with download integrity validation, capabilities metadata, and clean uninstallation.
- Experimental Khmer render preparation for preview/export input.
- Interactive document outline.
- Writable Unicode-focused example workspace.
- GitHub Actions workflow for automated builds.
- Linux build verification.

## v1.0 priorities

- Version-bound `.typsastra` project export with all exact render fonts embedded, secure project import, project-local font loading, and installer-registered double-click import using the Typsastra icon.
- Per-workspace managed toolchain selection with an explicit compatibility warning when overridden.
- A New Project wizard for blank, technical report, IEEE-style research paper, thesis, and book projects.
- Crash-safe saving, persisted-state migrations, recovery, accessibility, installer verification, and cross-platform release gates.
- Stability, bug fixes, data safety, and Khmer/complex-script regressions take priority over additional features.
- Gesture scrolling and scrollbar-drag release meet the visible-page latency, bounded-concurrency, and canvas-residency gates in the [PDF preview interaction implementation plan](./PDF_PREVIEW_INTERACTION_IMPLEMENTATION_PLAN.md).

The detailed tasks and acceptance criteria are in the [v1.0 release implementation plan](./V1_RELEASE_IMPLEMENTATION_PLAN.md).

## v1.x milestones

The trackable post-release work is in the [v1.x implementation plan](./V1X_IMPLEMENTATION_PLAN.md).

- **v1.1 — stabilization and AI writing foundation:** crash and recovery fixes remain the priority, followed by an opt-in, user-invoked assistant for drafting, rewriting, translation, summarization, and manually requested review through explicit proposed edits.
- **v1.2 — reproducible computation:** explicitly run Python and GNU Octave workflows, with optional user-installed MATLAB integration, and consume generated plots/data in Typst. Project scripts never run automatically. Continue improving bounded AI writing workflows.
- **v1.3 — Git workflows:** repository status, Unicode-safe diffs, staging, commits, branches, history, and safe conflict handling before remote hosting integration. AI may explain user-selected diffs but cannot perform Git mutations implicitly.
- **Across v1.x — Khmer workflow:** revisit Khmer project presets, typography, editing, language tools, source navigation, preview/export, and experimental render preparation using representative documents and native-speaker review. Render preparation remains default-off unless it safely outperforms tuned ordinary Typst justification.
- **Later v1.x:** global project search, package/dependency inventory, bibliography improvements, support bundles, and additional stable complex-script providers.

## Deferred to v2.x

The long-term research tasks and gates are in the [v2 implementation plan](./V2_IMPLEMENTATION_PLAN.md).

- Real-time/on-type AI grammar and spellcheck integration, including AI squiggles, issue counters, and background proofreading, remains future work after community adoption.
- Manually requested AI grammar or spelling review is allowed in v1.x as an assistant response or proposed edit, with no integration into Language Tools.
- Deterministic dictionary spellcheck and script-aware language tools remain supported and are not replaced by AI.
- Any future WYSIWYM direction is separate from the v1.x code-based authoring roadmap.

## Current release status

Typsastra is beta software. The latest public release is v0.4.1.
