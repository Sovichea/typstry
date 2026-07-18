# Typsastra benchmark report

Generated: 2026-07-18T05:14:02.171Z<br>
Revision: `d235150` (working tree had uncommitted changes)

## Scope

This report measures CLI compiler process time, incremental spellcheck-range calculation, and built frontend artifact size. It does **not** claim to measure total Typsastra desktop memory, end-to-end WebView preview latency, gesture smoothness, or scrollbar-release latency.

## Machine and tools

| Item | Value |
|---|---|
| OS | Windows_NT 10.0.26200 (x64) |
| CPU | Intel(R) Core(TM) Ultra 7 155H (22 logical CPUs) |
| Installed memory | 15.37 GiB |
| Bun | 1.3.14 |
| Typst | typst 0.15.0 (3ae52774) |
| Tinymist npm package | 0.12.16 (managed runtime not exercised by this harness) |

## Results

Each warm compiler result contains five fresh Typst CLI processes after a fixture-specific warmup.

| Workload | Minimum | Median | p95 / maximum |
|---|---:|---:|---:|
| One-page compile | 297.24 ms | 298.27 ms | 313.11 ms |
| 20-page multilingual interaction fixture compile | 333.95 ms | 356.22 ms | 404.61 ms |
| 30-page compile | 350.87 ms | 378.95 ms | 402.24 ms |
| 100-page compile | 455.33 ms | 470.26 ms | 474.70 ms |
| 1,000 incremental range calculations | 15.16 ms | 18.29 ms | 35.80 ms |

- First-process one-page compile: **535.78 ms**. This does not clear OS filesystem caches.
- Largest submitted incremental spellcheck range: **32 UTF-16 units** from a 100,000-unit document.
- Built frontend `dist/` size: **3.91 MiB**. This is not installer size.
- The generated 20-page interaction PDF is **129.08 KiB**.

## Preview interaction qualification

The implementation now records these in-app metrics:

```text
preview.motion-handler
preview.motion-settle
preview.deceleration-prerender
preview.destination-final-commit
preview.render-cancel
preview.render-promote
```

The repository does not yet publish gesture-scroll or scrollbar-release numbers. Those measurements require actual input inside Windows/WebView2 and Linux/WebKitGTK. Developer diagnostics emit rolling p50, p95, and maximum summaries after every 20 samples.

The v1.0 targets remain:

| Interaction metric | Target |
|---|---:|
| Motion handler p95 | under 8 ms |
| Final destination page p95 | under 500 ms |
| Resident final canvases | 7 maximum |

Manual Windows/WebView2 A/B qualification selected PDF.js hardware acceleration with direct canvas ownership and browser FontFace rendering. It was materially faster than path-based embedded-glyph rendering. Gesture deceleration, split-page settle rendering, and native scrollbar-release fallback were then qualified interactively. This is observational qualification, not a published timing benchmark.

## Comparison with the 2026-07-13 run

The current run is slower for the CLI fixtures and slightly faster for median incremental-range calculation. These are separate five-sample runs on a non-isolated development machine, so the differences should not be attributed to the preview scheduler implementation.

| Workload | 2026-07-13 median | 2026-07-18 median |
|---|---:|---:|
| One-page compile | 238.46 ms | 298.27 ms |
| 30-page compile | 273.26 ms | 378.95 ms |
| 100-page compile | 364.54 ms | 470.26 ms |
| 1,000 incremental range calculations | 21.15 ms | 18.29 ms |

## Limitations

- The first-process compile does not clear operating-system filesystem caches.
- Typst CLI process timings are not equivalent to in-app Tinymist preview latency.
- Frontend `dist/` size is not installer size.
- Desktop, WebView, PDF renderer, GPU, and Tinymist memory are not measured by this harness.
- The working tree contained the preview interaction implementation being measured but had not yet been committed.

## Reproduce

From the repository root, with Typst available on `PATH`:

```sh
bun install --frozen-lockfile
bun run build
bun run benchmark:performance
```

The harness writes a Markdown report and raw JSON under the ignored `artifacts/performance/` directory. The raw data for this published run is committed at [`benchmarks/results/2026-07-18-windows.json`](../benchmarks/results/2026-07-18-windows.json).
