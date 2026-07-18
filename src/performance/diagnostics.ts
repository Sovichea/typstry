export type PerformanceMetricName =
  | "startup.usable-editor"
  | "startup.providers"
  | "diagnostics.first"
  | "preview.compile"
  | "preview.load"
  | "preview.geometry"
  | "preview.canvas-render"
  | "preview.annotation-layer"
  | "preview.first-page"
  | "preview.page-render"
  | "preview.zoom"
  | "preview.recovery"
  | "preview.motion-handler"
  | "preview.motion-settle"
  | "preview.deceleration-prerender"
  | "preview.destination-final-queue"
  | "preview.destination-final-commit"
  | "preview.render-cancel"
  | "preview.render-promote"
  | "language.analysis"
  | "language.scopeParse"
  | "language.providerResolution"
  | "language.completion"
  | "language.inputSource"
  | "memory.heap";

export type PerformanceMetric = {
  name: PerformanceMetricName;
  milliseconds?: number;
  bytes?: number;
  detail?: Record<string, string | number | boolean>;
  recordedAt: number;
};

export type PerformanceSummary = {
  samples: number;
  p50: number;
  p95: number;
  maximum: number;
};

export const PERFORMANCE_BUDGETS = {
  usableEditorMs: 2_500,
  providerInitializationMs: 2_500,
  firstDiagnosticMs: 3_000,
  previewCompileOnePageMs: 2_000,
  previewFirstPageMs: 1_000,
  visiblePageRenderMs: 500,
  zoomSettleMs: 750,
  previewMotionHandlerP95Ms: 8,
  finalDestinationPageP95Ms: 500,
  compilerRecoveryMs: 3_000,
  spellcheckP95Ms: 100,
  suggestionP95Ms: 50,
  maxResidentPdfPages: 7,
  maxQueuedLanguageRequests: 1,
  maxRecordedMetrics: 1_000
} as const;

export class PerformanceDiagnostics {
  private readonly values: PerformanceMetric[] = [];
  private readonly first = new Set<PerformanceMetricName>();

  public constructor(private readonly publish?: (metric: PerformanceMetric) => void) {}

  public record(metric: Omit<PerformanceMetric, "recordedAt">): PerformanceMetric {
    const value = { ...metric, recordedAt: Date.now() };
    this.values.push(value);
    if (this.values.length > PERFORMANCE_BUDGETS.maxRecordedMetrics) {
      this.values.splice(0, this.values.length - PERFORMANCE_BUDGETS.maxRecordedMetrics);
    }
    this.publish?.(value);
    return value;
  }

  public recordFirst(metric: Omit<PerformanceMetric, "recordedAt">): PerformanceMetric | null {
    if (this.first.has(metric.name)) return null;
    this.first.add(metric.name);
    return this.record(metric);
  }

  public snapshot(): readonly PerformanceMetric[] {
    return [...this.values];
  }

  public summary(name: PerformanceMetricName): PerformanceSummary | null {
    const samples = this.values
      .filter(metric => metric.name === name && metric.milliseconds !== undefined)
      .map(metric => metric.milliseconds!);
    if (samples.length === 0) return null;
    return {
      samples: samples.length,
      p50: percentile(samples, 0.5),
      p95: percentile(samples, 0.95),
      maximum: Math.max(...samples)
    };
  }
}

export function percentile(values: readonly number[], percentileValue: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(percentileValue * sorted.length) - 1));
  return sorted[index];
}
