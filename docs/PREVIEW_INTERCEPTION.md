# PDF Preview and Source Synchronization

Typsastra uses Tinymist for compilation, diagnostics, and source-map positions, but the docked preview is rendered by Typsastra's own PDF viewer. This replaced the earlier intercepted SVG/DOM preview because large documents consumed too much WebView/GPU memory and PDF text extraction was unreliable for Khmer and other complex scripts.

## Current architecture

The docked preview path is:

1. Mirror the active workspace file into Typsastra's render cache when render preparation is active.
2. Ask Tinymist/Typst to compile the selected preview root to PDF.
3. Render the PDF with `pdfjs-dist` in a virtualized iframe.
4. Keep only nearby pages rendered; pages outside the viewport are released.
5. Use Tinymist's preview source-map data plane for forward and inverse sync through a one-connection native loopback bridge.

The native bridge is required because current Tinymist versions validate the
browser WebSocket `Origin`. A Tauri WebView cannot replace that header, so the
Rust bridge connects upstream with the expected Tinymist loopback origin while
preserving Tinymist's origin security check. Each bridge accepts one browser
connection and then closes with its source-map session.

The preview viewer does not use extracted PDF text to resolve source locations. PDF text extraction is too lossy for complex scripts and can produce incorrect offsets. Source synchronization should either use Tinymist source-map coordinates or fail visibly in developer logs.

## Forward sync

Forward sync starts only from the explicit **Reveal Cursor in Preview** toolbar
action or its keyboard shortcut. Cursor movement and tab activation never
request preview scrolling.

- Windows and Linux: `Alt+Enter`
- macOS: `Option+Enter`

1. Typsastra maps the editor cursor to the source file that Tinymist sees. If Khmer render preparation is active, this may be a generated cache file.
2. Typsastra sends a `panelScrollTo` request to a Tinymist source-map preview task.
   It chooses one likely rendered Unicode code-point column, including at line
   and prose-run starts. It never speculatively queues nearby candidates because
   Tinymist resolves each request by scanning the compiled document.
3. Tinymist returns a PDF document position as a binary
   `jump,<page> <x> <y>` data-plane frame.
4. Typsastra scrolls the PDF viewer to the page and line position reported by Tinymist.

### Known limitation

Tinymist currently resolves forward sync to the beginning of the matching source
line rather than the editor cursor's precise horizontal position. Typsastra
therefore guarantees navigation to the correct page and line, but not to the
exact x/y position within that line. The viewer intentionally does not refine
the result by matching extracted PDF text because that approach is unreliable
for repeated text, generated content, mixed scripts, and complex scripts such
as Khmer.

Tinymist 0.15.2 scans every compiled page while resolving a source position.
Lookup latency therefore still grows with document length. Typsastra sends only
one request per reveal so a slow lookup cannot create a queue of repeated
whole-document scans. The developer log separates local mapping, source-map
session readiness, and compiler lookup timings for further qualification.

This scan is particularly noticeable when revealing a cursor from an included
file in a very long document. A main-file reveal may appear nearly instant while
an included chapter takes one or two seconds, even though both ultimately land
at the correct page and line. Typsastra's render-cache path and byte-offset
translation take only a small part of that time; the remaining compiler lookup
is currently a known issue. The v1.x plan tracks a generation-scoped source
position index so included-file lookup no longer requires a whole-document scan.
Until that work lands, Typsastra will preserve exact compiler-owned mapping
rather than substitute a faster approximate or PDF-text-based jump.

If the source-map socket is unavailable, Typsastra logs the failure and does not pretend that the sync succeeded.

## Inverse sync

Inverse sync starts from a PDF click.

1. The PDF viewer records the clicked page and PDF coordinate.
2. Typsastra sends the coordinate to Tinymist's source-map data plane.
3. Tinymist returns the source URI and LSP position.
4. Typsastra maps generated render-cache locations back to the original editor file when needed.
5. The editor opens the target file, scrolls to the source position, and shows the caret ripple.

The previous PDF text-matching fallback was removed. It was not deterministic enough for Khmer, repeated text, mixed scripts, and generated preview files.

