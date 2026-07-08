import { invoke } from "@tauri-apps/api/core";

export type PreviewTextPoint = { text: string; offset: number };

export type PreviewInteractionStatus = {
  kind: "installed" | "blocked" | "debug";
  url: string;
  reason?: string;
};

const DEFAULT_PREVIEW_ZOOM_PERCENT = 90;

export class PreviewFrame {
  private iframe: HTMLIFrameElement | null = null;
  private svgIframe: HTMLIFrameElement | null = null;
  private mountedUrl = "";
  private activeSessionKey = "";
  private readonly sessions = new Map<string, { iframe: HTMLIFrameElement; url: string; usedAt: number; scrollKey: string; blobUrl?: string; scriptBlobUrls?: string[] }>();
  private readonly scrollPositions = new Map<string, { top: number; left: number }>();
  private readonly zoomBySession = new Map<string, number>();
  private readonly maxSessions = 5;
  private lastInteractionStatusKey = "";
  private previewZoomPercent = 100;
  private errorOverlay: HTMLDivElement | null = null;

  constructor(
    private readonly pane: HTMLElement,
    private readonly onTextClick: (point: PreviewTextPoint) => void,
    private readonly onInteractionStatus?: (status: PreviewInteractionStatus) => void,
    private readonly onZoomChanged?: (zoomPercent: number) => void
  ) {
    window.addEventListener("message", event => {
      const data = event.data as { typstryPreviewStatus?: string; message?: string; source?: string; lineno?: number; colno?: number } | null;
      if (!data) return;
      if (data.typstryPreviewStatus === "debug") {
        this.reportDebug(this.mountedUrl, data.message ?? "Preview iframe debug event.");
        return;
      }
      if (data.typstryPreviewStatus !== "runtime-error") return;
      const location = data.source ? ` at ${data.source}${data.lineno ? `:${data.lineno}:${data.colno ?? 0}` : ""}` : "";
      const reason = `runtime error${location}: ${data.message ?? "unknown error"}`;
      this.reportInteractionStatus({
        kind: "blocked",
        url: this.mountedUrl,
        reason
      });
      if (this.iframe?.contentWindow === event.source) {
        this.showInterceptedPreviewError(this.iframe, this.mountedUrl, reason);
      }
    });
  }

  public get element(): HTMLIFrameElement | null {
    return this.iframe;
  }

  /**
   * Returns the currently mounted preview URL, or empty if no preview is active.
   */
  public get currentUrl(): string {
    return this.mountedUrl;
  }

  public get currentZoomPercent(): number {
    return this.previewZoomPercent;
  }

  public zoomIn(): number {
    return this.zoomPreview("in");
  }

  public zoomOut(): number {
    return this.zoomPreview("out");
  }

  /**
   * Mount a preview iframe. If the URL matches the currently mounted preview,
   * skip remounting — Tinymist updates existing previews via WebSocket.
   * Returns true if a fresh mount was performed, false if reused.
   */
  public async mount(previewUrl: string, _getPreviewHtml?: () => Promise<string>): Promise<boolean> {
    return this.mountSession("default", previewUrl, "default");
  }

  public hasSession(sessionKey: string): boolean {
    return this.sessions.has(sessionKey);
  }

  public activateSession(sessionKey: string): boolean {
    this.captureActiveScroll();
    const session = this.sessions.get(sessionKey);
    if (!session) return false;
    if (session.iframe.parentElement !== this.pane) {
      this.sessions.delete(sessionKey);
      return false;
    }
    if (this.svgIframe) {
      this.svgIframe.remove();
      this.svgIframe = null;
    }
    this.clearErrorOverlay();
    for (const [key, item] of this.sessions) item.iframe.classList.toggle("hidden", key !== sessionKey);
    session.usedAt = Date.now();
    this.activeSessionKey = sessionKey;
    this.iframe = session.iframe;
    this.mountedUrl = session.url;
    this.previewZoomPercent = this.zoomBySession.get(sessionKey) ?? 100;
    this.onZoomChanged?.(this.previewZoomPercent);
    this.restoreScroll(session);
    return true;
  }

