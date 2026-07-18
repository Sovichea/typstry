import { describe, expect, test } from "bun:test";
import { PERFORMANCE_BUDGETS, PerformanceDiagnostics, percentile } from "../src/performance/diagnostics";

describe("performance diagnostics", () => {
  test("records first-use milestones once", () => {
    const published: string[] = [];
    const diagnostics = new PerformanceDiagnostics(metric => published.push(metric.name));
    expect(diagnostics.recordFirst({ name: "diagnostics.first", milliseconds: 20 })).not.toBeNull();
    expect(diagnostics.recordFirst({ name: "diagnostics.first", milliseconds: 30 })).toBeNull();
    expect(published).toEqual(["diagnostics.first"]);
  });

  test("computes an upper-rank p95 without mutating samples", () => {
    const samples = [4, 1, 3, 2, 100];
    expect(percentile(samples, 0.95)).toBe(100);
    expect(samples).toEqual([4, 1, 3, 2, 100]);
  });

  test("reports bounded rolling summaries by metric", () => {
    const diagnostics = new PerformanceDiagnostics();
    for (const milliseconds of [4, 1, 3, 2, 100]) {
      diagnostics.record({ name: "preview.motion-handler", milliseconds });
    }
    expect(diagnostics.summary("preview.motion-handler")).toEqual({
      samples: 5,
      p50: 3,
      p95: 100,
      maximum: 100
    });
    expect(diagnostics.summary("preview.motion-settle")).toBeNull();
  });

  test("keeps resident PDF pages and queued language work explicitly bounded", () => {
    expect(PERFORMANCE_BUDGETS.maxResidentPdfPages).toBeLessThanOrEqual(7);
    expect(PERFORMANCE_BUDGETS.maxQueuedLanguageRequests).toBe(1);
  });

  test("bounds retained performance samples", () => {
    const diagnostics = new PerformanceDiagnostics();
    for (let index = 0; index < PERFORMANCE_BUDGETS.maxRecordedMetrics + 25; index++) {
      diagnostics.record({ name: "memory.heap", bytes: index });
    }
    const snapshot = diagnostics.snapshot();
    expect(snapshot).toHaveLength(PERFORMANCE_BUDGETS.maxRecordedMetrics);
    expect(snapshot[0].bytes).toBe(25);
  });
});
