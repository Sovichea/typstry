# Language Scope Parser Baseline

Measured on 2026-07-16 on the Windows development machine used for Typsastra v0.4.1. These are local engineering gates, not cross-platform product benchmarks.

## Selected strategy

Typsastra pins the official `typst-syntax` parser at `0.15.0`. Regex-only extraction is prohibited. Parser upgrades require the native and frontend fixture suites, the managed-toolchain compatibility fixture, and the large-document benchmarks to pass.

The compatibility fixture at `tests/fixtures/language-scopes/compat.typ` compiled successfully with:

| Typst | Result |
| --- | --- |
| 0.13.1 | Pass |
| 0.14.2 | Pass |
| 0.15.0 | Pass |

These versions cover the archived project-format floor, the intermediate managed line, and the current development compiler. New stable managed versions must be added to this matrix before Typsastra promotes them. The extractor parses source independently of Tinymist and does not invoke a compiler.

## Cost gate

| Measurement | Result |
| --- | ---: |
| 100k-character extraction, optimized | 2.948 ms |
| 1,000-declaration extraction, optimized | 2.539 ms |
| Same cases, unoptimized test profile | 33.662 ms / 13.340 ms |
| Optimized `typst-syntax` rlib before final linking | 3,815,738 bytes |
| Existing release executable before this work | 25,627,648 bytes |
| Release executable after final linking | 24,300,032 bytes |
| First full release test/build after adding the dependency | approximately 6 minutes 52 seconds |
| Subsequent release test link | 108.46 seconds |
| Startup execution cost | none; parser initialization is not on the startup path |

The executable comparison shows no shipped-size regression in this local build, although link-time optimization means the intermediate rlib size must not be interpreted as installed-size growth. The accepted budget is: under 10 ms for each optimized stress fixture, no parser work during startup, and no more than 5 MB release executable growth. A future parser upgrade exceeding any threshold requires an explicit review and updated measurements.

Extraction runs through Tauri's blocking worker pool after a 120 ms frontend debounce. The response carries document identity and revision, and stale responses are discarded.