  public async mountSession(
    sessionKey: string,
    previewUrl: string,
    scrollKey = sessionKey,
    getPreviewHtml?: () => Promise<string>,
    dataPlaneUrl?: string
  ): Promise<boolean> {
    const existing = this.sessions.get(sessionKey);
    if (existing?.url === previewUrl && existing.iframe.parentElement === this.pane) {
      this.reportDebug(previewUrl, `Reusing preview session ${sessionKey}.`);
      this.activateSession(sessionKey);
      return false;
    }
    if (existing) {
      this.reportDebug(previewUrl, `Replacing existing preview session ${sessionKey}.`);
      if (existing.blobUrl) URL.revokeObjectURL(existing.blobUrl);
      for (const url of existing.scriptBlobUrls ?? []) URL.revokeObjectURL(url);
      existing.iframe.remove();
    }
    const iframe = document.createElement("iframe");
    iframe.className = "preview-frame";
    iframe.addEventListener("load", () => {
      this.reportDebug(previewUrl, `Iframe load event. src="${iframe.src || "(empty)"}", has srcdoc=${iframe.srcdoc.length > 0}.`);
      this.configureDocument(iframe);
      const session = this.sessions.get(sessionKey);
      if (session) this.restoreScroll(session);
      this.scheduleInitialZoom(iframe, sessionKey);
    });
    this.pane.appendChild(iframe);
    this.sessions.set(sessionKey, { iframe, url: previewUrl, usedAt: Date.now(), scrollKey });
    this.activeSessionKey = sessionKey;
    this.iframe = iframe;
    this.mountedUrl = previewUrl;
    this.activateSession(sessionKey);
    this.reportDebug(previewUrl, `Mounted preview iframe for session ${sessionKey}. Pane children=${this.pane.children.length}.`);
    const previewHtml = await getPreviewHtml?.().catch(() => "");
    this.reportDebug(previewUrl, `Tinymist preview HTML ${previewHtml ? `received (${previewHtml.length} chars)` : "missing"}. Data plane=${dataPlaneUrl || "(none)"}.`);
    if (previewHtml) {
      await this.writeInterceptedPreview(iframe, previewHtml, previewUrl, dataPlaneUrl);
    } else {
      this.showInterceptedPreviewError(
        iframe,
        previewUrl,
        "Tinymist did not return preview HTML, so Typstry cannot install DOM interception."
      );
    }
    this.evictInactiveSessions();
    return true;
  }

  private async writeInterceptedPreview(
    iframe: HTMLIFrameElement,
    html: string,
    previewUrl: string,
    dataPlaneUrl?: string
  ): Promise<boolean> {
    try {
      this.reportDebug(previewUrl, `Writing intercepted preview document (${html.length} chars before sanitization).`);
      const proxiedDataPlaneUrl = await this.startPreviewWebSocketProxy(previewUrl, dataPlaneUrl);
      const bootstrapScriptUrl = URL.createObjectURL(new Blob([this.previewBootstrapScript(previewUrl, proxiedDataPlaneUrl)], {
        type: "text/javascript"
      }));
      const wasmBlobUrl = await this.fetchPreviewWasmBlobUrl(previewUrl);
      const prepared = this.preparePreviewHtml(html, previewUrl, proxiedDataPlaneUrl, wasmBlobUrl);
      const scriptBlobUrls = [bootstrapScriptUrl, ...prepared.scriptBlobUrls, ...(wasmBlobUrl ? [wasmBlobUrl] : [])];
      const blob = new Blob([this.previewSrcdoc(prepared.html, previewUrl, bootstrapScriptUrl)], {
        type: "text/html"
      });
      const blobUrl = URL.createObjectURL(blob);
      const session = this.sessions.get(this.activeSessionKey);
      if (session?.blobUrl) URL.revokeObjectURL(session.blobUrl);
      for (const url of session?.scriptBlobUrls ?? []) URL.revokeObjectURL(url);
      if (session?.iframe === iframe) {
        session.blobUrl = blobUrl;
        session.scriptBlobUrls = scriptBlobUrls;
      }
      iframe.src = blobUrl;
      this.reportDebug(previewUrl, `Intercepted preview blob URL assigned: ${blobUrl}; scripts=${scriptBlobUrls.length}.`);
      this.scheduleDocumentProbe(iframe, previewUrl, "after-blob-src");
      return true;
    } catch (error) {
      this.reportInteractionStatus({
        kind: "blocked",
        url: previewUrl,
        reason: error instanceof Error ? error.message : String(error)
      });
      this.showInterceptedPreviewError(
        iframe,
        previewUrl,
        error instanceof Error ? error.message : String(error)
      );
      return false;
    }
  }

