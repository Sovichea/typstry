export type PreviewClickPoint = {
  pageNo?: number;
  documentPosition?: { page_no: number; x: number; y: number };
};

export type PreviewInteractionStatus = {
  kind: "installed" | "blocked" | "debug";
  url: string;
  reason?: string;
};

export type PreviewMemorySnapshot = {
  pdfGeneration: number;
  pdfBytes: number;
  pdfPages: number;
  residentCanvases: number;
  residentFinalCanvases: number;
  canvasPixels: number;
  fontFaces: number;
  activeRenders: number;
  loading: boolean;
};

import { PERFORMANCE_BUDGETS, type PerformanceMetric } from "../performance/diagnostics";
import { pageDimensionsChanged, pagesToEvict, visiblePageIndexes } from "./virtualization";
import { PreviewMotionController } from "./previewMotion";
import {
  PreviewRenderScheduler,
  type PreviewRenderReason,
  type PreviewRenderRequest
} from "./previewRenderScheduler";
import {
  PreviewPageRenderOwnership,
  type CleanablePdfPage
} from "./previewPageRenderOwnership";
import {
  TYPSASTRA_GREEN,
  TYPSASTRA_GREEN_RIPPLE_FILL,
  TYPSASTRA_GREEN_RIPPLE_SHADOW
} from "../ui/brandColors";

type PdfJsModule = typeof import("pdfjs-dist");

type PageDimensions = {
  width: number;
  height: number;
};

type ScrollAnchor = {
  pageNo: number;
  offset: number;
};

type ActivePageRender = {
  generation: number;
  renderKey: string;
  task: { cancel(): void } | null;
  page: CleanablePdfPage | null;
  canvas: HTMLCanvasElement | null;
  canvasCommitted: boolean;
};

const ZOOM_LEVELS = [25, 33, 50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200, 250, 300, 400, 500];
const FALLBACK_ZOOM_PERCENT = 90;
const MAX_OUTPUT_SCALE = 2;
// The viewer has 20px padding on each side. Keep an additional gutter for the
// vertical scrollbar and fractional layout rounding so fit mode never overflows.
const FIT_PADDING_PX = 56;

export class PreviewFrame {
  private iframe: HTMLIFrameElement | null = null;
  private messageHost: HTMLDivElement | null = null;
  private errorOverlay: HTMLDivElement | null = null;
  private mountedUrl = "";
  private previewZoomPercent = FALLBACK_ZOOM_PERCENT;
  private isFitToWidth = true;
  private resizeObserver: ResizeObserver | null = null;
  private resizeLayoutSuspended = false;
  private resizeLayoutPending = false;
  private resizeScrollAnchor: ScrollAnchor | null = null;
  private lastInteractionStatusKey = "";
  private pdfJsPromise: Promise<PdfJsModule> | null = null;
  private pdfWorker: { destroyed?: boolean; destroy(): void } | null = null;
  private pdfLoadingTask: { destroy(): Promise<void> } | null = null;
  private pendingPdfLoadingTask: { destroy(): Promise<void> } | null = null;
  private pdfDoc: any = null;
  private observer: IntersectionObserver | null = null;
  private pageDimensions = new Map<number, PageDimensions>();
  private pageSlots: HTMLElement[] = [];
  private activeRenders = new Map<number, ActivePageRender>();
  private readonly pageRenderOwnership = new PreviewPageRenderOwnership<CleanablePdfPage>();
  private readonly renderScheduler = new PreviewRenderScheduler();
  private readonly motion = new PreviewMotionController();
  private renderDispatching = false;
  private activeRenderLanes = 0;
  private motionFrame: number | null = null;
  private motionDestinationPage = 1;
  private motionStartedAt: number | null = null;
  private finalDecisionAt: number | null = null;
  private pdfGeneration = 0;
  private currentPdfBytes = 0;
  private firstRenderedGeneration = 0;
  private forwardRippleGeneration = 0;
  private zoomStartedAt: number | null = null;

  constructor(
    private readonly pane: HTMLElement,
    private readonly onPreviewClick: (point: PreviewClickPoint) => void,
    private readonly onInteractionStatus?: (status: PreviewInteractionStatus) => void,
    private readonly onZoomChanged?: (zoomPercent: number) => void,
    private readonly onPerformance?: (metric: Omit<PerformanceMetric, "recordedAt">) => void
  ) {
    this.pane.addEventListener("wheel", event => {
      if (event.ctrlKey) {
        event.preventDefault();
        if (event.deltaY < 0) {
          this.zoomIn();
        } else {
          this.zoomOut();
        }
      }
    }, { passive: false });

    this.resizeObserver = new ResizeObserver(() => {
      if (this.resizeLayoutSuspended) {
        this.resizeLayoutPending = true;
        return;
      }
      if (!this.isFitToWidth || !this.pdfDoc) return;
      this.applyFitToWidth();
    });
    this.resizeObserver.observe(this.pane);
  }

  public get element(): HTMLIFrameElement | null {
    return this.iframe;
  }

  public get currentUrl(): string {
    return this.mountedUrl;
  }

  public get currentZoomPercent(): number {
    return this.previewZoomPercent;
  }

  public get isFitMode(): boolean {
    return this.isFitToWidth;
  }

  public syncTheme(): void {
    const root = this.iframe?.contentDocument?.documentElement;
    if (!root) return;
    const hostStyle = getComputedStyle(document.documentElement);
    const copy = (source: string, target: string, fallback: string) => {
      root.style.setProperty(target, hostStyle.getPropertyValue(source).trim() || fallback);
    };
    copy("--ui-bg", "--preview-ui-bg", "#fcfcfc");
    copy("--ui-header-text", "--preview-ui-header", "#616161");
    copy("--ui-accent-color", "--preview-ui-accent", TYPSASTRA_GREEN);
  }

  public suspendResizeLayout(): void {
    // Capture before the pane width changes. Capturing after the resize has
    // started can anchor against an already reflowed page and visibly jump.
    this.resizeScrollAnchor = this.captureScrollAnchor();
    this.resizeLayoutSuspended = true;
    this.resizeLayoutPending = false;
  }

  public resumeResizeLayout(): void {
    if (!this.resizeLayoutSuspended) return;
    this.resizeLayoutSuspended = false;
    const shouldApplyFinalFit = this.resizeLayoutPending;
    this.resizeLayoutPending = false;
    const anchor = this.resizeScrollAnchor;
    this.resizeScrollAnchor = null;
    // ResizeObserver may deliver its final notification after pointerup. Apply
    // the final fit ourselves and restore the pre-resize viewport anchor.
    if ((shouldApplyFinalFit || anchor) && this.isFitToWidth && this.pdfDoc) {
      this.applyFitToWidth(anchor);
    }
  }

