export type PreviewTextPoint = { text: string; offset: number };

export class PreviewFrame {
  private iframe: HTMLIFrameElement | null = null;

  constructor(
    private readonly pane: HTMLElement,
    private readonly onTextClick: (point: PreviewTextPoint) => void
  ) {}

  public get element(): HTMLIFrameElement | null {
    return this.iframe;
  }

  public async mount(previewUrl: string, getPreviewHtml: () => Promise<string>): Promise<void> {
    this.pane.innerHTML = "";
    const iframe = document.createElement("iframe");
    iframe.className = "preview-frame";
    iframe.addEventListener("load", () => this.configureDocument());
    this.pane.appendChild(iframe);
    this.iframe = iframe;

    const previewHtml = await getPreviewHtml();
    if (previewHtml) iframe.srcdoc = this.buildSrcdoc(previewUrl, previewHtml);
    else iframe.src = previewUrl;
  }

  public scrollToHighlight(color = "#fe0102"): boolean {
    const iframe = this.iframe;
    const iframeDocument = iframe?.contentDocument;
    if (!iframe || !iframeDocument) return false;

    const elements = Array.from(iframeDocument.querySelectorAll(
      `[fill="${color}"], [fill="rgb(254, 1, 2)"], [style*="color: ${color}"], [style*="color: rgb(254, 1, 2)"]`
    ));
    const target = elements.find(element => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
    if (!target) return false;

    const rect = target.getBoundingClientRect();
    const iframeWindow = iframe.contentWindow;
    let scrollContainer: Element | null = null;
    let current = target.parentElement;
    if (iframeWindow) {
      while (current) {
        const style = iframeWindow.getComputedStyle(current);
        if (style.overflowY === "auto" || style.overflowY === "scroll") {
          scrollContainer = current;
          break;
        }
        current = current.parentElement;
      }
    }

    if (scrollContainer) {
      const containerRect = scrollContainer.getBoundingClientRect();
      scrollContainer.scrollTo({
        top: scrollContainer.scrollTop + rect.top - containerRect.top - containerRect.height / 2 + rect.height / 2,
        left: scrollContainer.scrollLeft + rect.left - containerRect.left - containerRect.width / 2 + rect.width / 2,
        behavior: "smooth"
      });
    } else if (this.pane.scrollHeight > this.pane.clientHeight) {
      const iframeRect = iframe.getBoundingClientRect();
      const paneRect = this.pane.getBoundingClientRect();
      this.pane.scrollTo({
        top: this.pane.scrollTop + iframeRect.top + rect.top - paneRect.top - paneRect.height / 2 + rect.height / 2,
        left: this.pane.scrollLeft + iframeRect.left + rect.left - paneRect.left - paneRect.width / 2 + rect.width / 2,
        behavior: "smooth"
      });
    } else if (iframeWindow) {
      iframeWindow.scrollTo({
        top: iframeWindow.scrollY + rect.top - iframeWindow.innerHeight / 2 + rect.height / 2,
        left: iframeWindow.scrollX + rect.left - iframeWindow.innerWidth / 2 + rect.width / 2,
        behavior: "smooth"
      });
    }

    return true;
  }

  private buildSrcdoc(previewUrl: string, previewHtml: string): string {
    const baseHref = previewUrl.endsWith("/") ? previewUrl : `${previewUrl}/`;
    const escapedHref = baseHref
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    const base = `<base href="${escapedHref}">`;
    return /<head[^>]*>/i.test(previewHtml)
      ? previewHtml.replace(/<head([^>]*)>/i, `<head$1>${base}`)
      : `${base}${previewHtml}`;
  }

  private configureDocument(): void {
    try {
      const doc = this.iframe?.contentDocument;
      if (!doc || doc.getElementById("typstry-disable-preview-ripple")) return;

      const style = doc.createElement("style");
      style.id = "typstry-disable-preview-ripple";
      style.textContent = ".typst-jump-ripple{display:none!important;animation:none!important;}";
      doc.head.appendChild(style);
      doc.addEventListener("click", event => {
        const point = this.textPointFromMouseEvent(doc, event);
        if (point) this.onTextClick(point);
      }, true);
      doc.addEventListener("contextmenu", event => event.preventDefault());
    } catch {
      // Cross-origin preview pages keep their own interaction handling.
    }
  }

  private textPointFromMouseEvent(doc: Document, event: MouseEvent): PreviewTextPoint | null {
    const pointDocument = doc as Document & {
      caretRangeFromPoint?: (x: number, y: number) => Range | null;
      caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    };
    const range = pointDocument.caretRangeFromPoint?.(event.clientX, event.clientY);
    if (range?.startContainer.nodeType === Node.TEXT_NODE) {
      return { text: range.startContainer.textContent ?? "", offset: range.startOffset };
    }

    const position = pointDocument.caretPositionFromPoint?.(event.clientX, event.clientY);
    if (position?.offsetNode.nodeType === Node.TEXT_NODE) {
      return { text: position.offsetNode.textContent ?? "", offset: position.offset };
    }

    const text = (event.target as Element | null)?.textContent?.trim();
    return text ? { text, offset: Math.floor(text.length / 2) } : null;
  }
}