  private async fetchPreviewWasmBlobUrl(previewUrl: string): Promise<string | null> {
    try {
      const wasmUrl = new URL("typst_ts_renderer_bg.wasm", previewUrl.endsWith("/") ? previewUrl : `${previewUrl}/`).href;
      const bytes = await invoke<number[]>("fetch_loopback_resource", { url: wasmUrl });
      const blobUrl = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: "application/wasm" }));
      this.reportDebug(previewUrl, `Fetched preview WASM (${bytes.length} bytes) from ${wasmUrl}; blob=${blobUrl}.`);
      return blobUrl;
    } catch (error) {
      this.reportDebug(previewUrl, `Failed to fetch preview WASM through Tauri: ${String(error)}`);
      return null;
    }
  }

  private async startPreviewWebSocketProxy(previewUrl: string, dataPlaneUrl?: string): Promise<string | undefined> {
    if (!dataPlaneUrl) return undefined;
    try {
      const proxyUrl = await invoke<string>("start_preview_ws_proxy", { targetUrl: dataPlaneUrl });
      this.reportDebug(previewUrl, `Started preview WebSocket proxy: ${proxyUrl} -> ${dataPlaneUrl}.`);
      return proxyUrl;
    } catch (error) {
      this.reportDebug(previewUrl, `Failed to start preview WebSocket proxy for ${dataPlaneUrl}: ${String(error)}`);
      return dataPlaneUrl;
    }
  }

  private showInterceptedPreviewError(iframe: HTMLIFrameElement, previewUrl: string, reason: string): void {
    this.reportDebug(previewUrl, `Showing intercepted preview error: ${reason}`);
    const message = escapeHtml(reason);
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>
      body{margin:0;padding:24px;font:13px/1.5 system-ui,sans-serif;color:#842029;background:#fff5f5}
      code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace}
    </style></head><body>
      <strong>Typstry live preview interception failed.</strong>
      <p>${message}</p>
      <p>The Tinymist preview URL is <code>${escapeHtml(previewUrl)}</code>, but Typstry did not mount it directly because direct mounting disables DOM-based inverse sync.</p>
    </body></html>`;
    try {
      const doc = iframe.contentDocument;
      if (!doc) {
        iframe.srcdoc = html;
        return;
      }
      doc.open("text/html", "replace");
      doc.write(html);
      doc.close();
    } catch {
      iframe.srcdoc = html;
    }
  }

  /**
   * Force a fresh mount even if the URL hasn't changed.
   * Used when the preview content must be reloaded (e.g. after LSP restart).
   */
  public async remount(previewUrl: string, getPreviewHtml: () => Promise<string>): Promise<void> {
    this.mountedUrl = "";
    await this.mount(previewUrl, getPreviewHtml);
  }

  private previewSrcdoc(html: string, previewUrl: string, scriptBlobUrl: string): string {
    const injection = `
<base href="${escapeAttribute(previewUrl.endsWith("/") ? previewUrl : `${previewUrl}/`)}">
<style id="typstry-preview-layout">
  html, body {
    box-sizing: border-box !important;
    min-width: 100% !important;
    min-height: 100% !important;
    background: #d8d8d8 !important;
  }
  body {
    margin: 0 !important;
  }
  #typst-container {
    box-sizing: border-box !important;
    min-width: 100% !important;
    min-height: 100vh !important;
  }
  #typst-container > * {
    margin-left: auto !important;
    margin-right: auto !important;
  }
</style>
<script src="${escapeAttribute(scriptBlobUrl)}"></script>`;
    if (/<head\b[^>]*>/i.test(html)) {
      return html.replace(/<head\b([^>]*)>/i, `<head$1>${injection}`);
    }
    return `<!doctype html><html><head>${injection}</head><body>${html}</body></html>`;
  }

  private previewBootstrapScript(previewUrl: string, dataPlaneUrl?: string): string {
    return `