  public zoomIn(): number {
    this.isFitToWidth = false;
    return this.setZoom(ZOOM_LEVELS.find(level => level > this.previewZoomPercent) ?? this.previewZoomPercent);
  }

  public memorySnapshot(): PreviewMemorySnapshot {
    const iframeDoc = this.iframe?.contentDocument;
    const canvases = [...(iframeDoc?.querySelectorAll<HTMLCanvasElement>("canvas") ?? [])];
    const fontFaces = iframeDoc?.fonts
      ? [...(iframeDoc.fonts as unknown as Iterable<FontFace>)].length
      : 0;
    return {
      pdfGeneration: this.pdfGeneration,
      pdfBytes: this.currentPdfBytes,
      pdfPages: Number(this.pdfDoc?.numPages ?? 0),
      residentCanvases: canvases.length,
      residentFinalCanvases: iframeDoc?.querySelectorAll(".pdf-page-canvas").length ?? 0,
      canvasPixels: canvases.reduce((total, canvas) => total + canvas.width * canvas.height, 0),
      fontFaces,
      activeRenders: this.activeRenders.size,
      loading: this.pendingPdfLoadingTask !== null
    };
  }

  public zoomOut(): number {
    this.isFitToWidth = false;
    return this.setZoom([...ZOOM_LEVELS].reverse().find(level => level < this.previewZoomPercent) ?? this.previewZoomPercent);
  }

  public zoomToFit(): void {
    this.isFitToWidth = true;
    this.updateHorizontalOverflow();
    this.applyFitToWidth();
  }

  private computeFitToWidthPercent(): number {
    const paneWidth = this.pane.clientWidth;
    if (paneWidth <= 0) return FALLBACK_ZOOM_PERCENT;
    let maxPageWidth = 0;
    for (const dims of this.pageDimensions.values()) {
      if (dims.width > maxPageWidth) maxPageWidth = dims.width;
    }
    if (maxPageWidth <= 0) return FALLBACK_ZOOM_PERCENT;
    const availableWidth = paneWidth - FIT_PADDING_PX;
    return Math.max(10, Math.floor((availableWidth / maxPageWidth) * 100));
  }

  private applyFitToWidth(anchor?: ScrollAnchor | null): void {
    const percent = this.computeFitToWidthPercent();
    if (percent === this.previewZoomPercent) {
      if (anchor) this.restoreScrollAnchor(anchor, true);
      return;
    }
    this.setZoom(percent, anchor);
  }

  private setZoom(percent: number, preservedAnchor?: ScrollAnchor | null): number {
    this.updateHorizontalOverflow();
    if (percent === this.previewZoomPercent) return percent;
    this.zoomStartedAt = performance.now();
    const anchor = preservedAnchor ?? this.captureScrollAnchor();
    this.previewZoomPercent = percent;
    this.onZoomChanged?.(percent);
    this.cancelAllPageRenders();
    this.layoutPageSlots({ preserveExistingPages: true });
    this.restoreScrollAnchor(anchor);
    requestAnimationFrame(() => this.renderVisiblePages());
    return percent;
  }

  private updateHorizontalOverflow(): void {
    const doc = this.iframe?.contentDocument;
    if (!doc?.body) return;
    doc.body.style.overflowX = this.isFitToWidth ? "hidden" : "auto";
    doc.body.style.overscrollBehaviorX = this.isFitToWidth ? "none" : "auto";
    if (this.isFitToWidth) {
      doc.body.scrollLeft = 0;
      doc.documentElement.scrollLeft = 0;
    }
  }

  public async loadPdfData(base64Data: string, identity = "compiler-pdf"): Promise<void> {
    const startedAt = performance.now();
    const generation = ++this.pdfGeneration;
    const obsoleteLoadingTask = this.pendingPdfLoadingTask;
    this.pendingPdfLoadingTask = null;
    if (obsoleteLoadingTask) void obsoleteLoadingTask.destroy().catch(() => {});
    const previousScroll = this.captureScrollAnchor();
    this.clearErrorOverlay();
    this.clearMessageHost();

    const iframe = await this.ensureIframe();
    if (generation !== this.pdfGeneration) return;
    const iframeDoc = iframe.contentDocument;
    if (!iframeDoc) throw new Error("PDF preview document is unavailable.");

    let nextPdfDoc: any = null;
    let nextLoadingTask: { destroy(): Promise<void> } | null = null;
    try {
      const pdfjs = await this.pdfJs();
      if (generation !== this.pdfGeneration) return;
      if (!this.pdfWorker || this.pdfWorker.destroyed) {
        this.pdfWorker = pdfjs.PDFWorker.create({ name: "typsastra-preview" });
      }
      const bytes = decodeBase64(base64Data);
      const loadingTask = pdfjs.getDocument({
        data: bytes,
        worker: this.pdfWorker as InstanceType<typeof pdfjs.PDFWorker>,
        ownerDocument: iframeDoc,
        // Browser FontFace rendering is substantially faster than rebuilding
        // every embedded glyph from PDF path primitives. Page and document
        // disposal below bound the lifetime of these resources.
        disableFontFace: false,
        useSystemFonts: false,
        enableHWA: true,
        cMapUrl: "/cmaps/",
        cMapPacked: true,
        standardFontDataUrl: "/standard_fonts/"
      });
      nextLoadingTask = loadingTask as unknown as { destroy(): Promise<void> };
      this.pendingPdfLoadingTask = nextLoadingTask;
      const pdfDoc = await loadingTask.promise;
      nextPdfDoc = pdfDoc;
      if (generation !== this.pdfGeneration) {
        await (pdfDoc as any).destroy();
        return;
      }
      const nextDimensions = await readInitialPdfPageDimensions(pdfDoc);
      if (generation !== this.pdfGeneration) {
        await (pdfDoc as any).destroy();
        return;
      }

      const oldPdfDoc = this.pdfDoc;
      const oldLoadingTask = this.pdfLoadingTask;
      this.observer?.disconnect();
      this.observer = null;
      this.cancelAllPageRenders();
      nextPdfDoc = null;
      this.pdfDoc = pdfDoc;
      this.pdfLoadingTask = nextLoadingTask;
      nextLoadingTask = null;
      this.pendingPdfLoadingTask = null;
      this.pageDimensions = nextDimensions;
      this.currentPdfBytes = bytes.byteLength;
      this.mountedUrl = identity;
      if (this.isFitToWidth) this.previewZoomPercent = this.computeFitToWidthPercent();
      this.createPageSlots(iframeDoc, true);
      this.updateHorizontalOverflow();
      this.setupIframeInteractions();
      this.installPageObserver(iframe);
      this.restoreScrollAnchor(previousScroll);
      void this.hydratePageDimensions(pdfDoc, generation).catch(error => {
        if (generation === this.pdfGeneration && this.pdfDoc === pdfDoc) {
          console.warn("Failed to finish PDF page geometry discovery:", error);
        }
      });
      this.reportInteractionStatus({ kind: "installed", url: identity });
      this.onPerformance?.({
        name: "preview.load",
        milliseconds: performance.now() - startedAt,
        detail: { pageCount: pdfDoc.numPages, pdfBytes: bytes.byteLength }
      });
      // The old page remains visible while the replacement is prepared, then
      // release its document resources before this generation completes. The
      // worker itself is shared and remains available for the next refresh.
      await cleanupPdfResources(oldPdfDoc, oldLoadingTask);
    } catch (error) {
      if (generation !== this.pdfGeneration) return;
      this.setError("PDF Loading Failed", String(error));
    } finally {
      if (this.pendingPdfLoadingTask === nextLoadingTask) this.pendingPdfLoadingTask = null;
      if (nextPdfDoc) {
        try { await nextPdfDoc.destroy(); } catch {}
      } else if (nextLoadingTask) {
        try { await nextLoadingTask.destroy(); } catch {}
      }
    }
  }

