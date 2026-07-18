import { describe, expect, test } from "bun:test";
import { PreviewMotionController } from "../src/preview/previewMotion";
import { PreviewRenderScheduler } from "../src/preview/previewRenderScheduler";
import { PreviewPageRenderOwnership } from "../src/preview/previewPageRenderOwnership";

describe("PDF preview motion", () => {
  test("settles after three stable frames and acts on the first", () => {
    const motion = new PreviewMotionController();
    motion.reset(0, 0);
    expect(motion.noteScroll(100, 10).state).toBe("moving");
    const first = motion.sampleFrame(100, 26);
    expect(first.state).toBe("settling");
    expect(first.firstStableFrame).toBe(true);
    expect(motion.sampleFrame(100, 42).becameIdle).toBe(false);
    expect(motion.sampleFrame(100, 58).becameIdle).toBe(true);
  });

  test("re-grab and direction reversal reset settling", () => {
    const motion = new PreviewMotionController();
    motion.noteScroll(100, 10);
    motion.sampleFrame(100, 26);
    const reversed = motion.noteScroll(80, 30);
    expect(reversed.state).toBe("moving");
    expect(reversed.direction).toBe(-1);
    expect(reversed.stableFrames).toBe(0);
  });

  test("does not declare the destination idle while the scrollbar pointer is held", () => {
    const motion = new PreviewMotionController();
    motion.noteScroll(200, 10);
    motion.setPointerDown(true);
    motion.sampleFrame(200, 26);
    motion.sampleFrame(200, 42);
    expect(motion.sampleFrame(200, 58).becameIdle).toBe(false);
    motion.setPointerDown(false);
    expect(motion.sampleFrame(200, 74).becameIdle).toBe(true);
  });

  test("settles after a bounded fallback when native scrollbar pointerup is lost", () => {
    const motion = new PreviewMotionController();
    motion.noteScroll(200, 10);
    motion.setPointerDown(true);
    for (const timestamp of [26, 42, 58, 74, 90]) {
      expect(motion.sampleFrame(200, timestamp).becameIdle).toBe(false);
    }
    expect(motion.sampleFrame(200, 106).becameIdle).toBe(true);
  });

  test("predicts the stopping position after sustained gesture deceleration", () => {
    const motion = new PreviewMotionController();
    motion.reset(0, 0);
    expect(motion.noteScroll(10, 10).phase).toBe("accelerating");
    expect(motion.noteScroll(30, 20).phase).toBe("accelerating");
    expect(motion.noteScroll(48, 30).shouldPreRender).toBe(false);
    const decelerating = motion.noteScroll(64, 40);
    expect(decelerating.phase).toBe("decelerating");
    expect(decelerating.deceleratingSamples).toBe(2);
    expect(decelerating.shouldPreRender).toBe(true);
    expect(decelerating.projectedScrollTop).toBeGreaterThan(decelerating.scrollTop);
  });

  test("stops pre-rendering when a gesture accelerates or reverses", () => {
    const motion = new PreviewMotionController();
    motion.reset(0, 0);
    motion.noteScroll(10, 10);
    motion.noteScroll(30, 20);
    motion.noteScroll(48, 30);
    expect(motion.noteScroll(64, 40).shouldPreRender).toBe(true);
    const accelerated = motion.noteScroll(84, 50);
    expect(accelerated.phase).toBe("accelerating");
    expect(accelerated.shouldPreRender).toBe(false);
    const reversed = motion.noteScroll(74, 60);
    expect(reversed.direction).toBe(-1);
    expect(reversed.shouldPreRender).toBe(false);
  });

  test("does not pre-render during a held scrollbar drag", () => {
    const motion = new PreviewMotionController();
    motion.reset(0, 0);
    motion.noteScroll(10, 10);
    motion.noteScroll(30, 20);
    motion.noteScroll(48, 30);
    motion.setPointerDown(true);
    expect(motion.noteScroll(64, 40).shouldPreRender).toBe(false);
  });
});

describe("PDF preview render scheduler", () => {
  test("promotes duplicate requests and preserves priority order", () => {
    const scheduler = new PreviewRenderScheduler();
    expect(scheduler.enqueue({ generation: 1, pageNo: 3, priority: 4, reason: "directional-neighbor" })).toBe("queued");
    expect(scheduler.enqueue({ generation: 1, pageNo: 3, priority: 0, reason: "settled-visible" })).toBe("promoted");
    scheduler.enqueue({ generation: 1, pageNo: 2, priority: 1, reason: "decelerating-destination" });
    expect(scheduler.take()?.pageNo).toBe(3);
    expect(scheduler.take()?.pageNo).toBe(2);
    expect(scheduler.size).toBe(0);
  });

  test("can take only settled work while motion is stabilizing", () => {
    const scheduler = new PreviewRenderScheduler();
    scheduler.enqueue({ generation: 1, pageNo: 1, priority: 0, reason: "settled-visible" });
    scheduler.enqueue({ generation: 1, pageNo: 2, priority: 1, reason: "directional-neighbor" });
    expect(scheduler.take(request => request.reason === "settled-visible")?.pageNo).toBe(1);
    expect(scheduler.size).toBe(1);
  });

  test("drops obsolete visible work when interaction resumes", () => {
    const scheduler = new PreviewRenderScheduler();
    scheduler.enqueue({ generation: 1, pageNo: 4, priority: 4, reason: "directional-neighbor" });
    scheduler.enqueue({ generation: 1, pageNo: 8, priority: 0, reason: "settled-visible" });
    scheduler.removeReason("directional-neighbor");
    expect(scheduler.size).toBe(1);
    expect(scheduler.take()?.pageNo).toBe(8);
  });
});

describe("PDF page render ownership", () => {
  test("cleans a shared PDF page only after its last render settles", () => {
    let cleanups = 0;
    const page = { cleanup: () => { cleanups += 1; } };
    const ownership = new PreviewPageRenderOwnership<typeof page>();
    ownership.retain(page);
    ownership.retain(page);
    ownership.release(page);
    expect(ownership.count(page)).toBe(1);
    expect(cleanups).toBe(0);
    ownership.release(page);
    expect(ownership.count(page)).toBe(0);
    expect(cleanups).toBe(1);
    ownership.release(page);
    expect(cleanups).toBe(1);
  });
});