## Render modes

v0.5.2 supports both PDF render modes:

- `on-type` keeps edits in memory and updates the PDF after the configured
  debounce interval. It is intended for responsive iteration on short
  documents.
- `on-save` updates only after a successful save and remains preferable for
  long or resource-intensive documents.

Typsastra will continue qualifying the current PDF-on-type implementation before
deciding whether a separate bounded SVG renderer provides enough additional
value. SVG preview is an experiment, not a committed v0.5.3 replacement.

Imported files currently preview through their configured main document. Independent standalone roots remain disabled pending the portable v0.5.3 Full Document/Active File implementation plan; `V1X-P.1` owns later qualification and hardening.

The experimental decoded-image preflight remains disabled in v0.5.2 while its
format probing and dependency discovery are corrected and qualified. Typsastra
does not automatically hide, downsample, convert, or block source images.
Non-destructive detection and author confirmation are planned for v0.5.3.

PDF forward and inverse sync use one hidden Tinymist web-preview task solely for its source-map data plane. The task ID ends in `-source-map`; Typsastra serializes concurrent startup requests and calls `tinymist.doKillPreview` before replacing a stale task. Do not start a normal-task fallback: Tinymist can reject a second registration against the same compiler instance with `cannot register preview to the compiler instance`.

Typsastra starts this hidden task immediately after publishing a compiled PDF,
instead of waiting for the first synchronization gesture. WebSocket connection
and compiler readiness are separate states: the socket is connected when it
opens, but the task may have published its initial vector frame before the
WebSocket listener was attached. Typsastra therefore sends a disposable source
position probe and retries it while compilation is pending. The first `jump`
response proves that the source map is usable; a natural `new` or `diff-v1`
frame can establish the same state. Probe positions are discarded and never
move the PDF preview.

Typsastra deliberately does not send Tinymist's `current` command because that
would request an additional complete vector-document snapshot. The readiness
probe exercises only the source-position path required by forward and inverse
sync, without retaining a vector payload.

## Security boundaries

Preview helper commands remain narrow:

- Preview file mirroring only writes under Typsastra's workspace-local render cache.
- Source-map communication uses Tinymist preview tasks and loopback WebSocket URLs.
- External preview resources are not exposed as a general-purpose network proxy.

## Debug logs that indicate success

With developer mode enabled, healthy source-map sync should show logs like:

```text
Starting hidden Tinymist source-map session: root=...; task=...
Tinymist source-map data plane connected without requesting a vector document snapshot: ws://127.0.0.1:<port>/.
Source-map session warmed after PDF presentation in <ms>ms.
Requested one compiler preview position: <file>:<line>:<column>; localMappingMs=<ms>; sessionReadyMs=<ms>; documentReadyMs=<ms>.
Compiler document position: candidates=1, page=<n>, x=<x>, y=<y>, lookupMs=<ms>.
Sending compiler inverse position: page=<n>, x=<x>, y=<y>.
Compiler source response: uri=..., line=<line>, character=<character>.
Editor inverse position applied: offset=<offset>.
```

Common failure logs:

```text
Tinymist source-map session failed to start for task ...
Skipped PDF forward sync: source-map socket unavailable.
Skipped PDF inverse sync: source-map socket unavailable.
Forward sync timed out waiting for Tinymist source-map position.
Ignored source-map payload without PDF position: ...
```

Those failures mean Typsastra did not receive a reliable source-map coordinate from Tinymist. The viewer should not fall back to PDF text matching.

## Files involved

- `src/preview/previewFrame.ts`: virtualized PDF viewer, page rendering, PDF click coordinate capture, preview scrolling, and ripple rendering.
- `src/preview/previewSyncController.ts`: forward sync scheduling, suppression, and duplicate request filtering.
- `src/compiler/lsp.ts`: Tinymist JSON-RPC bridge and preview/source-map task startup.
- `src/appController.ts`: preview lifecycle, render-cache mapping, forward sync, inverse sync, and developer logs.
- `src-tauri/src/render_prepare/`: optional render-cache generation and source-map mapping for prepared preview files.
