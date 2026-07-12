# Khmer Editor Segmentation Implementation Plan

## Objective

Make Khmer spellcheck, correction suggestions, and real-time word completion safe under rapid editing, tab changes, Unicode normalization, and long Typst documents. Keep the language boundary modular so another language can add a provider without changing CodeMirror or introducing a language-specific Tauri command.

This plan covers the code editor only. Typst preview/export segmentation remains a separate pipeline, although both pipelines continue using the same Rust provider registry.

## Current Baseline

- [x] Khmer segmenter is pinned as `third_party/khmer_segmenter`.
- [x] The Rust provider converts returned ranges to CodeMirror UTF-16 offsets.
- [x] Spellcheck can be enabled or disabled in Settings.
- [x] Unknown tokens receive editor decorations and correction suggestions.
- [x] Native segmentation runs outside the Tauri UI thread.
- [x] Current automated baseline has been refreshed after the language-tools work; use the validation checklist below for the authoritative command set.
- [x] Request results are tied safely to a document revision.
- [x] Normalization-changing input retains usable source ranges.
- [x] Completion identifies the current segmented word in unspaced Khmer text.
- [x] Analysis is incremental for long documents.
- [x] Frontend commands and script detection are language-neutral.

## Confirmed Failure Modes

1. `SpellcheckController.schedule()` does not invalidate an in-flight request until the next delayed analysis begins. An old response can therefore decorate a newly edited document or a different tab.
2. Suggestion popups and replacements retain raw offsets without verifying that the document and source text are unchanged.
3. Any normalization change causes Rust to return no tokens, which disables spellcheck for the entire document.
4. Khmer autocomplete matches the entire contiguous Khmer run. In naturally unspaced prose, that run grows into a sentence and ceases to be a useful dictionary prefix.
5. Each analysis sends and segments the complete document. Superseded `spawn_blocking` tasks continue running even though their results are discarded.
6. Correction fallback may scan all 88,303 dictionary entries and calculate code-point edit distance for each candidate.
7. Rust exposes a provider trait, but the frontend still contains Khmer regexes and invokes `autocomplete_khmer` directly.
8. Context-menu fallback can select the first occurrence of a repeated word rather than the clicked occurrence.
9. Native invocation failures are not represented as controlled editor state.

## Target Architecture

### Frontend

Introduce an editor-level `LanguageToolsController` under `src/editor/languageTools/`:

```text
src/editor/languageTools/
  controller.ts       request lifecycle and document revisions
  state.ts            CodeMirror issues and decorations
  completion.ts       language-neutral completion source
  context.ts          issue lookup and safe replacement
  types.ts            IPC and editor-facing contracts
```

`appController.ts` should only:

- notify the controller when the active document changes;
- install its CodeMirror extensions;
- connect Settings and context-menu callbacks.

Every open document receives a stable `documentKey` based on `filePathKey(path)` and a monotonically increasing revision. The revision increments immediately on a document change, tab activation, close, workspace close, or spellcheck disable—not when the debounce expires.

### Rust

Keep `LanguageSegmenter`, but replace language-specific editor commands with:

```rust
analyze_language_ranges(request: AnalyzeRequest) -> AnalyzeResponse
complete_language_word(request: CompletionRequest) -> CompletionResponse
language_suggestions(request: SuggestionRequest) -> SuggestionResponse
```

Each returned token contains:

```rust
struct EditorToken {
    provider: String,
    source_from_utf16: usize,
    source_to_utf16: usize,
    source_text: String,
    normalized_text: String,
    known: bool,
    known_prefix: bool,
}
```

The registry runs every provider that overlaps the submitted ranges and merges non-overlapping results. It must not stop at the first provider that supports any part of the document.

## Phase 1: Make Async Results and Replacements Safe

### Implementation

- Increment the document revision synchronously whenever editor content or active file identity changes.
- Capture `{ documentKey, revision, docIdentity }` before scheduling native work.
- Apply a response only when all captured values still match.
- Invalidate pending popup requests independently from analysis requests.
- Store `documentKey`, `revision`, `from`, `to`, and `sourceText` in every spelling issue.
- Before replacement, verify `doc.sliceString(from, to) === sourceText`. If not, dismiss the action and schedule fresh analysis.
- Remove the `textContent`-based first-match fallback from `appController.ts`.
- Treat issue ranges as half-open `[from, to)`. Handle a glyph-edge click through the actual decoration DOM target, not a document-wide nearest-word search.
- Catch native invocation failures. Keep existing valid decorations, close stale popups, and log one deduplicated warning.

