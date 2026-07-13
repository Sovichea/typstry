# Reliability and performance gates

Phase 7 turns Typsastra's existing incremental language analysis and virtual PDF viewer into measured contracts. Metrics are printed to the web developer console and appear in the Dev log tab when Developer mode is enabled.

## Approved budgets

| Metric | Budget |
|---|---:|
| Usable editor | 2,500 ms |
| Deferred provider initialization | 2,500 ms |
| First diagnostic after opening a source | 3,000 ms |
| One-page preview compilation | 2,000 ms |
| First visible PDF page | 1,000 ms |
| Visible PDF page render | 500 ms |
| Zoom rerender | 750 ms |
| Valid edit after compiler failure | 3,000 ms |
| Spellcheck analysis p95 after debounce | 100 ms |
| Interactive suggestion lookup p95 | 50 ms |
| Resident rendered PDF pages | 7 maximum |
| Queued language-analysis requests | 1 maximum |

The canonical values live in `src/performance/diagnostics.ts`. A budget change requires a benchmark report and an explanation in this document.

## Workloads

`benchmarks/fixtures/` contains deterministic one-page, 30-page, and 100-page mixed-script Typst projects. `bun run benchmark:performance` also generates a 100,000-character mixed-script source and performs 1,000 repeated incremental-range calculations. Generated PDFs and reports are written under ignored `artifacts/performance/`.

Local Windows baseline on 2026-07-11 after compiler warmup:

| Workload | Result |
|---|---:|
| One-page Typst compile | 1,189 ms |
| 30-page Typst compile | 1,241 ms |
| 100-page Typst compile | 1,250 ms |
| 1,000 incremental edits in a 100,000-character source | 109 ms total |
| Largest submitted spellcheck range | 32 UTF-16 units |

These CLI values measure reproducibility and compiler cost, not WebView rendering latency. Runtime preview, zoom, recovery, and JavaScript heap metrics come from developer diagnostics. Total application, WebView, and GPU memory must also be sampled with the operating-system process monitor because browser heap APIs do not include GPU allocations.

## Runtime contracts

- Spellcheck maps existing issues through edits, expands only changed logical ranges, coalesces overlaps, and permits one active plus one queued request.
- Suggestions use provider indexes. Khmer edit-distance ranking is capped at 1,000 candidates and completion scanning at 1,024 candidates.
- PDF slots preserve page geometry, but only the focused window of at most seven pages retains canvases and text layers.
- A new PDF generation destroys an obsolete pending PDF.js load, cancels page renders, and rejects stale load, render, source-map, spellcheck, and compilation results.
- The last valid PDF remains mounted until the replacement document and its page dimensions are ready. Zoom keeps the prior canvas visible until its current-resolution replacement commits.
- Language catalogs and provider indexes initialize after the main window becomes usable.

## Automation

`.github/workflows/performance-gates.yml` runs the fixture matrix, contract tests, production frontend build, and native release-library build on Windows and Linux. Its JSON reports are retained as workflow artifacts for comparisons.

Before a release, manually verify on both platforms:

1. Open the 100-page fixture and scroll from beginning to end.
2. Confirm the performance log never reports more than seven resident pages.
3. Zoom repeatedly and confirm visible pages recover at full resolution.
4. Introduce a syntax error, repair it, and confirm preview and diagnostics recover without restarting Tinymist.
5. Record the Typsastra, WebView, renderer/GPU, and Tinymist process memory after a complete scroll.
6. Open and close an undocked preview and confirm no uninitialized intermediate document becomes visible.
