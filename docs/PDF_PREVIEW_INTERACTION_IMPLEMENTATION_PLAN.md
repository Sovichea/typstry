# PDF preview interaction implementation

## Objective

Typsastra's v1.0 preview contract prioritizes two interactions:

1. Gesture scrolling should keep producing readable pages as inertia slows.
2. Releasing the scrollbar thumb should render every visible page immediately and reliably.

Initial loading remains a lower priority. Four to seven seconds is acceptable for an unusually long document as long as ordinary documents open quickly and the application remains responsive.

## Qualified rendering path

Manual Windows/WebView2 A/B testing selected this PDF.js configuration:

```text
hardware acceleration: enabled
canvas ownership:      PDF.js direct canvas
embedded fonts:        browser FontFace
WebGPU:                disabled
draft surfaces:        disabled
```

FontFace rendering was materially faster than rebuilding embedded glyphs from PDF path primitives. Hardware acceleration and experimental WebGPU alone did not produce a meaningful improvement. Low-resolution draft pages were rejected because they were not readable and added memory and lifecycle complexity.

The selected path still requires repeated-refresh memory qualification on Windows, Linux, and macOS because browser font resources are managed outside the JavaScript heap.

## Runtime architecture

```text
PreviewFrame
|-- PreviewMotionController
|-- PreviewRenderScheduler
|-- PDF.js document and worker
|-- bounded final-canvas residency
`-- reference-counted page render ownership
```

`PreviewFrame` owns PDF.js and DOM operations. The motion controller and scheduler contain deterministic policy that can be tested without a WebView.

## Motion model

The controller records scroll position, velocity, acceleration, direction, and stable animation frames.

```ts
type PreviewMotionState = "idle" | "moving" | "settling";
type PreviewMotionPhase = "stationary" | "accelerating" | "cruising" | "decelerating";
```

Behavior:

```text
accelerating or cruising
  update the viewport destination
  remove obsolete queued work
  retain nearby completed canvases

sustained deceleration
  estimate the stopping offset
  resolve the projected destination page
  permit one speculative final render

first stable frame
  resolve every page intersecting the viewport
  queue the page with the greatest visible area first
  allow two final render lanes

confirmed idle
  confirm visible requests remain queued
  resume ordinary nearby-page observation
```

Direction reversal or renewed acceleration invalidates the projected destination immediately.

## Native scrollbar release

WebView scrollbars do not reliably deliver `pointerup` into the preview iframe. Rendering therefore cannot depend on pointer state.

- The first stable animation frame starts visible final rendering.
- Known pointer release permits idle after three stable frames.
- Six stable frames force idle when native pointer release was lost.
- Renewed movement returns to `moving` and invalidates stale queued pages.

This may render while a user holds the thumb stationary. That is acceptable: renewed dragging cancels distant work, while a stationary viewport becomes readable without waiting for an unreliable native event.

## Scheduling

Requests are deduplicated by PDF generation and page number.

Priority order:

```text
0  center or projected destination page
1  other viewport-intersecting pages
2  nearby observer pages
```

Concurrency is bounded:

```text
moving:              one render lane
settling or idle:    two render lanes
resident canvases:   seven maximum
```

Every new scroll position removes obsolete settled, projected, and observer requests before queuing current work. A settled request remains as a fallback when a speculative render of the same page is still unwinding.

## Render ownership and cancellation

PDF.js may return the same `PDFPageProxy` to overlapping cancelled and replacement renders. Calling `page.cleanup()` from the older render can invalidate resources used by its replacement.

Typsastra reference-counts render owners for each page proxy:

1. Retain the page when a render obtains it.
2. Cancel obsolete render tasks without cleaning the page immediately.
3. Release ownership only after the render promise settles.
4. Call `page.cleanup()` only when the final owner releases it.

Canvases are committed atomically. The previous valid canvas remains mounted until its replacement finishes. Stale generations and zoom keys never commit.

## Geometry and residency

- Initial page geometry is estimated from early pages so large documents can mount promptly.
- Exact geometry hydrates in yielding background batches.
- Viewport lookup uses ordered page slots and binary search instead of scanning the full document during interaction.
- At settle, all intersecting pages are discovered from the first visible slot and ordered by visible area.
- Eviction preserves at most seven final canvases nearest the current focus.

## Diagnostics

The runtime records:

```text
preview.motion-handler
preview.motion-settle
preview.deceleration-prerender
preview.destination-final-queue
preview.destination-final-commit
preview.render-cancel
preview.render-promote
preview.canvas-render
preview.annotation-layer
```

Developer diagnostics publish rolling p50, p95, and maximum values after every 20 timing samples.

## Release gates

| Contract | Target |
|---|---:|
| Motion handler p95 | under 8 ms |
| Final destination page p95 | under 500 ms |
| Active lanes during motion | 1 maximum |
| Active lanes after settle | 2 maximum |
| Resident final canvases | 7 maximum |
| Stale generation commit | never |
| Blank settled viewport after valid PDF load | never |

Manual qualification must cover:

- gesture acceleration, deceleration, reversal, and repeated short gestures;
- long scrollbar drags, half-page release, immediate re-grab, and lost native `pointerup`;
- viewports intersecting two pages;
- repeated zoom and fit-to-width changes;
- repeated PDF generations while scrolling;
- Windows/WebView2 and Linux/WebKitGTK, including Linux DMA-BUF compatibility mode;
- process, renderer, GPU, and font-resource memory after repeated preview replacement.

## Deferred work

The following remain non-blocking after v1.0:

- binary or range-based PDF transport instead of base64;
- true page-container DOM windowing;
- OffscreenCanvas/ImageBitmap rendering;
- alternative Rust GPU renderers;
- multiple workers for document-generation swapping;
- raster-heavy engineering-drawing optimization.