### Checklist

- [x] Add stable document keys and immediate revision invalidation.
- [x] Guard analysis responses by document key, revision, and CodeMirror document identity.
- [x] Guard popup responses independently.
- [x] Verify source text before every replacement.
- [x] Remove repeated-word first-match fallback.
- [x] Correct half-open boundary handling.
- [x] Add controlled IPC error handling.
- [x] Add tests for edit, tab-switch, close-tab, and delayed-response races.

### Acceptance Criteria

- Switching tabs while analysis is running never adds marks to the new tab.
- Clicking an old suggestion after typing cannot replace unrelated text.
- Repeated misspellings replace only the clicked occurrence.
- A rejected native request does not produce an unhandled promise rejection.

## Phase 2: Preserve Ranges Through Khmer Normalization

### Preferred Implementation

Extend the owned Khmer segmenter normalization API to preserve source spans. Each emitted normalized scalar or cluster must retain the original byte range that produced it. Segmentation tokens can then expose both normalized ranges and original source ranges.

This is preferable to reconstructing ranges in Typstella because Khmer normalization may reorder marks or combine multiple source code points. A diff performed after normalization is ambiguous and can select the wrong cluster.

Required upstream shape:

```rust
struct NormalizedUnit {
    text: String,
    source_range: Range<usize>,
}

struct MappedSegment {
    normalized_range: Range<usize>,
    source_range: Range<usize>,
}
```

Typstella converts the returned original byte boundaries to UTF-16 once. ZWSP, ZWNJ, and ZWJ removal must preserve boundary mapping rather than forcing a document-wide failure.

### Checklist

- [x] Add source-span-preserving normalization to the Khmer segmenter submodule.
- [x] Add mapped segmentation output without breaking the existing simple API.
- [x] Consume mapped ranges in `KhmerProvider::analyze`.
- [x] Remove `normalizedChanged` as a reason to clear all editor issues.
- [x] Define behavior for reordered marks, combined vowels, ZWSP, ZWNJ, and ZWJ.
- [x] Add exact byte-to-UTF-16 assertions, including non-BMP text before Khmer runs.
- [x] Pin the updated submodule commit.

### Acceptance Criteria

- One non-canonical Khmer cluster does not disable spellcheck elsewhere.
- Underlines cover the original visible source text after normalization.
- Mixed emoji, Latin, and Khmer source produces exact CodeMirror ranges.

## Phase 3: Segment-Aware Real-Time Completion

### Implementation

Replace `autocomplete_khmer(prefix)` with `complete_language_word`.

The request includes the active logical range and cursor offset. The provider segments the text before the cursor and identifies the final incomplete token or unknown suffix. The response supplies an explicit UTF-16 replacement range and ranked options. CodeMirror must use that range rather than matching a whole Khmer sentence with a regex.

Completion should remain visible while the current token is a dictionary prefix. It should close on cursor relocation outside the token, document change invalidation, or an explicit dismissal.

### Checklist

- [x] Add a provider-neutral completion request and response.
- [x] Derive the active token from segmentation, not a contiguous-script regex.
- [x] Return an explicit replacement range.
- [x] Preserve completion through unspaced Khmer sentence entry.
- [x] Remove `autocomplete_khmer` after migration.
- [x] Add tests with multiple unspaced words and punctuation.

### Acceptance Criteria

- Completion works on the second and later words of an unspaced Khmer sentence.
- Accepting a completion replaces only the current partial token.
- Completion never duplicates adjacent source text.

## Phase 4: Incremental Analysis and Bounded Suggestions

### Incremental Analysis

- Track CodeMirror changed ranges.
- Expand each changed range to the containing logical line or Khmer run plus one adjacent run for boundary stability.
- Send only those ranges to Rust.
- Map existing decorations through the CodeMirror transaction while analysis is pending.
- Replace issues only inside analyzed ranges.
- Perform a full-document scan on file open, external reload, provider/settings change, and explicit refresh.
- Coalesce overlapping ranges and permit at most one queued analysis per document.

### Suggestion Index

- Build an immutable suggestion index once during provider initialization.
- Bucket words by leading Khmer cluster and cluster count.
- Use Khmer clusters—not Unicode scalar values—as edit-distance units.
- Bound candidate count before weighted edit-distance ranking.
- Use dictionary frequency metadata when available; otherwise rank by distance, length difference, and lexical order.
- Never fall back to an unrestricted full-dictionary scan during an interactive request.

