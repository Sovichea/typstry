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
| Preview motion handler p95 | 8 ms |
| Final destination page after settle p95 | 500 ms |
| Valid edit after compiler failure | 3,000 ms |
| Spellcheck analysis p95 after debounce | 100 ms |
| Interactive suggestion lookup p95 | 50 ms |
| Resident rendered PDF pages | 7 maximum |
| Queued language-analysis requests | 1 maximum |

The canonical values live in `src/performance/diagnostics.ts`. A budget change requires a benchmark report and an explanation in this document.

## Workloads

`benchmarks/fixtures/` contains deterministic one-page, 20-page interaction, 30-page, and 100-page mixed-script Typst projects. `bun run benchmark:performance` measures five fresh compiler processes per warmed compile fixture, then generates a 100,000-character mixed-script source and measures ten runs of 1,000 incremental-range calculations. The 20-page fixture is reserved for real-WebView gesture and scrollbar qualification. Generated PDFs and JSON/Markdown reports are written under ignored `artifacts/performance/`.

The current published, repeated-sample Windows baseline is in [the benchmark report](./BENCHMARKS.md), with raw JSON under `benchmarks/results/`. Its warm medians on 2026-07-18 were:

| Workload | Result |
|---|---:|
| One-page Typst compile | 298.27 ms median |
| 20-page multilingual interaction fixture compile | 356.22 ms median |
| 30-page Typst compile | 378.95 ms median |
| 100-page Typst compile | 470.26 ms median |
| 1,000 incremental edits in a 100,000-character source | 18.29 ms median |
| Largest submitted spellcheck range | 32 UTF-16 units |

These CLI values measure reproducibility and compiler cost, not WebView rendering latency. Runtime preview, zoom, recovery, and JavaScript heap metrics come from developer diagnostics. Total application, WebView, and GPU memory must also be sampled with the operating-system process monitor because browser heap APIs do not include GPU allocations.

## Runtime contracts

- Spellcheck maps existing issues through edits, expands only changed logical ranges, coalesces overlaps, and permits one active plus one queued request.
- Suggestions use provider indexes. Khmer edit-distance ranking is capped at 1,000 candidates and completion scanning at 1,024 candidates.
- PDF preview presentation reads the first page geometry synchronously, estimates the remaining slots, and hydrates exact page sizes in yielding background batches.
- Only the focused window of at most seven pages retains canvases. The obsolete invisible PDF text layer is not built; source synchronization remains coordinate-based and links use the annotation layer.
- Preview iframe scrollbar rules target its scrolling body instead of every rendered PDF element.
- Visible page canvases render through a priority queue using PDF.js hardware acceleration, direct canvas ownership, and browser FontFace rendering.
- Gesture deceleration projects the likely stopping page and starts one final render before motion ends. The first stable frame queues every viewport-intersecting page using up to two render lanes.
- Scroll motion cancels only work outside the destination window. Recently rendered final canvases remain resident within the seven-page budget.
- Native scrollbar release does not depend on WebView pointer delivery. Stable-frame detection starts final rendering immediately and forces idle after a bounded fallback if `pointerup` is lost.
- Cancelled renders retain shared PDF page resources until every owner finishes, preventing stale cleanup from blanking a replacement canvas.
- A new PDF generation destroys an obsolete pending PDF.js load, cancels page renders, and rejects stale load, render, source-map, spellcheck, and compilation results.
- The last valid PDF remains mounted until the replacement document and its page dimensions are ready. Zoom keeps the prior canvas visible until its current-resolution replacement commits.
- Language catalogs and provider indexes initialize after the main window becomes usable.

## Automation

`.github/workflows/performance-gates.yml` runs the fixture matrix, contract tests, production frontend build, and native release-library build on Windows and Linux. Its JSON reports are retained as workflow artifacts for comparisons.

Pure motion, scheduler, promotion, and cancellation-policy behavior is covered by `tests/previewInteraction.test.ts`. Commit latency, gesture input delay, GPU/WebView behavior, and process memory require real desktop input and operating-system measurement.

Before a release, manually verify on both platforms:

1. Open `20-pages-interaction.typ`; record p50, p95, and maximum motion-handler, deceleration-prerender, and destination-final metrics while gesture-scrolling and dragging the scrollbar.
2. Open the 100-page fixture and scroll from beginning to end.
3. Confirm diagnostics never report more than seven final pages.
4. Release and immediately re-grab the scrollbar, reverse direction, and confirm no obsolete destination renders first.
5. Zoom repeatedly and confirm visible pages recover at full resolution.
6. Introduce a syntax error, repair it, and confirm preview and diagnostics recover without restarting Tinymist.
7. Record the Typsastra, WebView, renderer/GPU, and Tinymist process memory after a complete scroll.
8. Open and close an undocked preview and confirm no uninitialized intermediate document becomes visible.
