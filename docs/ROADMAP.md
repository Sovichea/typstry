# Roadmap

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

Typsastra is beta software. The latest public release is v0.4.0.
