# Typsastra v1.x Implementation Plan

## Objective

Evolve Typsastra after v1.0 through stability-first, backward-compatible releases. The v1.x series introduces bounded AI writing assistance, reproducible research computation, Git workflows, and a renewed Khmer workflow/render-preparation evaluation without weakening v1.0 project portability or data-safety guarantees.

This document begins only after the [v1.0 release plan](./V1_RELEASE_IMPLEMENTATION_PLAN.md) passes its release gate. The [v2 implementation plan](./V2_IMPLEMENTATION_PLAN.md) owns real-time AI language diagnostics and other major interaction changes.

## Release rules

1. Stability, regressions, and data safety take priority over milestone features.
2. v1.x project/settings schema changes must be backward-compatible or explicitly migrated.
3. A stability release may interrupt or split any milestone.
4. User code, project scripts, AI requests, Git mutations, and network operations are never triggered implicitly.
5. Deterministic Language Tools remain separate from probabilistic AI assistance.
6. Experimental Khmer rendering work remains default-off until its documented promotion gates pass.

## Tracking convention

Tasks use stable IDs such as `V1X-A.1`. Implementation, tests, documentation, privacy/security behavior, and migration behavior must land together.

---

## Milestone v1.1: Stabilization and AI writing foundation

### Stability work

- Fix user-reported crashes, preview/LSP recovery failures, Unicode editing regressions, packaging issues, and project-interchange defects.
- [ ] **V1X-P.1 Redesign standalone chapter previews.** The v1.0 `// @standalone-preview` directive is disabled. Reintroduce independent preview roots only after Tinymist forward/inverse sync task routing is deterministic for main files, imported chapters, template-aware wrappers, render-cache mirrors, Unicode byte offsets, and tab switches. Add end-to-end native tests before restoring the directive or any equivalent UI action.
- [ ] **V1X-P.2 Index long-document forward-sync positions.** Remove the one-to-two-second compiler lookup commonly observed when revealing a cursor from an included file in a very long document. Work with Tinymist or add an equivalent generation-scoped index from source file/span to the first exact PDF position; invalidate it on every compiled generation and keep memory bounded. Do not restore the full SVG/vector snapshot, guess from PDF text, or trade exact included-file mapping for an approximate jump. Benchmark main-file and included-file cold and warm lookups at 200, 500, and 1,500 pages.
- Improve telemetry-free diagnostic bundles that users can explicitly export for bug reports.
- Optimize startup, language-provider lazy loading, long-document memory, and PDF rendering.
- Improve accessibility, platform integration, migration reliability, and release automation.
- Add project health checks for missing files, unavailable fonts, package versions, incompatible toolchains, and broken references.

### User-invoked AI writing assistant

After the stability gates for the release are satisfied, introduce a small, explicitly invoked AI writing assistant. It may help draft, explain, summarize, translate, restructure, or review selected writing. The first release should favor a safe review-and-apply workflow over broad autonomy.

```text
Language tools
  -> deterministic, local, revision-safe analysis
  -> dictionary spellcheck, tokenization, completion, script policies
  -> issues, squiggles, counters, and editor completion

AI writing assistant
  -> user-invoked request
  -> selected text, active file, or explicitly attached project context
  -> conversational response or proposed source patch
  -> preview and explicit acceptance before source mutation
```

The assistant may perform spelling or grammar review when the user manually asks. In v1.x, that output remains an assistant response or proposed patch. It must not publish Language Tools issues, create real-time squiggles, appear in the spellcheck counter, replace deterministic completion, or run continuously while the user types.

### Checklist

