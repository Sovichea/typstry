export type PreviewRenderReason =
  | "settled-visible"
  | "decelerating-destination"
  | "directional-neighbor";

export type PreviewRenderRequest = {
  generation: number;
  pageNo: number;
  priority: number;
  reason: PreviewRenderReason;
};

function requestKey(request: Pick<PreviewRenderRequest, "generation" | "pageNo">): string {
  return `${request.generation}:${request.pageNo}`;
}

export class PreviewRenderScheduler {
  private readonly requests = new Map<string, PreviewRenderRequest & { sequence: number }>();
  private sequence = 0;

  public enqueue(request: PreviewRenderRequest): "queued" | "promoted" | "unchanged" {
    const key = requestKey(request);
    const existing = this.requests.get(key);
    if (existing) {
      if (request.priority >= existing.priority) return "unchanged";
      this.requests.set(key, { ...request, sequence: existing.sequence });
      return "promoted";
    }
    this.requests.set(key, { ...request, sequence: this.sequence++ });
    return "queued";
  }

  public take(allow: (request: PreviewRenderRequest) => boolean = () => true): PreviewRenderRequest | null {
    let selected: (PreviewRenderRequest & { sequence: number }) | null = null;
    let selectedKey = "";
    for (const [key, request] of this.requests) {
      if (!allow(request)) continue;
      if (!selected || request.priority < selected.priority || (
        request.priority === selected.priority && request.sequence < selected.sequence
      )) {
        selected = request;
        selectedKey = key;
      }
    }
    if (!selected) return null;
    this.requests.delete(selectedKey);
    const { sequence: _, ...request } = selected;
    return request;
  }

  public remove(generation: number, pageNo: number): void {
    this.requests.delete(requestKey({ generation, pageNo }));
  }

  public removeReason(reason: PreviewRenderReason): void {
    for (const [key, request] of this.requests) {
      if (request.reason === reason) this.requests.delete(key);
    }
  }

  public clear(): void {
    this.requests.clear();
  }

  public get size(): number {
    return this.requests.size;
  }
}
