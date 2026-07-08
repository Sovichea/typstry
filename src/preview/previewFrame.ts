export type PreviewTextPoint = { text: string; offset: number };

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

  constructor(
    private readonly pane: HTMLElement,
    _onTextClick: (point: PreviewTextPoint) => void,
    private readonly onInteractionStatus?: (status: PreviewInteractionStatus) => void,
    private readonly onZoomChanged?: (zoomPercent: number) => void
  ) {}

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
    this.layoutPageSlots();
    this.restoreScrollAnchor(anchor);
    requestAnimationFrame(() => this.renderVisiblePages());
    return percent;
  }

  public async loadPdfData(base64Data: string, identity = "compiler-pdf"): Promise<void> {
    const generation = ++this.pdfGeneration;
    const previousScroll = this.captureScrollAnchor();
    this.clearErrorOverlay();
    this.clearMessageHost();
    await this.disposePdfDocument();
    if (generation !== this.pdfGeneration) return;

    const iframe = await this.ensureIframe();
    if (generation !== this.pdfGeneration) return;
    const iframeDoc = iframe.contentDocument;
    if (!iframeDoc) throw new Error("PDF preview document is unavailable.");

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
      this.pdfLoadingTask = loadingTask as unknown as { destroy(): Promise<void> };
      const pdfDoc = await loadingTask.promise;
      if (generation !== this.pdfGeneration) {
        await (pdfDoc as any).destroy();
        return;
      }
      this.pdfDoc = pdfDoc;
      this.mountedUrl = identity;
      await this.readPageDimensions(generation);
      if (generation !== this.pdfGeneration) return;
      this.createPageSlots(iframeDoc);
      this.installPageObserver(iframe);
      this.restoreScrollAnchor(previousScroll);
      this.reportInteractionStatus({ kind: "installed", url: identity });
    } catch (error) {
      if (generation !== this.pdfGeneration) return;
      this.setError("PDF Loading Failed", String(error));
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
      html,body{margin:0;width:100%;height:100%;background:#d8d8d8}
      body{overflow:auto;font-family:sans-serif}
      #viewer-container{box-sizing:border-box;min-width:100%;width:max-content;padding:20px;display:flex;flex-direction:column;gap:20px}
      .pdf-page-container{position:relative;box-sizing:border-box;flex:none;margin:0 auto;background:#fff;box-shadow:0 2px 10px rgba(0,0,0,.25);overflow:hidden}
      .pdf-page-canvas{position:absolute;inset:0;display:block;width:100%;height:100%}
      .textLayer{position:absolute;inset:0;overflow:hidden;line-height:1;opacity:1;--scale-factor:1}
      .textLayer span,.textLayer br{position:absolute;color:transparent;white-space:pre;cursor:text;transform-origin:0 0}
      .annotation-link{position:absolute;display:block}
      ::selection{background:rgba(0,120,215,.35)}
    </style></head><body><div id="viewer-container"></div></body></html>`;
    const loaded = new Promise<void>(resolve => iframe.addEventListener("load", () => resolve(), { once: true }));
    this.pane.appendChild(iframe);
    this.iframe = iframe;
    await loaded;
    this.setupIframeInteractions();
    return iframe;
  }

  private async readPageDimensions(generation: number): Promise<void> {
    this.pageDimensions.clear();
    if (!this.pdfDoc) return;
    for (let pageNo = 1; pageNo <= this.pdfDoc.numPages; pageNo += 1) {
      if (generation !== this.pdfGeneration) return;
      const page = await this.pdfDoc.getPage(pageNo);
      const viewport = page.getViewport({ scale: 1 });
      this.pageDimensions.set(pageNo, { width: viewport.width, height: viewport.height });
      page.cleanup();
    }
  }

  private createPageSlots(doc: Document): void {
    const viewer = doc.getElementById("viewer-container");
    if (!viewer || !this.pdfDoc) return;
    viewer.replaceChildren();
    for (let pageNo = 1; pageNo <= this.pdfDoc.numPages; pageNo += 1) {
      const slot = doc.createElement("div");
      slot.className = "pdf-page-container";
      slot.dataset.pageNo = String(pageNo);
      viewer.appendChild(slot);
    }
    this.layoutPageSlots();
  }

  private layoutPageSlots(): void {
    const doc = this.iframe?.contentDocument;
    if (!doc) return;
    const zoom = this.previewZoomPercent / 100;
    for (const slot of doc.querySelectorAll<HTMLElement>(".pdf-page-container")) {
      const pageNo = Number(slot.dataset.pageNo);
      const dimensions = this.pageDimensions.get(pageNo);
      if (!dimensions) continue;
      slot.style.width = `${dimensions.width * zoom}px`;
      slot.style.height = `${dimensions.height * zoom}px`;
      slot.replaceChildren();
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
    if (!doc || !slot || slot.firstElementChild) return;

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
      canvas.style.width = `${cssViewport.width}px`;
      canvas.style.height = `${cssViewport.height}px`;
      slot.appendChild(canvas);

      const context = canvas.getContext("2d", { alpha: false });
      if (!context) throw new Error("Canvas rendering is unavailable.");
      const task = page.render({ canvasContext: context, viewport: renderViewport });
      active.task = task;
      await task.promise;
      active.task = null;
      if (!this.renderIsCurrent(pageNo, active, slot)) return;

      const textLayerElement = doc.createElement("div");
      textLayerElement.className = "textLayer";
      textLayerElement.style.setProperty("--scale-factor", String(cssViewport.scale));
      slot.appendChild(textLayerElement);
      const textLayer = new pdfjs.TextLayer({
        textContentSource: await page.getTextContent(),
        container: textLayerElement,
        viewport: cssViewport
      });
      await textLayer.render();
      if (!this.renderIsCurrent(pageNo, active, slot)) return;

      for (const annotation of await page.getAnnotations()) {
        if (annotation.subtype !== "Link" || !annotation.url) continue;
        const rect = cssViewport.convertToViewportRectangle(annotation.rect);
        const link = doc.createElement("a");
        link.className = "annotation-link";
        link.href = annotation.url;
        link.style.left = `${Math.min(rect[0], rect[2])}px`;
        link.style.top = `${Math.min(rect[1], rect[3])}px`;
        link.style.width = `${Math.abs(rect[2] - rect[0])}px`;
        link.style.height = `${Math.abs(rect[3] - rect[1])}px`;
        slot.appendChild(link);
      }
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
    this.iframe?.contentDocument
      ?.querySelector<HTMLElement>(`.pdf-page-container[data-page-no="${pageNo}"]`)
      ?.replaceChildren();
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

  public async scrollToText(pageNo: number, text: string): Promise<void> {
    const slot = this.iframe?.contentDocument
      ?.querySelector<HTMLElement>(`.pdf-page-container[data-page-no="${pageNo}"]`);
    if (!slot) return;
    slot.scrollIntoView({ behavior: "smooth", block: "nearest" });
    await this.renderPage(pageNo, this.pdfGeneration);
    const normalized = text.trim();
    const match = [...slot.querySelectorAll<HTMLElement>(".textLayer span")]
      .find(span => {
        const candidate = span.textContent?.trim() ?? "";
        return candidate.length > 0 && (candidate.includes(normalized) || normalized.includes(candidate));
      });
    match?.scrollIntoView({ behavior: "smooth", block: "center" });
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
    if (!doc || doc.documentElement.dataset.typstryInteractions === "true") return;
    doc.documentElement.dataset.typstryInteractions = "true";
    doc.addEventListener("contextmenu", event => event.preventDefault());
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

function escapeHtml(value: string): string {
  return value.replace(/[&<>]/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[character] ?? character);
}