(() => {
  window.addEventListener("wheel", event => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, { capture: true, passive: false });
  const postStatus = (kind, message, extra) => {
    try {
      parent.postMessage({
        typstryPreviewStatus: kind,
        message: String(message || ""),
        ...(extra || {})
      }, "*");
    } catch {}
  };
  const reportDebug = message => postStatus("debug", message);
  window.__typstryPreviewDebug = reportDebug;
  const reportRuntimeError = (message, source, lineno, colno) => {
    postStatus("runtime-error", String(message || "unknown error"), {
      source: source ? String(source) : "",
      lineno: typeof lineno === "number" ? lineno : undefined,
      colno: typeof colno === "number" ? colno : undefined
    });
  };
  window.addEventListener("error", event => {
    reportRuntimeError(event.message || (event.error && (event.error.stack || event.error.message)), event.filename, event.lineno, event.colno);
  });
  window.addEventListener("unhandledrejection", event => {
    const reason = event.reason;
    reportRuntimeError(reason && (reason.stack || reason.message) || reason);
  });
  const nativeFetch = window.fetch.bind(window);
  window.fetch = (...args) => {
    const target = args[0] && typeof args[0] === "object" && "url" in args[0] ? args[0].url : args[0];
    const targetText = String(target);
    const displayTarget = targetText.startsWith("data:application/wasm;base64,")
      ? "data:application/wasm;base64,...(" + targetText.length + " chars)"
      : targetText;
    reportDebug("fetch requested: " + displayTarget);
    if (targetText.startsWith("data:application/wasm;base64,")) {
      try {
        const base64 = targetText.slice("data:application/wasm;base64,".length);
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) {
          bytes[index] = binary.charCodeAt(index);
        }
        reportDebug("fetch synthesized WASM response: " + bytes.length + " bytes");
        return Promise.resolve(new Response(bytes, {
          status: 200,
          headers: { "Content-Type": "application/wasm" }
        }));
      } catch (error) {
        reportDebug("fetch synthesized WASM response failed: " + String(error && (error.stack || error.message) || error));
        return Promise.reject(error);
      }
    }
    return nativeFetch(...args).then(
      response => {
        reportDebug("fetch response: " + displayTarget + " status=" + response.status + " ok=" + response.ok + " type=" + response.type);
        return response;
      },
      error => {
        reportDebug("fetch failed: " + displayTarget + " error=" + String(error && (error.stack || error.message) || error));
        throw error;
      }
    );
  };
  const previewBase = ${JSON.stringify(previewUrl)};
  const dataPlane = ${JSON.stringify(dataPlaneUrl ?? "")};
  const NativeWebSocket = window.WebSocket;
  window.WebSocket = function(url, protocols) {
    let next = url;
    try {
      const parsed = new URL(String(url), previewBase);
      if (parsed.protocol === "ws:" || parsed.protocol === "wss:") {
        if (dataPlane) {
          const base = new URL(dataPlane);
          base.pathname = parsed.pathname;
          base.search = parsed.search;
          base.hash = parsed.hash;
          next = base.href;
        } else if (parsed.host === location.host) {
          const base = new URL(previewBase);
          parsed.host = base.host;
          next = parsed.href;
        } else {
          next = parsed.href;
        }
      }
    } catch {}
    reportDebug("WebSocket requested: " + String(url) + " -> " + String(next));
    const socket = protocols === undefined ? new NativeWebSocket(next) : new NativeWebSocket(next, protocols);
    socket.addEventListener("open", () => reportDebug("WebSocket open: " + String(next)));
    socket.addEventListener("error", () => reportDebug("WebSocket error: " + String(next)));
    socket.addEventListener("close", event => reportDebug("WebSocket close: " + String(next) + " code=" + event.code + " reason=" + event.reason));
    return socket;
  };
  window.WebSocket.prototype = NativeWebSocket.prototype;
  for (const key of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) {
    Object.defineProperty(window.WebSocket, key, { value: NativeWebSocket[key], configurable: true });
  }
  const summarizeDom = label => {
    try {
      const container = document.getElementById("typst-container");
      const bodyText = (document.body && document.body.innerText || "").replace(/\\s+/g, " ").slice(0, 120);
      reportDebug(
        "DOM " + label
        + ": readyState=" + document.readyState
        + ", bodyChildren=" + (document.body ? document.body.children.length : -1)
        + ", containerChildren=" + (container ? container.children.length : -1)
        + ", svg=" + document.querySelectorAll("svg").length
        + ", canvas=" + document.querySelectorAll("canvas").length
        + ", textSample=\\"" + bodyText + "\\""
      );
    } catch (error) {
      reportDebug("DOM " + label + " summary failed: " + String(error));
    }
  };
  let typstrySawNativeLoad = false;
  window.addEventListener("load", () => {
    typstrySawNativeLoad = true;
    summarizeDom("native-load");
  });
  window.setTimeout(() => summarizeDom("250ms"), 250);
  window.setTimeout(() => {
    const container = document.getElementById("typst-container");
    const hasRenderedPreview = document.querySelector("svg,canvas") || (container && container.children.length > 0);
    if (typstrySawNativeLoad || hasRenderedPreview) {
      reportDebug(
        "Skipping synthetic load event for Tinymist preview startup; nativeLoad="
        + typstrySawNativeLoad
        + ", hasRenderedPreview="
        + Boolean(hasRenderedPreview)
      );
      return;
    }
    reportDebug("Dispatching synthetic load event for Tinymist preview startup because native load was not observed.");
    window.dispatchEvent(new Event("load"));
  }, 500);
  window.setTimeout(() => summarizeDom("1000ms"), 1000);
  window.setTimeout(() => summarizeDom("3000ms"), 3000);
})();
`;
  }

  private sanitizePreviewHtml(html: string): string {
    return html.replace(
      'const escapeImport = new Function("m", "return import(m)");',
      'const escapeImport = async () => { throw new Error("Node font cache is unavailable in Typstry preview"); };'
    );
  }

  private preparePreviewHtml(html: string, previewUrl: string, dataPlaneUrl?: string, wasmBlobUrl?: string | null): { html: string; scriptBlobUrls: string[] } {
    let prepared = this.sanitizePreviewHtml(html);
    if (dataPlaneUrl) {
      prepared = prepared.replace(/ws:\/\/127\.0\.0\.1:\d+/g, dataPlaneUrl);
    }

    const scriptBlobUrls: string[] = [];
    prepared = prepared.replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (full, attrs: string, body: string) => {
      if (/\bsrc\s*=/i.test(attrs) || !body.trim()) return full;
      const index = scriptBlobUrls.length + 1;
      const patchedBody = this.patchInlinePreviewScript(body, previewUrl, wasmBlobUrl);
      const scriptUrl = URL.createObjectURL(new Blob([`${patchedBody}\n//# sourceURL=typstry-preview-inline-${index}.js\n`], {
        type: attrs.includes("type=\"module\"") || attrs.includes("type='module'") ? "text/javascript" : "text/javascript"
      }));
      scriptBlobUrls.push(scriptUrl);
      this.reportDebug(this.mountedUrl, `Externalized Tinymist inline script ${index} (${body.length} chars, patched ${patchedBody.length} chars).`);
      return `<script${attrs} src="${escapeAttribute(scriptUrl)}"></script>`;
    });

    return { html: prepared, scriptBlobUrls };
  }

  private patchInlinePreviewScript(body: string, previewUrl: string, wasmBlobUrl?: string | null): string {
    const wasmUrl = wasmBlobUrl ?? new URL("typst_ts_renderer_bg.wasm", previewUrl.endsWith("/") ? previewUrl : `${previewUrl}/`).href;
    return body
      .replace(
        /module_or_path\s*=\s*importWasmModule\("typst_ts_renderer_bg\.wasm",\s*import\.meta\.url\);/g,
        `module_or_path = ${JSON.stringify(wasmUrl)}; window.__typstryPreviewDebug && window.__typstryPreviewDebug("Tinymist WASM module path patched: " + module_or_path);`
      )
      .replace(
        'const escapeImport = new Function("m", "return import(m)");',
        'const escapeImport = async () => { throw new Error("Node import is unavailable in Typstry preview"); };'
      );
  }

  /**
   * Clear the preview pane and reset state.
   */  public clearErrorOverlay(): void {
    if (this.errorOverlay) {
      this.errorOverlay.remove();
      this.errorOverlay = null;
    }
    if (this.iframe) {
      try {
        const doc = this.iframe.contentDocument;
        const target = doc?.body ?? doc?.documentElement as HTMLElement | null;
        if (target) {
          target.style.overflow = "";
        }
      } catch {}
    }
  }

  /**
   * Clear the preview pane and reset state.
   */
  public clear(): void {
    this.clearErrorOverlay();
    for (const item of this.sessions.values()) {
      if (item.blobUrl) URL.revokeObjectURL(item.blobUrl);
      for (const url of item.scriptBlobUrls ?? []) URL.revokeObjectURL(url);
    }
    this.pane.innerHTML = "";
    this.sessions.clear();
    this.scrollPositions.clear();
    this.zoomBySession.clear();
    this.iframe = null;
    this.svgIframe = null;
    this.mountedUrl = "";
    this.activeSessionKey = "";
    this.previewZoomPercent = 100;
  }

  public mountSvgPages(pages: readonly string[]): void {
    this.clearSvg();
    this.clearErrorOverlay();
    for (const item of this.sessions.values()) {
      item.iframe.classList.add("hidden");
    }
    this.activeSessionKey = "";
    
    const iframe = document.createElement("iframe");
    iframe.className = "preview-frame";
    iframe.sandbox.add("allow-same-origin");
    iframe.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><style>
      html,body{margin:0;min-height:100%;background:#d8d8d8}body{padding:24px;box-sizing:border-box}
      .page{display:block;margin:0 auto 24px;max-width:100%;height:auto;box-shadow:0 2px 10px rgba(0,0,0,.2)}
    </style></head><body>${pages.map(page => page.replace("<svg", '<svg class="page"')).join("")}</body></html>`;
    this.pane.appendChild(iframe);
    this.svgIframe = iframe;
    this.iframe = iframe;
    this.mountedUrl = "";
  }

  public setLoading(message: string): void {
    this.clearSvg();
    this.clearErrorOverlay();
    for (const item of this.sessions.values()) item.iframe.classList.add("hidden");
    this.activeSessionKey = "";
    
    const div = document.createElement("div");
    div.className = "compiler-preview-message";
    div.textContent = message;
    this.pane.appendChild(div);
    // Cast div to HTMLIFrameElement since we're using svgIframe to track it (it just needs a .remove() method)
    this.svgIframe = div as unknown as HTMLIFrameElement;
  }

  public setError(title: string, message: string): void {
    this.clearSvg();
    this.clearErrorOverlay();
    
    const overlay = document.createElement("div");
    overlay.className = "compiler-preview-error-overlay";
    overlay.addEventListener("wheel", (e) => e.preventDefault(), { passive: false });
    overlay.addEventListener("touchmove", (e) => e.preventDefault(), { passive: false });
    
    const content = document.createElement("div");
    content.className = "compiler-preview-error-content";
    
    const titleEl = document.createElement("h3");
    titleEl.className = "compiler-preview-error-title";
    titleEl.textContent = `ⓧ ${title}`;
    
    const pre = document.createElement("pre");
    pre.className = "compiler-preview-error-message";
    pre.textContent = message;
    
    content.append(titleEl, pre);
    overlay.append(content);
    
    this.pane.appendChild(overlay);
    this.errorOverlay = overlay;

    if (this.iframe) {
      try {
        const doc = this.iframe.contentDocument;
        const target = doc?.body ?? doc?.documentElement as HTMLElement | null;
        if (target) {
          target.style.overflow = "hidden";
        }
      } catch {}
    }
  }

  public setMessage(html: string): void {
    this.clearSvg();
    this.clearErrorOverlay();
    for (const item of this.sessions.values()) item.iframe.classList.add("hidden");
    this.activeSessionKey = "";
    
    const div = document.createElement("div");
    div.className = "preview-message-host";
    div.innerHTML = html;
    this.pane.appendChild(div);
    this.svgIframe = div as unknown as HTMLIFrameElement;
  }

  private clearSvg(): void {
    if (this.svgIframe) {
      this.svgIframe.remove();
      this.svgIframe = null;
    }
  }

  private zoomPreview(direction: "in" | "out"): number {
    if (this.errorOverlay) {
      this.reportDebug(this.mountedUrl, `Preview zoom ${direction} ignored because there is an active preview error.`);
      return this.previewZoomPercent;
    }
    if (!this.mountedUrl) {
      this.reportDebug(this.mountedUrl, `Preview zoom ${direction} ignored because live preview is not active.`);
      return this.previewZoomPercent;
    }

    const factors = [
      10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 130, 150, 170, 190, 210,
      240, 270, 300, 330, 370, 410, 460, 510, 570, 630, 700, 770, 850, 940, 1000
    ];
    const current = this.previewZoomPercent;
    const next = direction === "in"
      ? factors.find(factor => factor > current) ?? current
      : [...factors].reverse().find(factor => factor < current) ?? current;
    if (next === current) return current;

    const iframe = this.iframe;
    const doc = iframe?.contentDocument;
    const target = doc?.body ?? doc?.documentElement;
    if (!iframe?.contentWindow || !doc || !target) {
      this.reportDebug(this.mountedUrl, `Preview zoom ${direction} ignored because the preview document is unavailable.`);
      return current;
    }

    const isMac = navigator.userAgent.toLowerCase().includes("mac");
    const event = new KeyboardEvent("keydown", {
      key: direction === "in" ? "=" : "-",
      code: direction === "in" ? "Equal" : "Minus",
      bubbles: true,
      cancelable: true,
      ctrlKey: !isMac,
      metaKey: isMac
    });
    const handled = !target.dispatchEvent(event) || event.defaultPrevented;
    if (!handled) {
      this.reportDebug(this.mountedUrl, `Preview zoom ${direction} key event was not handled by Tinymist.`);
      return current;
    }

    this.previewZoomPercent = next;
    if (this.activeSessionKey) this.zoomBySession.set(this.activeSessionKey, next);
    this.onZoomChanged?.(next);
    this.reportDebug(this.mountedUrl, `Preview zoom ${direction}: estimated ${next}%.`);
    return next;
  }

  private scheduleInitialZoom(iframe: HTMLIFrameElement, sessionKey: string, attempt = 0): void {
    if (this.zoomBySession.has(sessionKey)) return;
    window.setTimeout(() => {
      const session = this.sessions.get(sessionKey);
      if (!session || session.iframe !== iframe || this.zoomBySession.has(sessionKey)) return;
      if (this.activeSessionKey !== sessionKey || this.iframe !== iframe) return;

      const doc = iframe.contentDocument;
      const rendered = doc?.querySelector("#typst-container svg, #typst-container canvas, #typst-container > *");
      if (!rendered) {
        if (attempt < 12) this.scheduleInitialZoom(iframe, sessionKey, attempt + 1);
        return;
      }

      this.previewZoomPercent = 100;
      const zoom = this.zoomPreview("out");
      if (zoom !== DEFAULT_PREVIEW_ZOOM_PERCENT && attempt < 12) {
        this.scheduleInitialZoom(iframe, sessionKey, attempt + 1);
      }
    }, attempt === 0 ? 250 : 150);
  }


  private evictInactiveSessions(): void {
    while (this.sessions.size > this.maxSessions) {
      const candidate = [...this.sessions.entries()]
        .filter(([key]) => key !== this.activeSessionKey)
        .sort((left, right) => left[1].usedAt - right[1].usedAt)[0];
      if (!candidate) return;
      if (candidate[1].blobUrl) URL.revokeObjectURL(candidate[1].blobUrl);
      for (const url of candidate[1].scriptBlobUrls ?? []) URL.revokeObjectURL(url);
      candidate[1].iframe.remove();
      this.sessions.delete(candidate[0]);
    }
  }

  private captureActiveScroll(): void {
    const active = this.sessions.get(this.activeSessionKey);
    if (!active) return;
    const scrollingElement = active.iframe.contentDocument?.scrollingElement;
    if (!scrollingElement) return;
    this.scrollPositions.set(active.scrollKey, {
      top: scrollingElement.scrollTop,
      left: scrollingElement.scrollLeft
    });
  }

  private restoreScroll(session: { iframe: HTMLIFrameElement; scrollKey: string }): void {
    const position = this.scrollPositions.get(session.scrollKey);
    if (!position) return;
    window.setTimeout(() => {
      const scrollingElement = session.iframe.contentDocument?.scrollingElement;
      scrollingElement?.scrollTo(position.left, position.top);
    }, 0);
  }

  private configureDocument(iframe: HTMLIFrameElement): void {
    try {
      const doc = iframe.contentDocument;
      if (!doc) {
        this.reportInteractionStatus({ kind: "blocked", url: iframe.src, reason: "contentDocument unavailable" });
        return;
      }
      if (doc.documentElement.dataset.typstryInteractions === "true") {
        this.reportInteractionStatus({ kind: "installed", url: iframe.src });
        return;
      }
      doc.documentElement.dataset.typstryInteractions = "true";
      doc.addEventListener("click", event => {
        const point = this.textPointFromMouseEvent(doc, event);
        if (point) this.onTextClick(point);
      }, true);
      doc.addEventListener("wheel", event => {
        if (!event.ctrlKey && !event.metaKey) return;
        event.preventDefault();
        event.stopImmediatePropagation();
      }, { capture: true, passive: false });
      doc.addEventListener("contextmenu", event => event.preventDefault());
      this.reportInteractionStatus({ kind: "installed", url: iframe.src });
    } catch (error) {
      this.reportInteractionStatus({
        kind: "blocked",
        url: iframe.src,
        reason: error instanceof Error ? error.message : String(error)
      });
      // Cross-origin preview pages keep their own interaction handling.
    }
  }

  private reportInteractionStatus(status: PreviewInteractionStatus): void {
    const key = `${status.kind}:${status.url}:${status.reason ?? ""}`;
    if (key === this.lastInteractionStatusKey) return;
    this.lastInteractionStatusKey = key;
    this.onInteractionStatus?.(status);
  }

  private reportDebug(url: string, reason: string): void {
    this.reportInteractionStatus({ kind: "debug", url, reason });
  }

  private scheduleDocumentProbe(iframe: HTMLIFrameElement, previewUrl: string, label: string): void {
    window.setTimeout(() => {
      try {
        const doc = iframe.contentDocument;
        const rect = iframe.getBoundingClientRect();
        this.reportDebug(
          previewUrl,
          `Parent probe ${label}: iframe=${Math.round(rect.width)}x${Math.round(rect.height)}, doc=${doc ? doc.readyState : "missing"}, bodyChildren=${doc?.body?.children.length ?? "n/a"}, text="${(doc?.body?.innerText ?? "").replace(/\s+/g, " ").slice(0, 120)}".`
        );
      } catch (error) {
        this.reportDebug(previewUrl, `Parent probe ${label} failed: ${String(error)}`);
      }
    }, 750);
  }

  private textPointFromMouseEvent(doc: Document, event: MouseEvent): PreviewTextPoint | null {
    const pointDocument = doc as Document & {
      caretRangeFromPoint?: (x: number, y: number) => Range | null;
      caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    };
    const range = pointDocument.caretRangeFromPoint?.(event.clientX, event.clientY);
    if (range?.startContainer.nodeType === Node.TEXT_NODE) {
      return this.textPointFromTextNode(doc, event, range.startContainer, range.startOffset);
    }

    const position = pointDocument.caretPositionFromPoint?.(event.clientX, event.clientY);
    if (position?.offsetNode.nodeType === Node.TEXT_NODE) {
      return this.textPointFromTextNode(doc, event, position.offsetNode, position.offset);
    }

    const text = (event.target as Element | null)?.textContent?.trim();
    return text ? { text, offset: Math.floor(text.length / 2) } : null;
  }

  private textPointFromTextNode(doc: Document, event: MouseEvent, node: Node, nodeOffset: number): PreviewTextPoint {
    const nodeElement = node.parentElement ?? event.target as Element | null;
    const svgText = nodeElement?.closest("text");
    if (svgText?.contains(node)) {
      const linePoint = this.svgLineTextPoint(svgText, node, nodeOffset);
      if (linePoint) return linePoint;
    }

    const container = this.previewTextContainer(doc, event.target as Element | null, node);
    if (!container) return { text: node.textContent ?? "", offset: nodeOffset };

    const walker = doc.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    let offset = 0;
    for (let current = walker.nextNode(); current; current = walker.nextNode()) {
      if (current === node) {
        return {
          text: container.textContent ?? node.textContent ?? "",
          offset: offset + nodeOffset
        };
      }
      offset += current.textContent?.length ?? 0;
    }
    return { text: node.textContent ?? "", offset: nodeOffset };
  }

  private previewTextContainer(doc: Document, target: Element | null, node: Node): Element | null {
    let element = target;
    if (!element || !element.contains(node)) element = node.parentElement;

    let fallback: Element | null = null;
    while (element && element !== doc.body && element !== doc.documentElement) {
      const text = element.textContent ?? "";
      const display = doc.defaultView?.getComputedStyle(element).display ?? "";
      if (
        text.trim().length > 0
        && text.length <= 5000
        && (display === "block" || display === "list-item" || display === "table-cell" || display === "flex" || display === "grid")
      ) {
        return element;
      }
      if (!fallback && text.trim().length > 0 && text.length <= 5000) fallback = element;
      element = element.parentElement;
    }
    return fallback;
  }

  private svgLineTextPoint(textElement: Element, node: Node, nodeOffset: number): PreviewTextPoint | null {
    const svg = textElement.closest("svg");
    if (!svg) return null;
    const clickedRect = textElement.getBoundingClientRect();
    const clickedCenterY = clickedRect.top + clickedRect.height / 2;
    const allTextElements = [...svg.querySelectorAll("text")]
      .map(element => ({
        element,
        text: element.textContent ?? "",
        rect: element.getBoundingClientRect()
      }))
      .filter(item => item.text.length > 0 && item.rect.width > 0 && item.rect.height > 0);

    const yTolerance = Math.max(2, clickedRect.height * 0.75);
    const sameLine = allTextElements
      .filter(item => Math.abs((item.rect.top + item.rect.height / 2) - clickedCenterY) <= Math.max(yTolerance, item.rect.height * 0.75))
      .sort((left, right) => left.rect.left - right.rect.left);
    if (sameLine.length === 0) return null;

    const clickedIndex = sameLine.findIndex(item => item.element === textElement);
    if (clickedIndex === -1) return null;

    const maxLineGap = Math.max(36, clickedRect.height * 3);
    let start = clickedIndex;
    while (start > 0) {
      const gap = sameLine[start].rect.left - sameLine[start - 1].rect.right;
      if (gap > maxLineGap) break;
      start -= 1;
    }
    let end = clickedIndex;
    while (end + 1 < sameLine.length) {
      const gap = sameLine[end + 1].rect.left - sameLine[end].rect.right;
      if (gap > maxLineGap) break;
      end += 1;
    }

    const clickedLocalOffset = this.textOffsetInsideElement(textElement, node, nodeOffset);
    let text = "";
    let offset = 0;
    for (let index = start; index <= end; index += 1) {
      const item = sameLine[index];
      if (index > start && item.rect.left - sameLine[index - 1].rect.right > 1) {
        if (item.element === textElement) offset += 1;
        text += " ";
      }
      if (item.element === textElement) offset += clickedLocalOffset;
      text += item.text;
    }
    return { text, offset };
  }

  private textOffsetInsideElement(element: Element, node: Node, nodeOffset: number): number {
    const doc = element.ownerDocument;
    const walker = doc.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let offset = 0;
    for (let current = walker.nextNode(); current; current = walker.nextNode()) {
      if (current === node) return offset + nodeOffset;
      offset += current.textContent?.length ?? 0;
    }
    return nodeOffset;
  }
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
