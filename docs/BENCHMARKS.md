# Typsastra benchmark report

Generated: 2026-07-18T05:14:02.171Z<br>
Revision: `d235150` (working tree had uncommitted changes)

## Scope

The automated report measures CLI compiler process time, incremental
spellcheck-range calculation, and built frontend artifact size. A separate
manual observation below records desktop memory behavior; it is not produced by
the benchmark harness. The report does **not** claim automated end-to-end WebView
preview latency, gesture smoothness, or scrollbar-release timing.

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

## Manual 200-page memory observation

On the same Windows development machine, the same approximately 200-page Typst
document was opened in the Typsastra development build and in the local Visual
Studio Code/Tinymist SVG-preview setup. Windows Task Manager working-set values
were recorded after compilation and during the following idle observation.

| Observation | Application / renderer | Tinymist | Development server | Approximate total |
|---|---:|---:|---:|---:|
| Typsastra peak capture | 613.8 MiB | 214.4 MiB | 433.4 MiB | 1,261.6 MiB |
| Typsastra later capture | 528.4 MiB | 214.2 MiB | 303.7 MiB | 1,046.3 MiB |
| Typsastra later capture, excluding dev server | 528.4 MiB | 214.2 MiB | — | 742.6 MiB |
| VS Code initial capture | 887.7 MiB | 423.7 MiB | included in VS Code group | 1,311.4 MiB |
| VS Code later capture | 4,227.8 MiB | 265.0 MiB | included in VS Code group | 4,492.8 MiB |
| VS Code final capture | 4,534.8 MiB | 263.0 MiB | included in VS Code group | 4,797.8 MiB |

Typsastra's application/WebView working set fell after its peak while Tinymist
remained close to 214 MiB. The observed VS Code process group continued growing
through the final capture and did not reach a stable idle value. Its final
combined observation was about 6.5 times Typsastra's later production-equivalent
total, which excludes the Vite/Node development server.

This comparison is evidence for the bounded PDF-canvas architecture on this
fixture and machine, not a universal VS Code claim. The VS Code process group
includes the user's installed extensions, Task Manager reports working set rather
than a controlled private-byte process tree, input timing was not automated, and
no raw sampling trace was captured. A separate 500-page stress attempt reached
approximately 7 GiB in the observed VS Code environment and crashed before it
settled; that attempt is recorded only as a stress observation, not a comparable
benchmark result.

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
- Desktop, WebView, PDF renderer, GPU, and Tinymist memory are not measured by
  the automated harness. The manual table above is a Task Manager observation.
- The working tree contained the preview interaction implementation being measured but had not yet been committed.

## Reproduce

From the repository root, with Typst available on `PATH`:

```sh
bun install --frozen-lockfile
bun run build
bun run benchmark:performance
```

The harness writes a Markdown report and raw JSON under the ignored `artifacts/performance/` directory. The raw data for this published run is committed at [`benchmarks/results/2026-07-18-windows.json`](../benchmarks/results/2026-07-18-windows.json).
