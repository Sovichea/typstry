export type PreviewClickPoint = {
  pageNo?: number;
  documentPosition?: { page_no: number; x: number; y: number };
};

export type PreviewInteractionStatus = {
  kind: "installed" | "blocked" | "debug";
  url: string;
  reason?: string;
};

type PdfJsModule = typeof import("pdfjs-dist");

type PageDimensions = {
  width: number;
  height: number;
};

type ActivePageRender = {
  generation: number;
  task: { cancel(): void } | null;
  page: { cleanup(): void } | null;
};

const ZOOM_LEVELS = [25, 33, 50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200, 250, 300, 400, 500];
const DEFAULT_ZOOM_PERCENT = 90;
const MAX_OUTPUT_SCALE = 2;
const FORWARD_SYNC_GREEN = "#3db489";

export class PreviewFrame {
  private iframe: HTMLIFrameElement | null = null;
  private messageHost: HTMLDivElement | null = null;
  private errorOverlay: HTMLDivElement | null = null;
  private mountedUrl = "";
  private previewZoomPercent = DEFAULT_ZOOM_PERCENT;
  private lastInteractionStatusKey = "";
  private pdfJsPromise: Promise<PdfJsModule> | null = null;
  private pdfLoadingTask: { destroy(): Promise<void> } | null = null;
  private pdfDoc: any = null;
  private observer: IntersectionObserver | null = null;
  private pageDimensions = new Map<number, PageDimensions>();
  private activeRenders = new Map<number, ActivePageRender>();
  private pdfGeneration = 0;
  private forwardRippleGeneration = 0;

