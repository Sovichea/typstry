export type PerformanceMetricName =
  | "startup.usable-editor"
  | "startup.providers"
  | "diagnostics.first"
  | "preview.compile"
  | "preview.load"
  | "preview.first-page"
  | "preview.page-render"
  | "preview.zoom"
  | "preview.recovery"
  | "language.analysis"
  | "memory.heap";

export type PerformanceMetric = {
  name: PerformanceMetricName;
  milliseconds?: number;
  bytes?: number;
  detail?: Record<string, string | number | boolean>;
  recordedAt: number;
};

export const PERFORMANCE_BUDGETS = {
  usableEditorMs: 2_500,
  providerInitializationMs: 2_500,
  firstDiagnosticMs: 3_000,
  previewCompileOnePageMs: 2_000,
  previewFirstPageMs: 1_000,
  visiblePageRenderMs: 500,
  zoomSettleMs: 750,
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
}

export function percentile(values: readonly number[], percentileValue: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(percentileValue * sorted.length) - 1));
  return sorted[index];
}