- [ ] **V1X-A.1 Define a provider-neutral assistant contract.** Separate model/provider configuration, request scope, streamed output, cancellation, errors, and usage metadata from editor UI.
- [ ] **V1X-A.2 Add an explicit assistant surface.** Open it through a command or panel; do not trigger requests from typing, opening, previewing, importing, or saving.
- [ ] **V1X-A.3 Add scope controls.** Default to the selection; require deliberate attachment of the active file, additional files, or project context.
- [ ] **V1X-A.4 Add privacy disclosure.** Before first remote use, show the provider, content being sent, retention information, and whether local execution is available.
- [ ] **V1X-A.5 Add revision-safe proposed edits.** Capture document key, revision, ranges, and source text; show a diff; reject/rebase stale patches; apply only after acceptance.
- [ ] **V1X-A.6 Preserve Typst structure.** Distinguish prose from syntax, avoid rewriting code outside the requested range, and validate proposed source where possible.
- [ ] **V1X-A.7 Add manual writing actions.** Draft, rewrite, shorten, expand, translate, summarize, explain, and manually requested grammar/spelling review share one contract.
- [ ] **V1X-A.8 Keep AI out of Language Tools state.** Prove it cannot create decorations, diagnostics, autocomplete, ignored words, counters, or provider capabilities.
- [ ] **V1X-A.9 Treat project content as untrusted context.** Prompt content cannot authorize commands, scripts, file writes, hidden attachments, or broader collection.
- [ ] **V1X-A.10 Add deterministic tests.** Use a mock provider for streaming, cancellation, stale-edit rejection, diff application, Unicode/mixed-script ranges, offline state, and errors. CI never calls a live model.
- [ ] **V1X-A.11 Add auditability.** Label AI output and show the exact files/ranges attached to each request.
- [ ] **V1X-A.12 Add a kill switch.** Disabling AI prevents provider initialization and outbound assistant traffic.

### Acceptance criteria

- [ ] Content leaves the device only after an explicit request and provider disclosure/configuration.
- [ ] AI never changes source without visible acceptance.
- [ ] Stale responses cannot overwrite a newer document revision.
- [ ] Manual grammar/spelling review remains a response or proposed patch outside Language Tools.
- [ ] Disabling AI blocks assistant requests while deterministic tools continue working.

---

## Milestone v1.2: Reproducible computation for research

Run Python and MATLAB/Octave workflows in an explicit, isolated environment and make generated artifacts available to Typst.

### Security and reproducibility boundaries

- Never execute scripts when a project is opened, imported, previewed, or rendered.
- Require a visible **Run** action and trust confirmation per project/environment.
- Prefer Python and GNU Octave; MATLAB uses a user-installed licensed copy and is optional.
- Record runtime version, dependencies, command, source/environment hashes, exit status, logs, duration, and output hashes.
- Write declared results to `generated/`; Typst consumes ordinary images, CSV, JSON, or generated `.typ` fragments.
- Cache by inputs/environment, display stale output, support cancellation/timeouts, and constrain resources.
- Keep computation separate from Typst compilation so normal compilation remains deterministic and safe.

### Checklist

- [ ] **V1X-C.1 Define a language-neutral computation manifest and trust model.**
- [ ] **V1X-C.2 Add isolated execution, cancellation, logs, timeouts, and artifact validation.**
- [ ] **V1X-C.3 Add Python virtual-environment support with locked dependencies.**
- [ ] **V1X-C.4 Add GNU Octave and an optional external MATLAB adapter.**
- [ ] **V1X-C.5 Add stale-result detection and explicit rerun controls.**
- [ ] **V1X-C.6 Add examples for plots, tables, simulation output, and algorithm benchmarks.**
- [ ] **V1X-C.7 Define `.typsastra` package policy for scripts, environments, generated results, and trust state.** Trust is never exported as granted.

Continue improving AI assistance with better explicit long-document context, reusable prompts, clearer diffs, local-model adapters where practical, and multilingual evaluation while retaining every `V1X-A` boundary.

---

## Milestone v1.3: Git workflows

Start with safe local workflows before hosting-provider integration.

### Checklist

- [ ] **V1X-G.1 Detect and initialize repositories.**
- [ ] **V1X-G.2 Add Unicode-safe status and diff views.**
- [ ] **V1X-G.3 Add stage/unstage and commit with explicit selection.**
- [ ] **V1X-G.4 Add branch and history views.**
- [ ] **V1X-G.5 Add conflict detection and source-safe resolution.**
- [ ] **V1X-G.6 Document ignore policy for cache, packaged metadata, environments, and generated artifacts.**
- [ ] **V1X-G.7 Delegate credentials to the system Git credential manager.**
- [ ] **V1X-G.8 Add opt-in fetch/pull/push after local operations stabilize.**
- [ ] **V1X-G.9 Prohibit automatic commit, pull, push, rebase, discard, and destructive cleanup.**

Git-aware AI may summarize a user-selected diff or draft text, but it cannot stage, commit, discard, merge, pull, push, or resolve conflicts without a separate explicit Git action.

---

## Cross-cutting v1.x workstream: Khmer workflow and render-preparation reassessment