  constructor(
    private readonly pane: HTMLElement,
    private readonly onPreviewClick: (point: PreviewClickPoint) => void,
    private readonly onInteractionStatus?: (status: PreviewInteractionStatus) => void,
    private readonly onZoomChanged?: (zoomPercent: number) => void
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

  public zoomIn(): number {
    return this.setZoom(ZOOM_LEVELS.find(level => level > this.previewZoomPercent) ?? this.previewZoomPercent);
  }

  public zoomOut(): number {
    return this.setZoom([...ZOOM_LEVELS].reverse().find(level => level < this.previewZoomPercent) ?? this.previewZoomPercent);
  }

  private setZoom(percent: number): number {
    if (percent === this.previewZoomPercent) return percent;
    const anchor = this.captureScrollAnchor();
    this.previewZoomPercent = percent;
    this.onZoomChanged?.(percent);
    this.cancelAllPageRenders();
    this.layoutPageSlots({ preserveExistingPages: true });
    this.restoreScrollAnchor(anchor);
    requestAnimationFrame(() => this.renderVisiblePages());
    return percent;
  }

  public async loadPdfData(base64Data: string, identity = "compiler-pdf"): Promise<void> {
    const generation = ++this.pdfGeneration;
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
      const bytes = decodeBase64(base64Data);
      const loadingTask = pdfjs.getDocument({
        data: bytes,
        ownerDocument: iframeDoc,
        cMapUrl: "/cmaps/",
        cMapPacked: true,
        standardFontDataUrl: "/standard_fonts/"
      });
      nextLoadingTask = loadingTask as unknown as { destroy(): Promise<void> };
      const pdfDoc = await loadingTask.promise;
      nextPdfDoc = pdfDoc;
      if (generation !== this.pdfGeneration) {
        await (pdfDoc as any).destroy();
        return;
      }
      const nextDimensions = await readPdfPageDimensions(pdfDoc, generation, () => this.pdfGeneration);
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
      this.pageDimensions = nextDimensions;
      this.mountedUrl = identity;
      this.createPageSlots(iframeDoc, true);
      this.setupIframeInteractions();
      this.installPageObserver(iframe);
      this.restoreScrollAnchor(previousScroll);
      this.reportInteractionStatus({ kind: "installed", url: identity });
      void cleanupPdfResources(oldPdfDoc, oldLoadingTask);
    } catch (error) {
      if (generation !== this.pdfGeneration) return;
      this.setError("PDF Loading Failed", String(error));
    } finally {
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
    if (this.iframe) this.iframe.remove();
    const iframe = document.createElement("iframe");
    iframe.className = "preview-frame";
    iframe.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><style>
      html,body{margin:0;width:100%;height:100%;background:transparent}
      body{overflow:auto;font-family:sans-serif}
      #viewer-container{box-sizing:border-box;min-width:100%;width:max-content;padding:20px;display:flex;flex-direction:column;gap:20px}
      .pdf-page-container{position:relative;box-sizing:border-box;flex:none;margin:0 auto;background:#fff;box-shadow:0 2px 10px rgba(0,0,0,.25);overflow:hidden}
      .pdf-page-canvas{position:absolute;inset:0;display:block;width:100%;height:100%}
      .textLayer{position:absolute;inset:0;overflow:hidden;line-height:1;opacity:1;--scale-factor:1;pointer-events:none;user-select:none}
      .textLayer span,.textLayer br{position:absolute;color:transparent;white-space:pre;transform-origin:0 0}
      .forward-sync-ripple{position:fixed;z-index:2147483647;box-sizing:border-box;width:18px;height:18px;margin:-9px 0 0 -9px;border:2px solid ${FORWARD_SYNC_GREEN};border-radius:999px;background:rgba(61,180,137,.16);box-shadow:0 0 0 0 rgba(61,180,137,.34);pointer-events:none;animation:typstry-forward-ripple 900ms ease-out forwards}
      @keyframes typstry-forward-ripple{0%{opacity:0;transform:scale(.55);box-shadow:0 0 0 0 rgba(61,180,137,.38)}12%{opacity:1}100%{opacity:0;transform:scale(3.1);box-shadow:0 0 0 14px rgba(61,180,137,0)}}
      .annotation-link{position:absolute;display:block}
      ::selection{background:rgba(0,120,215,.35)}
    </style></head><body><div id="viewer-container"></div></body></html>`;
    iframe.addEventListener("load", () => this.setupIframeInteractions());
    const loaded = new Promise<void>(resolve => iframe.addEventListener("load", () => resolve(), { once: true }));
    this.pane.appendChild(iframe);
    this.iframe = iframe;
    await loaded;
    this.setupIframeInteractions();
    return iframe;
  }

  private createPageSlots(doc: Document, preserveExistingPages = false): void {
    const viewer = doc.getElementById("viewer-container");
    if (!viewer || !this.pdfDoc) return;
    if (!preserveExistingPages) {
      viewer.replaceChildren();
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
      if (pageNo > this.pdfDoc.numPages) slot.remove();
    }
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
        slot.replaceChildren();
        delete slot.dataset.renderGeneration;
      }
    }
  }

  private installPageObserver(iframe: HTMLIFrameElement): void {
    this.observer?.disconnect();
    const doc = iframe.contentDocument;
    const Observer = (iframe.contentWindow as unknown as { IntersectionObserver: typeof IntersectionObserver }).IntersectionObserver;
    if (!doc || !Observer) return;
    this.observer = new Observer(entries => {
      for (const entry of entries) {
        const pageNo = Number((entry.target as HTMLElement).dataset.pageNo);
        if (entry.isIntersecting) void this.renderPage(pageNo, this.pdfGeneration);
        else this.unrenderPage(pageNo);
      }
    }, { root: null, rootMargin: "1000px 0px 1000px 0px", threshold: 0 });
    doc.querySelectorAll(".pdf-page-container").forEach(slot => this.observer?.observe(slot));
  }

  private renderVisiblePages(): void {
    const doc = this.iframe?.contentDocument;
    if (!doc) return;
    const viewportHeight = this.iframe?.clientHeight ?? 0;
    for (const slot of doc.querySelectorAll<HTMLElement>(".pdf-page-container")) {
      const rect = slot.getBoundingClientRect();
      if (rect.bottom >= -1000 && rect.top <= viewportHeight + 1000) {
        void this.renderPage(Number(slot.dataset.pageNo), this.pdfGeneration);
      }
    }
  }

  private async renderPage(pageNo: number, generation: number): Promise<void> {
    if (!this.pdfDoc || generation !== this.pdfGeneration || this.activeRenders.has(pageNo)) return;
    const doc = this.iframe?.contentDocument;
    const slot = doc?.querySelector<HTMLElement>(`.pdf-page-container[data-page-no="${pageNo}"]`);
    if (!doc || !slot || slot.dataset.renderGeneration === String(generation)) return;
    const replacingExistingPage = slot.firstElementChild !== null;

    const active: ActivePageRender = { generation, task: null, page: null };
    this.activeRenders.set(pageNo, active);
    try {
      const pdfjs = await this.pdfJs();
      const page = await this.pdfDoc.getPage(pageNo);
      active.page = page;
      if (!this.renderIsCurrent(pageNo, active, slot)) return;

      const cssScale = this.previewZoomPercent / 100;
      const cssViewport = page.getViewport({ scale: cssScale });
      const outputScale = Math.min(window.devicePixelRatio || 1, MAX_OUTPUT_SCALE);
      const renderViewport = page.getViewport({ scale: cssScale * outputScale });
      const canvas = doc.createElement("canvas");
      canvas.className = "pdf-page-canvas";
      canvas.width = Math.max(1, Math.floor(renderViewport.width));
      canvas.height = Math.max(1, Math.floor(renderViewport.height));
      if (!replacingExistingPage) slot.appendChild(canvas);

      const context = canvas.getContext("2d", { alpha: false });
      if (!context) throw new Error("Canvas rendering is unavailable.");
      const task = page.render({ canvasContext: context, viewport: renderViewport });
      active.task = task;
      await task.promise;
      active.task = null;
      if (!this.renderIsCurrent(pageNo, active, slot)) return;

      const textContent = await page.getTextContent();
      const textLayerElement = doc.createElement("div");
      textLayerElement.className = "textLayer";
      textLayerElement.style.setProperty("--scale-factor", String(cssViewport.scale));
      if (!replacingExistingPage) slot.appendChild(textLayerElement);
      const textLayer = new pdfjs.TextLayer({
        textContentSource: textContent,
        container: textLayerElement,
        viewport: cssViewport
      });
      await textLayer.render();
      if (!this.renderIsCurrent(pageNo, active, slot)) return;

      const annotationLinks: HTMLElement[] = [];
      for (const annotation of await page.getAnnotations()) {
        if (annotation.subtype !== "Link" || !annotation.url) continue;
        const rect = viewportRectangle(cssViewport, annotation.rect);
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
      if (replacingExistingPage) {
        slot.replaceChildren(canvas, textLayerElement, ...annotationLinks);
      } else {
        slot.append(...annotationLinks);
      }
      slot.dataset.renderGeneration = String(generation);
    } catch (error) {
      if (!(error instanceof Error && error.name === "RenderingCancelledException")) {
        console.error(`Failed to render PDF page ${pageNo}:`, error);
      }
    } finally {
      if (this.activeRenders.get(pageNo) === active) this.activeRenders.delete(pageNo);
      active.page?.cleanup();
    }
  }

  private renderIsCurrent(pageNo: number, active: ActivePageRender, slot: HTMLElement): boolean {
    return active.generation === this.pdfGeneration
      && this.activeRenders.get(pageNo) === active
      && slot.isConnected;
  }

  private unrenderPage(pageNo: number): void {
    const active = this.activeRenders.get(pageNo);
    active?.task?.cancel();
    active?.page?.cleanup();
    this.activeRenders.delete(pageNo);
    const slot = this.iframe?.contentDocument
      ?.querySelector<HTMLElement>(`.pdf-page-container[data-page-no="${pageNo}"]`)
    if (!slot) return;
    slot.replaceChildren();
    delete slot.dataset.renderGeneration;
  }

  private cancelAllPageRenders(): void {
    for (const [pageNo, render] of this.activeRenders) {
      render.task?.cancel();
      render.page?.cleanup();
      this.activeRenders.delete(pageNo);
    }
  }

  private async disposePdfDocument(): Promise<void> {
    this.observer?.disconnect();
    this.observer = null;
    this.cancelAllPageRenders();
    const loadingTask = this.pdfLoadingTask;
    const pdfDoc = this.pdfDoc;
    this.pdfLoadingTask = null;
    this.pdfDoc = null;
    if (pdfDoc) {
      try { await pdfDoc.destroy(); } catch {}
    } else if (loadingTask) {
      try { await loadingTask.destroy(); } catch {}
    }
    this.pageDimensions.clear();
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

  private captureScrollAnchor(): { pageNo: number; offset: number } | null {
    const doc = this.iframe?.contentDocument;
    if (!doc) return null;
    const slots = [...doc.querySelectorAll<HTMLElement>(".pdf-page-container")];
    const anchor = slots.find(slot => slot.getBoundingClientRect().bottom > 0) ?? slots[0];
    if (!anchor) return null;
    return { pageNo: Number(anchor.dataset.pageNo), offset: anchor.getBoundingClientRect().top };
  }

  private restoreScrollAnchor(anchor: { pageNo: number; offset: number } | null): void {
    if (!anchor) return;
    requestAnimationFrame(() => {
      const slot = this.iframe?.contentDocument
        ?.querySelector<HTMLElement>(`.pdf-page-container[data-page-no="${anchor.pageNo}"]`);
      const view = this.iframe?.contentWindow;
      if (!slot || !view) return;
      view.scrollBy(0, slot.getBoundingClientRect().top - anchor.offset);
    });
  }

  private setupIframeInteractions(): void {
    const doc = this.iframe?.contentDocument;
    if (!doc) {
      this.debugInverse("Interaction installation deferred: iframe document unavailable.");
      return;
    }
    if (doc.documentElement.dataset.typstryInteractions === "true") return;
    doc.documentElement.dataset.typstryInteractions = "true";
    this.debugInverse(`Interaction listener installed: readyState=${doc.readyState}, url=${doc.URL || "(empty)"}.`);
    doc.addEventListener("contextmenu", event => event.preventDefault());
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
    this.iframe?.remove();
    this.iframe = null;
    this.mountedUrl = "";
    await this.disposePdfDocument();
    this.clearErrorOverlay();
    this.clearMessageHost();
  }

  public setMessage(html: string): void {
    ++this.pdfGeneration;
    this.iframe?.remove();
    this.iframe = null;
    this.mountedUrl = "";
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
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function readPdfPageDimensions(
  pdfDoc: any,
  generation: number,
  currentGeneration: () => number
): Promise<Map<number, PageDimensions>> {
  const dimensions = new Map<number, PageDimensions>();
  for (let pageNo = 1; pageNo <= pdfDoc.numPages; pageNo += 1) {
    if (generation !== currentGeneration()) return dimensions;
    const page = await pdfDoc.getPage(pageNo);
    const viewport = page.getViewport({ scale: 1 });
    dimensions.set(pageNo, { width: viewport.width, height: viewport.height });
    page.cleanup();
  }
  return dimensions;
}

async function cleanupPdfResources(
  pdfDoc: any,
  loadingTask: { destroy(): Promise<void> } | null
): Promise<void> {
  if (pdfDoc) {
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
