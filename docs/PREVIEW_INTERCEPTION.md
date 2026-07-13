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

1. Typsastra maps the editor cursor to the source file that Tinymist sees. If Khmer render preparation is active, this may be a generated cache file.
2. Typsastra sends a `panelScrollTo` request to a Tinymist source-map preview task.
   If the exact cursor boundary is not mappable, it tries a bounded set of
   nearby Unicode code-point columns.
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

The preview setting `renderMode` controls refresh timing:

- `on-type`: compile after edits for live preview.
- `on-save`: compile only when files are saved.

Imported files preview through their configured main document. Independent standalone roots are disabled for v1.0 pending the `V1X-P.1` source-sync redesign.

PDF forward and inverse sync use one hidden Tinymist web-preview task solely for its source-map data plane. The task ID ends in `-source-map`; Typsastra serializes concurrent startup requests and calls `tinymist.doKillPreview` before replacing a stale task. Do not start a normal-task fallback: Tinymist can reject a second registration against the same compiler instance with `cannot register preview to the compiler instance`.

## Security boundaries

Preview helper commands remain narrow:

- Preview file mirroring only writes under Typsastra's workspace-local render cache.
- Source-map communication uses Tinymist preview tasks and loopback WebSocket URLs.
- External preview resources are not exposed as a general-purpose network proxy.

## Debug logs that indicate success

With developer mode enabled, healthy source-map sync should show logs like:

```text
Starting hidden Tinymist source-map session: root=...; task=...
Tinymist data-plane connected: ws://127.0.0.1:<port>/.
Requested compiler preview position: <file>:<line>:<column>.
Compiler document position: candidates=1, page=<n>, x=<x>, y=<y>.
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