Khmer remains Typsastra's proof-of-depth. Revisit the complete research-writing workflow and experimental render preparation without assuming the feature should become production-default.

Canonical source remains unchanged. Preparation occurs only in a revision-bound preview/export snapshot and never silently inserts generated ZWSP into source.

### Baseline constraints

- Use `U+200B` ZWSP only at validated lexical boundaries.
- Do not reintroduce Khmer soft-hyphen insertion.
- Never split consonants, COENG sequences, dependent vowels, register shifters, or combining marks into unreadable fragments.
- Compare against ordinary Typst justification/tracking limits, which may remain recommended.
- Use reproducible provider output and locked fixtures, not undocumented heuristic or AI repairs.
- Keep render preparation experimental and default-off until every promotion gate passes.

### Checklist

- [ ] **V1X-K.1 Audit the end-to-end Khmer workflow.** Cover projects, fonts, IME, navigation/deletion, completion, spellcheck, multi-file editing, bibliography, preview, sync, export, interchange, and recovery.
- [ ] **V1X-K.2 Build a licensed representative corpus.** Include folklore, technical/research prose, tables, figures, raw content, mixed Latin, punctuation, non-canonical input, and long unspaced paragraphs.
- [ ] **V1X-K.3 Establish rendering baselines.** Compare plain Typst, tuned tracking/justification, and ZWSP preparation with identical font, width, and compiler.
- [ ] **V1X-K.4 Define lexical safety invariants.** Prevent isolated tails, broken COENG/subscript pairs, split combining sequences, and boundaries inside locked known words.
- [ ] **V1X-K.5 Reassess segmentation strategy.** Evaluate a rendering-oriented mode without changing reproducible suggestion behavior; require fixtures, maintenance, and upstream review before modifying segmentation data.
- [ ] **V1X-K.6 Preserve exact source mapping.** Generated boundaries map exactly to original UTF-16/byte positions for diagnostics, source sync, selection, and correction.
- [ ] **V1X-K.7 Keep preparation scope-aware.** Respect `// @disable-render-prep` and exclude raw/code, labels, URLs, paths, and unsafe syntax.
- [ ] **V1X-K.8 Harden snapshot lifecycle.** Mirrors are revision-consistent, disposable, hidden, excluded from source ZIP, and cannot race LSP or overwrite source.
- [ ] **V1X-K.9 Revisit Khmer typography.** Validate fallback fonts, local scaled fonts, raw behavior, templates, PDF embedding, and cross-platform availability without redistributing font binaries or using `show regex(...)` rewriting.
- [ ] **V1X-K.10 Improve language-tool workflow.** Review completion relevance/cancellation, unknown boundaries, ignored words, dictionary additions, logs, and mixed-script ownership while preserving reproducibility.
- [ ] **V1X-K.11 Add Khmer-compatible project presets.** Extend generic report, thesis, and book templates rather than create a separate architecture.
- [ ] **V1X-K.12 Run native-speaker review on real research and technical documents.**
- [ ] **V1X-K.13 Record a promotion decision.** Promote, retain, redesign, or remove render preparation based on evidence.

### Promotion gates

- [ ] Prepared output improves spacing/line-breaking over tuned Typst across the corpus, not only selected examples.
- [ ] No known fixture introduces an unsafe or unreadable break.
- [ ] Preview and PDF export use equivalent boundaries for the same revision/toolchain.
- [ ] Diagnostics and source navigation remain exact around render-only characters.
- [ ] Long-document preparation meets v1.x latency and memory budgets.
- [ ] Disabling preparation returns exactly to ordinary Typst behavior with no residue.
- [ ] Settings state tested limits and experimental/stable status honestly.

The technical transformation contract remains in the [Khmer render-preparation plan](./TYPSASTRA_KHMER_RENDER_PREPARATION_IMPLEMENTATION_PLAN.md).

---

## Later v1.x candidates

- Global Unicode/grapheme-aware project search and replace.
- Typst package inventory, compatibility checks, and lock/export assistance.
- Citation and bibliography workflow improvements.
- Project health reports and one-click support bundles.
- Signed update checks with explicit user control.
- Additional stable complex-script providers after conformance and maintainer requirements pass.

## v1.x release gate

Each v1.x release must pass v1.0 project interchange, font-free export, data recovery, Khmer regression, long-document, installer, and migration tests. A milestone feature cannot waive a failed baseline gate.