  private async pdfJs(): Promise<PdfJsModule> {
    if (!this.pdfJsPromise) {
      this.pdfJsPromise = Promise.all([
        import("pdfjs-dist"),
        import("pdfjs-dist/build/pdf.worker.min.mjs?url")
      ]).then(([pdfjs, worker]) => {
        pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
        return pdfjs;
      });
    }
    return this.pdfJsPromise;
  }

  private async ensureIframe(): Promise<HTMLIFrameElement> {
    if (this.iframe?.contentDocument?.getElementById("viewer-container")) return this.iframe;
    if (this.iframe) {
      releaseCanvasResources(this.iframe.contentDocument?.documentElement ?? null);
      this.iframe.remove();
      this.pageSlots = [];
    }
    const iframe = document.createElement("iframe");
    iframe.className = "preview-frame";
    iframe.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><style>
      :root{--preview-ui-bg:#fcfcfc;--preview-ui-header:#616161;--preview-ui-accent:${TYPSASTRA_GREEN};--scrollbar-track:transparent;--scrollbar-thumb:color-mix(in srgb,var(--preview-ui-header) 62%,var(--preview-ui-bg));--scrollbar-hover:color-mix(in srgb,var(--preview-ui-accent) 72%,var(--preview-ui-header))}
      @supports not selector(::-webkit-scrollbar){html,body{scrollbar-color:var(--scrollbar-thumb) var(--scrollbar-track);scrollbar-width:auto}}
      body::-webkit-scrollbar{width:15px;height:15px}
      body::-webkit-scrollbar-track{background:transparent}
      body::-webkit-scrollbar-thumb{min-width:32px;min-height:32px;background:var(--scrollbar-thumb);background-clip:padding-box;border:1px solid transparent;border-radius:0}
      body::-webkit-scrollbar-thumb:hover,body::-webkit-scrollbar-thumb:active{background:var(--scrollbar-hover);background-clip:padding-box}
      body::-webkit-scrollbar-corner{background:transparent}
      body::-webkit-scrollbar-button{display:none;width:0;height:0}
      html,body{margin:0;width:100%;height:100%;background:transparent}
      body{overflow:auto;font-family:sans-serif}
      #viewer-container{box-sizing:border-box;min-width:100%;width:max-content;padding:20px;display:flex;flex-direction:column;gap:20px}
      .pdf-page-container{position:relative;box-sizing:border-box;flex:none;margin:0 auto;background:#fff;box-shadow:0 2px 10px rgba(0,0,0,.25);overflow:hidden}
      .pdf-page-canvas{position:absolute;inset:0;display:block;width:100%;height:100%}
      .forward-sync-ripple{position:fixed;z-index:2147483647;box-sizing:border-box;width:18px;height:18px;margin:-9px 0 0 -9px;border:2px solid ${TYPSASTRA_GREEN};border-radius:999px;background:${TYPSASTRA_GREEN_RIPPLE_FILL};box-shadow:0 0 0 0 ${TYPSASTRA_GREEN_RIPPLE_SHADOW};pointer-events:none;animation:typsastra-forward-ripple 900ms ease-out forwards}
      @keyframes typsastra-forward-ripple{0%{opacity:0;transform:scale(.55);box-shadow:0 0 0 0 rgba(61,180,137,.38)}12%{opacity:1}100%{opacity:0;transform:scale(3.1);box-shadow:0 0 0 14px rgba(61,180,137,0)}}
      .annotation-link{position:absolute;display:block}
      ::selection{background:rgba(0,120,215,.35)}
    </style></head><body><div id="viewer-container"></div></body></html>`;
    iframe.addEventListener("load", () => this.setupIframeInteractions());
    const loaded = new Promise<void>(resolve => iframe.addEventListener("load", () => resolve(), { once: true }));
    this.pane.appendChild(iframe);
    this.iframe = iframe;
    await loaded;
    this.updateHorizontalOverflow();
    this.setupIframeInteractions();
    return iframe;
  }

  private createPageSlots(doc: Document, preserveExistingPages = false): void {
    const viewer = doc.getElementById("viewer-container");
    if (!viewer || !this.pdfDoc) return;
    if (!preserveExistingPages) {
      replaceElementChildren(viewer);
    }
    for (let pageNo = 1; pageNo <= this.pdfDoc.numPages; pageNo += 1) {
      let slot = viewer.querySelector<HTMLElement>(`:scope > .pdf-page-container[data-page-no="${pageNo}"]`);
      if (!slot) {
        slot = doc.createElement("div");
        slot.className = "pdf-page-container";
        slot.dataset.pageNo = String(pageNo);
        viewer.appendChild(slot);
      }
    }
    for (const slot of [...viewer.querySelectorAll<HTMLElement>(":scope > .pdf-page-container")]) {
      const pageNo = Number(slot.dataset.pageNo);
      if (pageNo > this.pdfDoc.numPages) {
        releaseCanvasResources(slot);
        slot.remove();
      }
    }
    this.pageSlots = [...viewer.querySelectorAll<HTMLElement>(":scope > .pdf-page-container")];
    this.layoutPageSlots({ preserveExistingPages });
  }

  private layoutPageSlots(options: { preserveExistingPages?: boolean } = {}): void {
    const doc = this.iframe?.contentDocument;
    if (!doc) return;
    const zoom = this.previewZoomPercent / 100;
    for (const slot of doc.querySelectorAll<HTMLElement>(".pdf-page-container")) {
      const pageNo = Number(slot.dataset.pageNo);
      const dimensions = this.pageDimensions.get(pageNo);
      if (!dimensions) continue;
      slot.style.width = `${dimensions.width * zoom}px`;
      slot.style.height = `${dimensions.height * zoom}px`;
      if (!options.preserveExistingPages) {
        replaceElementChildren(slot);
        delete slot.dataset.renderKey;
      }
    }
  }

  private async hydratePageDimensions(pdfDoc: any, generation: number): Promise<void> {
    const startedAt = performance.now();
    let widerPageFound = false;
    const initialMaxWidth = [...this.pageDimensions.values()]
      .reduce((maximum, dimensions) => Math.max(maximum, dimensions.width), 0);
    for (let pageNo = 2; pageNo <= pdfDoc.numPages; pageNo += 1) {
      await this.waitForScrollingToStop(pdfDoc, generation);
      if (generation !== this.pdfGeneration || this.pdfDoc !== pdfDoc) return;
      const page = await pdfDoc.getPage(pageNo);
      if (generation !== this.pdfGeneration || this.pdfDoc !== pdfDoc) {
        page.cleanup();
        return;
      }
      const viewport = page.getViewport({ scale: 1 });
      const dimensions = { width: viewport.width, height: viewport.height };
      const previous = this.pageDimensions.get(pageNo);
      if (pageDimensionsChanged(previous, dimensions)) {
        this.pageDimensions.set(pageNo, dimensions);
        this.updatePageSlotDimensions(pageNo, dimensions);
        widerPageFound ||= dimensions.width > initialMaxWidth;
      }
      if (!this.activeRenders.has(pageNo)) page.cleanup();
      if (pageNo % 8 === 0) {
        await nextTurn();
        await this.waitForScrollingToStop(pdfDoc, generation);
      }
    }
    if (generation !== this.pdfGeneration || this.pdfDoc !== pdfDoc) return;
    if (widerPageFound && this.isFitToWidth) this.applyFitToWidth();
    this.onPerformance?.({
      name: "preview.geometry",
      milliseconds: performance.now() - startedAt,
      detail: { pageCount: pdfDoc.numPages }
    });
  }

  private async waitForScrollingToStop(pdfDoc: any, generation: number): Promise<void> {
    while (this.motion.current().state !== "idle" && generation === this.pdfGeneration && this.pdfDoc === pdfDoc) {
      await delay(16);
    }
  }

  private updatePageSlotDimensions(pageNo: number, dimensions: PageDimensions): void {
    const slot = this.iframe?.contentDocument
      ?.querySelector<HTMLElement>(`.pdf-page-container[data-page-no="${pageNo}"]`);
    if (!slot) return;
    const zoom = this.previewZoomPercent / 100;
    slot.style.width = `${dimensions.width * zoom}px`;
    slot.style.height = `${dimensions.height * zoom}px`;
  }

  private installPageObserver(iframe: HTMLIFrameElement): void {
    this.observer?.disconnect();
    const doc = iframe.contentDocument;
    const Observer = (iframe.contentWindow as unknown as { IntersectionObserver: typeof IntersectionObserver }).IntersectionObserver;
    if (!doc || !Observer) return;
    this.observer = new Observer(entries => {
      for (const entry of entries) {
        const pageNo = Number((entry.target as HTMLElement).dataset.pageNo);
        if (entry.isIntersecting) this.queuePageRender(pageNo, 2, "directional-neighbor");
      }
    }, { root: null, rootMargin: "1000px 0px 1000px 0px", threshold: 0 });
    this.pageSlots.forEach(slot => this.observer?.observe(slot));
  }

  private renderVisiblePages(): void {
    const doc = this.iframe?.contentDocument;
    if (!doc) return;
    const viewportHeight = this.iframe?.clientHeight ?? 0;
    for (const slot of doc.querySelectorAll<HTMLElement>(".pdf-page-container")) {
      const rect = slot.getBoundingClientRect();
      if (rect.bottom >= -1000 && rect.top <= viewportHeight + 1000) {
        this.queuePageRender(Number(slot.dataset.pageNo), 2, "directional-neighbor");
      }
    }
  }

  private queuePageRender(
    pageNo: number,
    priority = 2,
    reason: PreviewRenderReason = "directional-neighbor"
  ): void {
    if (!Number.isFinite(pageNo) || pageNo < 1 || pageNo > Number(this.pdfDoc?.numPages ?? 0)) return;
    const slot = this.iframe?.contentDocument
      ?.querySelector<HTMLElement>(`.pdf-page-container[data-page-no="${pageNo}"]`);
    if (!slot) return;
    if (slot.dataset.renderKey === this.currentPageRenderKey(this.pdfGeneration)) return;
    if (this.activeRenders.has(pageNo) && reason !== "settled-visible") return;
    const result = this.renderScheduler.enqueue({
      generation: this.pdfGeneration,
      pageNo,
      priority,
      reason
    });
    if (result === "promoted") this.recordEvent("preview.render-promote", { pageNo });
    const motion = this.motion.current();
    if (motion.state !== "moving" || reason === "decelerating-destination") {
      void this.pumpPageRenderQueue();
    }
  }

  private pumpPageRenderQueue(): void {
    if (this.renderDispatching) return;
    this.renderDispatching = true;
    try {
      while (this.activeRenderLanes < this.renderLaneLimit() && this.renderScheduler.size > 0) {
        const motion = this.motion.current();
        const request = this.renderScheduler.take(candidate => {
          if (this.activeRenders.has(candidate.pageNo)) return false;
          if (motion.state === "moving") {
            return motion.shouldPreRender && candidate.reason === "decelerating-destination";
          }
          return motion.state !== "settling"
            || candidate.reason === "decelerating-destination"
            || candidate.reason === "settled-visible";
        });
        if (!request) break;
        this.activeRenderLanes += 1;
        void this.renderPage(request).finally(() => {
          this.activeRenderLanes = Math.max(0, this.activeRenderLanes - 1);
          void nextTurn().then(() => this.pumpPageRenderQueue());
        });
      }
    } finally {
      this.renderDispatching = false;
    }
  }

  private renderLaneLimit(): number {
    return this.motion.current().state === "moving" ? 1 : 2;
  }

  private deferPageRenderingDuringScroll(): void {
    const startedAt = performance.now();
    const view = this.iframe?.contentWindow;
    if (!view) return;
    const wasIdle = this.motion.current().state === "idle";
    const snapshot = this.motion.noteScroll(view.scrollY, startedAt);
    if (wasIdle) {
      this.motionStartedAt = startedAt;
      this.finalDecisionAt = null;
    }
    this.renderScheduler.removeReason("decelerating-destination");
    this.renderScheduler.removeReason("settled-visible");
    this.renderScheduler.removeReason("directional-neighbor");
    const visiblePage = this.visiblePageNumber();
    this.motionDestinationPage = snapshot.shouldPreRender
      ? this.pageNumberAtScrollTop(snapshot.projectedScrollTop)
      : visiblePage;
    this.cancelDistantPageRenders(this.motionDestinationPage, 2);
    if (snapshot.shouldPreRender) {
      this.recordEvent("preview.deceleration-prerender", {
        visiblePage,
        projectedPage: this.motionDestinationPage,
        velocity: Math.round(snapshot.velocity * 1000) / 1000,
        acceleration: Math.round(snapshot.acceleration * 10000) / 10000,
        samples: snapshot.deceleratingSamples
      });
      this.queuePageRender(this.motionDestinationPage, 0, "decelerating-destination");
    }
    if (this.motionFrame === null) this.motionFrame = requestAnimationFrame(timestamp => this.samplePreviewMotion(timestamp));
    this.recordMetric("preview.motion-handler", performance.now() - startedAt, {
      pageNo: this.motionDestinationPage,
      velocity: Math.round(snapshot.velocity * 1000) / 1000
    });
  }

  private samplePreviewMotion(timestamp: number): void {
    this.motionFrame = null;
    const view = this.iframe?.contentWindow;
    if (!view) return;
    const snapshot = this.motion.sampleFrame(view.scrollY, timestamp);
    this.motionDestinationPage = snapshot.shouldPreRender
      ? this.pageNumberAtScrollTop(snapshot.projectedScrollTop)
      : this.visiblePageNumber();
    if (snapshot.firstStableFrame) {
      const settledAt = performance.now();
      if (this.motionStartedAt !== null) {
        this.recordMetric("preview.motion-settle", settledAt - this.motionStartedAt, {
          pageNo: this.motionDestinationPage
        });
      }
      const destinationAlreadyFinal = this.iframe?.contentDocument
        ?.querySelector<HTMLElement>(`.pdf-page-container[data-page-no="${this.motionDestinationPage}"]`)
        ?.dataset.renderKey === this.currentPageRenderKey(this.pdfGeneration);
      this.finalDecisionAt = destinationAlreadyFinal ? null : settledAt;
      this.queueViewportFinalRenders("first-stable");
    }
    if (snapshot.becameIdle) {
      this.queueViewportFinalRenders("idle-confirmation");
      this.motionStartedAt = null;
      void this.pumpPageRenderQueue();
      return;
    }
    this.motionFrame = requestAnimationFrame(nextTimestamp => this.samplePreviewMotion(nextTimestamp));
  }

  private queueViewportFinalRenders(trigger: "first-stable" | "idle-confirmation"): void {
    const visiblePages = this.viewportPageNumbers();
    this.recordEvent("preview.destination-final-queue", {
      pageNo: this.motionDestinationPage,
      visiblePages: visiblePages.length,
      trigger
    });
    for (const pageNo of visiblePages) {
      this.queuePageRender(
        pageNo,
        pageNo === this.motionDestinationPage ? 0 : 1,
        "settled-visible"
      );
    }
  }

  private visiblePageNumber(): number {
    return this.pageNumberAtScrollTop(this.iframe?.contentWindow?.scrollY ?? 0);
  }

  private pageNumberAtScrollTop(scrollTop: number): number {
    if (this.pageSlots.length === 0) return 1;
    const view = this.iframe?.contentWindow;
    const target = scrollTop + (view?.innerHeight ?? this.iframe?.clientHeight ?? 0) / 2;
    let low = 0;
    let high = this.pageSlots.length - 1;
    while (low <= high) {
      const middle = (low + high) >>> 1;
      const slot = this.pageSlots[middle];
      const top = slot.offsetTop;
      const bottom = top + slot.offsetHeight;
      if (target < top) high = middle - 1;
      else if (target > bottom) low = middle + 1;
      else return Number(slot.dataset.pageNo) || middle + 1;
    }
    const candidates = [high, low]
      .filter(index => index >= 0 && index < this.pageSlots.length)
      .map(index => {
        const slot = this.pageSlots[index];
        return {
          pageNo: Number(slot.dataset.pageNo) || index + 1,
          distance: Math.abs(slot.offsetTop + slot.offsetHeight / 2 - target)
        };
      })
      .sort((left, right) => left.distance - right.distance);
    return candidates[0]?.pageNo ?? 1;
  }

  private viewportPageNumbers(): number[] {
    if (this.pageSlots.length === 0) return [];
    const view = this.iframe?.contentWindow;
    const viewportTop = view?.scrollY ?? 0;
    const viewportHeight = view?.innerHeight ?? this.iframe?.clientHeight ?? 0;
    return visiblePageIndexes(
      this.pageSlots.length,
      index => this.pageSlots[index].offsetTop,
      index => this.pageSlots[index].offsetHeight,
      viewportTop,
      viewportHeight
    ).map(index => Number(this.pageSlots[index].dataset.pageNo) || index + 1);
  }

  private async renderPage(request: PreviewRenderRequest): Promise<void> {
    const { pageNo, generation } = request;
    if (!this.pdfDoc || generation !== this.pdfGeneration || this.activeRenders.has(pageNo)) return;
    const doc = this.iframe?.contentDocument;
    const slot = doc?.querySelector<HTMLElement>(`.pdf-page-container[data-page-no="${pageNo}"]`);
    if (!doc || !slot) return;
    const renderKey = this.currentPageRenderKey(generation);
    if (slot.dataset.renderKey === renderKey) return;

    const active: ActivePageRender = {
      generation,
      renderKey,
      task: null,
      page: null,
      canvas: null,
      canvasCommitted: false
    };
    const startedAt = performance.now();
    this.activeRenders.set(pageNo, active);
    try {
      const page = await this.pdfDoc.getPage(pageNo);
      active.page = page;
      this.pageRenderOwnership.retain(page);
      if (!this.renderIsCurrent(pageNo, active, slot)) return;

      const cssScale = this.previewZoomPercent / 100;
      const cssViewport = page.getViewport({ scale: cssScale });
      const outputScale = Math.min(window.devicePixelRatio || 1, MAX_OUTPUT_SCALE);
      const renderViewport = page.getViewport({ scale: cssScale * outputScale });
      const canvas = doc.createElement("canvas");
      active.canvas = canvas;
      canvas.className = "pdf-page-canvas";
      canvas.width = Math.max(1, Math.floor(renderViewport.width));
      canvas.height = Math.max(1, Math.floor(renderViewport.height));

      const task = page.render({ canvas, viewport: renderViewport });
      active.task = task;
      const canvasStartedAt = performance.now();
      await task.promise;
      active.task = null;
      if (!this.renderIsCurrent(pageNo, active, slot)) return;
      this.onPerformance?.({
        name: "preview.canvas-render",
        milliseconds: performance.now() - canvasStartedAt,
        detail: { pageNo, zoomPercent: this.previewZoomPercent }
      });
      this.commitFinalCanvas(slot, canvas);
      active.canvasCommitted = true;
      slot.dataset.renderKey = renderKey;

      const annotationStartedAt = performance.now();
      const annotationLinks = await this.renderAnnotationLinks(page, cssViewport, doc);
      if (!this.renderIsCurrent(pageNo, active, slot)) return;
      this.onPerformance?.({
        name: "preview.annotation-layer",
        milliseconds: performance.now() - annotationStartedAt,
        detail: { pageNo, linkCount: annotationLinks.length }
      });

      this.commitFinalCanvas(slot, canvas, annotationLinks);
      slot.dataset.renderKey = renderKey;
      this.trimResidentPages(pageNo);
      if (pageNo === this.motionDestinationPage && this.finalDecisionAt !== null) {
        this.recordMetric("preview.destination-final-commit", performance.now() - this.finalDecisionAt, { pageNo });
        this.finalDecisionAt = null;
      }
      const isFirstRenderedPage = this.firstRenderedGeneration !== generation;
      if (isFirstRenderedPage) this.firstRenderedGeneration = generation;
      this.onPerformance?.({
        name: isFirstRenderedPage ? "preview.first-page" : "preview.page-render",
        milliseconds: performance.now() - startedAt,
        detail: { pageNo, zoomPercent: this.previewZoomPercent, residentPages: this.renderedPageNumbers().length }
      });
      if (this.zoomStartedAt !== null) {
        this.onPerformance?.({
          name: "preview.zoom",
          milliseconds: performance.now() - this.zoomStartedAt,
          detail: { zoomPercent: this.previewZoomPercent, pageNo }
        });
        this.zoomStartedAt = null;
      }
    } catch (error) {
      if (!(error instanceof Error && error.name === "RenderingCancelledException")) {
        console.error(`Failed to render PDF page ${pageNo}:`, error);
      }
    } finally {
      if (this.activeRenders.get(pageNo) === active) this.activeRenders.delete(pageNo);
      if (active.page) this.pageRenderOwnership.release(active.page);
      if (active.canvas && !active.canvasCommitted) releaseCanvas(active.canvas);
    }
  }

  private async renderAnnotationLinks(page: any, viewport: any, doc: Document): Promise<HTMLElement[]> {
    if (typeof page?.getAnnotations !== "function") return [];
    try {
      const annotationLinks: HTMLElement[] = [];
      for (const annotation of await page.getAnnotations()) {
        if (annotation.subtype !== "Link" || !annotation.url) continue;
        const rect = viewportRectangle(viewport, annotation.rect);
        if (!rect) continue;
        const link = doc.createElement("a");
        link.className = "annotation-link";
        link.href = annotation.url;
        link.style.left = `${Math.min(rect[0], rect[2])}px`;
        link.style.top = `${Math.min(rect[1], rect[3])}px`;
        link.style.width = `${Math.abs(rect[2] - rect[0])}px`;
        link.style.height = `${Math.abs(rect[3] - rect[1])}px`;
        annotationLinks.push(link);
      }
      return annotationLinks;
    } catch (error) {
      console.warn("Failed to render PDF annotation links:", error);
      return [];
    }
  }

  private renderIsCurrent(pageNo: number, active: ActivePageRender, slot: HTMLElement): boolean {
    return active.generation === this.pdfGeneration
      && active.renderKey === this.currentPageRenderKey(active.generation)
      && this.activeRenders.get(pageNo) === active
      && slot.isConnected;
  }

  private currentPageRenderKey(generation: number): string {
    const outputScale = Math.min(window.devicePixelRatio || 1, MAX_OUTPUT_SCALE);
    return `${generation}:${this.previewZoomPercent}:${outputScale}`;
  }

  private commitFinalCanvas(slot: HTMLElement, canvas: HTMLCanvasElement, annotations: HTMLElement[] = []): void {
    for (const child of [...slot.children]) {
      if (child === canvas) continue;
      releaseCanvasResources(child);
      child.remove();
    }
    if (!canvas.isConnected) slot.append(canvas);
    for (const annotation of annotations) slot.append(annotation);
  }

  private releaseFinalPage(pageNo: number): void {
    this.renderScheduler.remove(this.pdfGeneration, pageNo);
    const active = this.activeRenders.get(pageNo);
    if (active) {
      active.task?.cancel();
      this.recordEvent("preview.render-cancel", { pageNo });
      this.activeRenders.delete(pageNo);
    }
    const slot = this.iframe?.contentDocument
      ?.querySelector<HTMLElement>(`.pdf-page-container[data-page-no="${pageNo}"]`)
    if (!slot) return;
    for (const child of [...slot.children]) {
      releaseCanvasResources(child);
      child.remove();
    }
    delete slot.dataset.renderKey;
  }

  private renderedPageNumbers(): number[] {
    const doc = this.iframe?.contentDocument;
    if (!doc) return [];
    return [...doc.querySelectorAll<HTMLElement>(".pdf-page-container[data-render-key]")]
      .map(slot => Number(slot.dataset.pageNo))
      .filter(Number.isFinite);
  }

  private trimResidentPages(focusPage: number): void {
    const rendered = this.renderedPageNumbers();
    if (rendered.length <= PERFORMANCE_BUDGETS.maxResidentPdfPages) return;
    pagesToEvict(rendered, focusPage, PERFORMANCE_BUDGETS.maxResidentPdfPages)
      .forEach(pageNo => this.releaseFinalPage(pageNo));
  }

  private cancelAllPageRenders(): void {
    this.renderScheduler.clear();
    if (this.motionFrame !== null) cancelAnimationFrame(this.motionFrame);
    this.motionFrame = null;
    this.motion.reset(this.iframe?.contentWindow?.scrollY ?? 0, performance.now());
    this.motionStartedAt = null;
    this.finalDecisionAt = null;
    this.cancelActivePageRenders();
  }

  private cancelActivePageRenders(): void {
    for (const [pageNo, render] of this.activeRenders) {
      render.task?.cancel();
      this.recordEvent("preview.render-cancel", { pageNo });
      this.activeRenders.delete(pageNo);
    }
  }

  private cancelDistantPageRenders(focusPage: number, radius: number): void {
    for (const [pageNo, render] of this.activeRenders) {
      if (Math.abs(pageNo - focusPage) <= radius) continue;
      render.task?.cancel();
      this.recordEvent("preview.render-cancel", { pageNo });
      this.activeRenders.delete(pageNo);
    }
  }

  private recordMetric(name: PerformanceMetric["name"], milliseconds: number, detail: Record<string, string | number | boolean>): void {
    this.onPerformance?.({ name, milliseconds, detail });
  }

  private recordEvent(name: PerformanceMetric["name"], detail: Record<string, string | number | boolean>): void {
    this.onPerformance?.({ name, detail });
  }

  private async disposePdfDocument(): Promise<void> {
    this.observer?.disconnect();
    this.observer = null;
    this.cancelAllPageRenders();
    const loadingTask = this.pdfLoadingTask;
    const pendingLoadingTask = this.pendingPdfLoadingTask;
    const pdfDoc = this.pdfDoc;
    this.pdfLoadingTask = null;
    this.pendingPdfLoadingTask = null;
    this.pdfDoc = null;
    await cleanupPdfResources(pdfDoc, loadingTask);
    if (pendingLoadingTask && pendingLoadingTask !== loadingTask) {
      try { await pendingLoadingTask.destroy(); } catch {}
    }
    this.pageDimensions.clear();
    this.pageSlots = [];
  }

  public scrollToPage(pageNo: number): void {
    this.iframe?.contentDocument
      ?.querySelector(`.pdf-page-container[data-page-no="${pageNo}"]`)
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  public async revealDocumentPosition(position: { page_no: number; x: number; y: number }, options: { ripple?: boolean } = {}): Promise<void> {
    const slot = this.iframe?.contentDocument
      ?.querySelector<HTMLElement>(`.pdf-page-container[data-page-no="${position.page_no}"]`);
    if (!slot) return;
    const view = this.iframe?.contentWindow;
    if (!view) return;

    const zoom = this.previewZoomPercent / 100;
    const targetY = slot.offsetTop + (position.y * zoom) - (view.innerHeight * 0.45);
    view.scrollTo({
      top: Math.max(0, targetY),
      behavior: "smooth"
    });
    if (options.ripple) {
      await this.showForwardSyncRippleAtDocumentPosition(position);
    }
  }

  private async showForwardSyncRippleAtDocumentPosition(position: { page_no: number; x: number; y: number }): Promise<void> {
    const generation = ++this.forwardRippleGeneration;
    const view = this.iframe?.contentWindow;
    const doc = this.iframe?.contentDocument;
    if (!view || !doc) return;

    await waitForPreviewScrollToSettle(view, 100, 100);
    const slot = doc.querySelector<HTMLElement>(`.pdf-page-container[data-page-no="${position.page_no}"]`);
    if (generation !== this.forwardRippleGeneration || !slot) return;

    const zoom = this.previewZoomPercent / 100;
    const slotRect = slot.getBoundingClientRect();
    const x = slotRect.left + (position.x * zoom);
    const y = slotRect.top + (position.y * zoom);
    this.renderForwardSyncRipple(doc, x, y);
  }

  private renderForwardSyncRipple(doc: Document, x: number, y: number): void {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    doc.querySelectorAll(".forward-sync-ripple").forEach(element => element.remove());
    const ripple = doc.createElement("div");
    ripple.className = "forward-sync-ripple";
    ripple.style.left = `${x}px`;
    ripple.style.top = `${y}px`;
    doc.body.appendChild(ripple);
    window.setTimeout(() => {
      if (ripple.isConnected) ripple.remove();
    }, 1000);
  }

  private captureScrollAnchor(): ScrollAnchor | null {
    const doc = this.iframe?.contentDocument;
    if (!doc) return null;
    const slots = [...doc.querySelectorAll<HTMLElement>(".pdf-page-container")];
    const anchor = slots.find(slot => slot.getBoundingClientRect().bottom > 0) ?? slots[0];
    if (!anchor) return null;
    return { pageNo: Number(anchor.dataset.pageNo), offset: anchor.getBoundingClientRect().top };
  }

  private restoreScrollAnchor(anchor: ScrollAnchor | null, afterLayout = false): void {
    if (!anchor) return;
    const restore = () => {
      const slot = this.iframe?.contentDocument
        ?.querySelector<HTMLElement>(`.pdf-page-container[data-page-no="${anchor.pageNo}"]`);
      const view = this.iframe?.contentWindow;
      if (!slot || !view) return;
      view.scrollBy(0, slot.getBoundingClientRect().top - anchor.offset);
    };
    requestAnimationFrame(() => {
      if (afterLayout) requestAnimationFrame(restore);
      else restore();
    });
  }

  private setupIframeInteractions(): void {
    const doc = this.iframe?.contentDocument;
    if (!doc) {
      this.debugInverse("Interaction installation deferred: iframe document unavailable.");
      return;
    }
    this.syncTheme();
    if (doc.documentElement.dataset.typsastraInteractions === "true") return;
    doc.documentElement.dataset.typsastraInteractions = "true";
    this.motion.reset(this.iframe?.contentWindow?.scrollY ?? 0, performance.now());
    this.debugInverse(`Interaction listener installed: readyState=${doc.readyState}, url=${doc.URL || "(empty)"}.`);
    doc.addEventListener("contextmenu", event => event.preventDefault());
    doc.addEventListener("pointerdown", () => this.motion.setPointerDown(true), true);
    this.iframe?.contentWindow?.addEventListener("pointerup", () => this.motion.setPointerDown(false), true);
    this.iframe?.contentWindow?.addEventListener("pointercancel", () => this.motion.setPointerDown(false), true);
    this.iframe?.contentWindow?.addEventListener("blur", () => this.motion.setPointerDown(false));
    doc.addEventListener("click", event => {
      const target = event.target as Element | null;
      const slot = target?.closest<HTMLElement>(".pdf-page-container");
      if (!slot) {
        this.debugInverse("Click ignored: no PDF page container at target.");
        return;
      }
      const mouse = event as MouseEvent;
      const pageNo = Number(slot.dataset.pageNo);
      this.debugInverse(`Click received: page=${pageNo}, x=${mouse.clientX.toFixed(1)}, y=${mouse.clientY.toFixed(1)}, target=${target?.tagName ?? "unknown"}.`);
      const point = this.pdfDocumentPointAtClick(pageNo, slot, mouse);
      this.debugInverse(`PDF coordinate resolved: page=${pageNo}, x=${point.documentPosition?.x.toFixed(2)}, y=${point.documentPosition?.y.toFixed(2)}.`);
      this.onPreviewClick(point);
    }, true);

    doc.addEventListener("wheel", event => {
      if (event.ctrlKey) {
        event.preventDefault();
        if (event.deltaY < 0) {
          this.zoomIn();
        } else {
          this.zoomOut();
        }
      }
    }, { passive: false });
    this.iframe?.contentWindow?.addEventListener(
      "scroll",
      () => this.deferPageRenderingDuringScroll(),
      { passive: true }
    );
  }

  private pdfDocumentPointAtClick(pageNo: number, slot: HTMLElement, event: MouseEvent): PreviewClickPoint {
    const slotRect = slot.getBoundingClientRect();
    const x = event.clientX - slotRect.left;
    const y = event.clientY - slotRect.top;
    const zoom = this.previewZoomPercent / 100;
    return {
      pageNo,
      documentPosition: { page_no: pageNo, x: x / zoom, y: y / zoom }
    };
  }

  private debugInverse(reason: string): void {
    this.reportInteractionStatus({ kind: "debug", url: this.mountedUrl, reason: `Inverse sync: ${reason}` });
  }

  public activateSession(_sessionKey: string): boolean {
    return this.pdfDoc !== null;
  }

  public async clear(): Promise<void> {
    ++this.pdfGeneration;
    releaseCanvasResources(this.iframe?.contentDocument?.documentElement ?? null);
    this.iframe?.remove();
    this.iframe = null;
    this.mountedUrl = "";
    this.currentPdfBytes = 0;
    await this.disposePdfDocument();
    this.pdfWorker?.destroy();
    this.pdfWorker = null;
    this.clearErrorOverlay();
    this.clearMessageHost();
  }

  public setMessage(html: string): void {
    ++this.pdfGeneration;
    releaseCanvasResources(this.iframe?.contentDocument?.documentElement ?? null);
    this.iframe?.remove();
    this.iframe = null;
    this.mountedUrl = "";
    this.currentPdfBytes = 0;
    void this.disposePdfDocument();
    this.clearErrorOverlay();
    this.clearMessageHost();
    const host = document.createElement("div");
    host.className = "preview-message-host";
    host.innerHTML = html;
    this.pane.appendChild(host);
    this.messageHost = host;
  }

  public setLoading(message: string): void {
    this.clearMessageHost();
    const host = document.createElement("div");
    host.className = "preview-message-host preview-loading-overlay";
    host.innerHTML = `<div class="preview-loading-placeholder">`
      + `<div class="preview-loading-spinner"></div>`
      + `<div class="preview-loading-message">${escapeHtml(message)}</div>`
      + `</div>`;
    this.pane.appendChild(host);
    this.messageHost = host;
  }

  public setError(title: string, message: string): void {
    this.clearErrorOverlay();
    const overlay = document.createElement("div");
    overlay.className = "compiler-preview-error-overlay";
    const content = document.createElement("div");
    content.className = "compiler-preview-error-content";
    const titleElement = document.createElement("h3");
    titleElement.className = "compiler-preview-error-title";
    titleElement.textContent = `ⓧ ${title}`;
    const details = document.createElement("pre");
    details.className = "compiler-preview-error-message";
    details.textContent = message;
    content.append(titleElement, details);
    overlay.appendChild(content);
    this.pane.appendChild(overlay);
    this.errorOverlay = overlay;
  }

  public clearErrorOverlay(): void {
    this.errorOverlay?.remove();
    this.errorOverlay = null;
  }

  private clearMessageHost(): void {
    this.messageHost?.remove();
    this.messageHost = null;
  }

  private reportInteractionStatus(status: PreviewInteractionStatus): void {
    const key = `${status.kind}:${status.url}:${status.reason ?? ""}`;
    if (key === this.lastInteractionStatusKey) return;
    this.lastInteractionStatusKey = key;
    this.onInteractionStatus?.(status);
  }

}

function decodeBase64(value: string): Uint8Array {
  if (value.startsWith("data:")) {
    const comma = value.indexOf(",");
    if (comma >= 0) {
      value = value.slice(comma + 1);
    }
  }
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function readInitialPdfPageDimensions(pdfDoc: any): Promise<Map<number, PageDimensions>> {
  const dimensions = new Map<number, PageDimensions>();
  if (pdfDoc.numPages < 1) return dimensions;
  const page = await pdfDoc.getPage(1);
  const viewport = page.getViewport({ scale: 1 });
  const first = { width: viewport.width, height: viewport.height };
  for (let pageNo = 1; pageNo <= pdfDoc.numPages; pageNo += 1) {
    dimensions.set(pageNo, first);
  }
  page.cleanup();
  return dimensions;
}

function nextTurn(): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, 0));
}

async function cleanupPdfResources(
  pdfDoc: any,
  loadingTask: { destroy(): Promise<void> } | null
): Promise<void> {
  if (pdfDoc) {
    try { await pdfDoc.cleanup(false); } catch {}
    try { await pdfDoc.destroy(); } catch {}
  } else if (loadingTask) {
    try { await loadingTask.destroy(); } catch {}
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>]/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[character] ?? character);
}

function viewportRectangle(viewport: any, rect: unknown): [number, number, number, number] | null {
  if (!Array.isArray(rect) || rect.length < 4 || typeof viewport?.convertToViewportPoint !== "function") {
    return null;
  }
  const x1 = Number(rect[0]);
  const y1 = Number(rect[1]);
  const x2 = Number(rect[2]);
  const y2 = Number(rect[3]);
  if (![x1, y1, x2, y2].every(Number.isFinite)) return null;
  const first = viewport.convertToViewportPoint(x1, y1);
  const second = viewport.convertToViewportPoint(x2, y2);
  if (!Array.isArray(first) || !Array.isArray(second)) return null;
  return [first[0], first[1], second[0], second[1]];
}

function replaceElementChildren(element: Element, ...children: Node[]): void {
  const retained = new Set(children);
  for (const child of [...element.children]) {
    if (!retained.has(child)) releaseCanvasResources(child);
  }
  while (element.firstChild) {
    element.removeChild(element.firstChild);
  }
  for (const child of children) {
    element.appendChild(child);
  }
}

function releaseCanvas(canvas: HTMLCanvasElement): void {
  // Resizing clears the graphics backing store immediately in WebView2/WebKit
  // instead of waiting for a later JavaScript and GPU garbage-collection pass.
  canvas.width = 0;
  canvas.height = 0;
}

function releaseCanvasResources(root: Element | null): void {
  if (!root) return;
  // Preview canvases live in an iframe realm, so `instanceof
  // HTMLCanvasElement` from the parent window is not reliable here.
  if (root.tagName === "CANVAS") releaseCanvas(root as HTMLCanvasElement);
  root.querySelectorAll<HTMLCanvasElement>("canvas").forEach(releaseCanvas);
}

async function waitForPreviewScrollToSettle(
  view: Window,
  initialDelayMs: number,
  afterScrollStopDelayMs: number
): Promise<void> {
  let sawScroll = false;
  const startedAt = performance.now();
  let lastScrollAt = performance.now();
  let lastX = view.scrollX;
  let lastY = view.scrollY;
  const onScroll = () => {
    sawScroll = true;
    lastScrollAt = performance.now();
    lastX = view.scrollX;
    lastY = view.scrollY;
  };

  view.addEventListener("scroll", onScroll, { passive: true });
  await delay(initialDelayMs);
  if (view.scrollX !== lastX || view.scrollY !== lastY) {
    onScroll();
  }
  if (!sawScroll) {
    view.removeEventListener("scroll", onScroll);
    return;
  }

  await new Promise<void>(resolve => {
    const check = () => {
      const now = performance.now();
      if (now - lastScrollAt >= afterScrollStopDelayMs || now - startedAt >= 5000) {
        window.setTimeout(resolve, afterScrollStopDelayMs);
        return;
      }
      view.requestAnimationFrame(check);
    };
    view.requestAnimationFrame(check);
  });
  view.removeEventListener("scroll", onScroll);
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, ms));
}