### Checklist

- [x] Introduce range-based analysis requests.
- [x] Coalesce rapid edits per document.
- [x] Limit active/queued jobs.
- [x] Preserve unaffected decorations.
- [x] Build a bounded correction index at provider startup.
- [x] Implement cluster-aware ranking.
- [x] Add performance fixtures for long documents.

### Performance Gates

- A single-character edit in a 100,000-character document does not resend the full document.
- Interactive analysis reaches the editor within 100 ms at the 95th percentile on a release build after the debounce.
- Suggestion lookup reaches the context menu within 50 ms at the 95th percentile on a release build.
- Continuous typing does not grow an unbounded native task queue.

## Phase 5: Complete the Provider Boundary

### Implementation

- Move script detection into provider metadata returned by Rust.
- Let the registry return results from multiple providers for mixed-language documents.
- Replace Khmer-specific frontend labels and commands with provider-neutral contracts.
- Retain provider IDs on issues so suggestions route back to the provider that created them.
- Keep provider registration explicit in Rust; contributors should only implement the trait, add test fixtures, and register the provider.

### Checklist

- [x] Return provider capabilities during application initialization.
- [x] Remove Khmer regexes from generic frontend controllers.
- [x] Analyze multiple supported scripts in one request.
- [x] Route completion and suggestions by provider ID.
- [x] Document the contributor contract in `SKILLS.md` after implementation stabilizes.
- [x] Add a mock second provider test to prove the boundary.

### Acceptance Criteria

- A test provider can be registered without modifying CodeMirror integration.
- Two language providers can return independent issues in the same document.
- Provider-specific failures do not suppress successful results from other providers.

## Test Matrix

### Rust Unit Tests
 
- [x] Exact source ranges for canonical Khmer.
- [x] Exact source ranges after mark reordering and vowel composition.
- [x] ZWSP, ZWNJ, and ZWJ range preservation.
- [x] Latin and non-BMP characters before and after Khmer.
- [x] Known word, unknown word, known prefix, and merged unknown runs.
- [x] Cluster-aware correction ordering.
- [x] Bounded candidate search.
- [x] Mixed-provider result merging.
 
### Frontend Unit Tests
 
- [x] Immediate revision invalidation before debounce expiry.
- [x] Old response after typing.
- [x] Old response after tab activation.
- [x] Old popup response after cursor movement.
- [x] Safe replacement with matching and mismatching source text.
- [x] Repeated unknown words and boundary clicks.
- [x] Incremental issue replacement without losing unaffected marks.
- [x] Completion inside a long unspaced Khmer run.
- [x] IPC rejection and recovery.
 
### Manual Tests
 
- [x] Type continuously in canonical and non-canonical Khmer.
- [x] Switch tabs repeatedly while underlines are updating.
- [x] Right-click before, inside, and after a single-cluster unknown word.
- [x] Correct the second of two identical unknown words.
- [x] Edit a long chapter while preview and Tinymist LSP are active.
- [x] Disable and re-enable spellcheck while a request is running.
- [x] Reload a file modified outside Typstella.
- [x] Verify Windows, Linux, and macOS behavior.
 
## Validation Checklist
 
Run after every phase:
 
- [x] `bun test`
- [x] `bun run build`
- [x] `cargo fmt --check` from `src-tauri/`
- [x] `cargo check --lib` from `src-tauri/`
- [x] `cargo test --lib` from `src-tauri/`
- [x] `git diff --check`
 
Before merging:
 
- [x] All phase acceptance criteria pass.
- [x] No unrestricted dictionary scan remains on an interactive path.
- [x] No language-specific command remains in generic editor code.
- [x] No stale response can mutate a different revision.
- [x] Submodule commit is pinned and reproducible in CI.
- [x] `DEVELOPMENT_CONTEXT.md` is updated after the implementation is confirmed successful.

## Recommended Delivery Order

1. Phase 1 first because stale offsets can produce incorrect edits.
2. Phase 2 next because normalization currently disables the feature globally.
3. Phase 3 to make real-time Khmer completion behave correctly in normal unspaced prose.
4. Phase 4 before enabling the feature by default for large thesis projects.
5. Phase 5 after the contracts have been exercised by the Khmer implementation.

Each phase should be a separate reviewable commit. Do not combine the normalization submodule update with frontend race handling in one commit.
