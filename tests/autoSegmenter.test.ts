import { afterAll, beforeAll, describe, expect, mock, test, afterEach } from "bun:test";
import { Text, EditorState, Annotation } from "@codemirror/state";
import { EditorView, type ViewUpdate } from "@codemirror/view";

type Invocation = { command: string; resolve: (value: unknown) => void; reject: (error: unknown) => void; args?: any };
const invocations: Invocation[] = [];

mock.module("@tauri-apps/api/core", () => ({
  invoke: (command: string, args?: any) => {
    return new Promise((resolve, reject) => invocations.push({ command, resolve, reject, args }));
  }
}));

const wait = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));

const originalDocument = globalThis.document;
const originalWindow = (globalThis as any).window;

beforeAll(() => {
  Object.assign(globalThis, {
    document: {
      createElement: () => ({}),
      body: { appendChild() {}, style: {} },
      documentElement: { style: {} }
    },
    window: Object.assign(globalThis, { innerWidth: 1200, innerHeight: 800 })
  });
});

afterAll(() => {
  Object.assign(globalThis, { document: originalDocument, window: originalWindow });
});

let activeSegmenter: any = null;

describe("autoSegmenter", () => {
  afterEach(() => {
    if (activeSegmenter && activeSegmenter.timer !== null) {
      clearTimeout(activeSegmenter.timer);
      activeSegmenter.timer = null;
    }
    activeSegmenter = null;
    invocations.length = 0;
  });

  test("coalesces and analyzes Khmer text updates", async () => {
    const { AutoSegmenterClass } = await import("../src/editor/autoSegmenter");

    let dispatchedChanges: any = null;
    const viewMock = {
      state: {
        doc: Text.of(["សាលារៀន"]),
        selection: { main: { head: 8 } }
      },
      dispatch(spec: any) {
        dispatchedChanges = spec.changes;
      }
    };

    const segmenter = new AutoSegmenterClass(viewMock as any);
    activeSegmenter = segmenter;
    
    // Simulate document update with changed range (0 to 8)
    const update = {
      docChanged: true,
      changes: {
        iterChanges(cb: any) {
          cb(0, 0, 0, 8); // Khmer range updated
        },
        mapPos(pos: number) { return pos; }
      },
      state: {
        doc: Text.of(["សាលារៀន"])
      },
      startState: {
        doc: Text.of([""])
      },
      transactions: []
    } as any;

    segmenter.update(update);
    expect(segmenter.pendingRanges).toEqual([{ from: 0, to: 8 }]);

    // Wait for debounced segmentation run (300ms)
    await wait(350);

    expect(invocations.length).toBe(1);
    const req = invocations[0];
    expect(req.command).toBe("analyze_language_ranges");
    expect(req.args.request.chunks).toEqual([{ text: "សាលារៀន", startUtf16: 0 }]);

    // Resolve with tokens
    req.resolve({
      tokens: [
        {
          provider: "khmer-segmenter",
          sourceFromUtf16: 0,
          sourceToUtf16: 4,
          sourceText: "សាលា",
          normalizedText: "សាលា",
          known: true,
          knownPrefix: true
        },
        {
          provider: "khmer-segmenter",
          sourceFromUtf16: 4,
          sourceToUtf16: 8,
          sourceText: "រៀន",
          normalizedText: "រៀន",
          known: true,
          knownPrefix: true
        }
      ]
    });

    await wait(20);

    // Should insert ZWS at offset 4
    expect(dispatchedChanges).toEqual([{ from: 4, to: 4, insert: "\u200b" }]);
  });

  test("injects Soft Hyphens (SHY) inside words when hyphenation is enabled", async () => {
    const { AutoSegmenterClass } = await import("../src/editor/autoSegmenter");

    let dispatchedChanges: any = null;
    const viewMock = {
      state: {
        doc: Text.of([
          "#set text(hyphenate: true)",
          "សាលារៀន"
        ]),
        selection: { main: { head: 40 } }
      },
      dispatch(spec: any) {
        dispatchedChanges = spec.changes;
      }
    };

    const segmenter = new AutoSegmenterClass(viewMock as any);
    activeSegmenter = segmenter;
    
    // Simulate document update with Khmer range
    const startOffset = "#set text(hyphenate: true)\n".length;
    const update = {
      docChanged: true,
      changes: {
        iterChanges(cb: any) {
          cb(startOffset, startOffset, startOffset, startOffset + 8);
        },
        mapPos(pos: number) { return pos; }
      },
      state: {
        doc: viewMock.state.doc
      },
      startState: {
        doc: Text.of([""])
      },
      transactions: []
    } as any;

    segmenter.update(update);
    // Wait for debounced run
    await wait(350);

    expect(invocations.length).toBe(1);
    const req = invocations[0];
    
    // Resolve with tokens containing hyphenated representation
    req.resolve({
      tokens: [
        {
          provider: "khmer-segmenter",
          sourceFromUtf16: startOffset,
          sourceToUtf16: startOffset + 4,
          sourceText: "សាលា",
          normalizedText: "សាលា",
          hyphenated: "សា\u00adលា",
          known: true,
          knownPrefix: true
        },
        {
          provider: "khmer-segmenter",
          sourceFromUtf16: startOffset + 4,
          sourceToUtf16: startOffset + 8,
          sourceText: "រៀន",
          normalizedText: "រៀន",
          known: true,
          knownPrefix: true
        }
      ]
    });

    await wait(20);

    // Expected changes: 
    // 1. replace "សាលា" with "សា\u00adលា" (syllable hyphens inside token)
    // 2. insert ZWS at startOffset + 4 (word separator)
    expect(dispatchedChanges).toEqual([
      { from: startOffset + 4, to: startOffset + 4, insert: "\u200b" },
      { from: startOffset, to: startOffset + 4, insert: "សា\u00adលា" }
    ]);
  });

  test("re-segments entire document when hyphenation setting changes", async () => {
    const { AutoSegmenterClass } = await import("../src/editor/autoSegmenter");

    const viewMock = {
      state: {
        doc: Text.of([
          "#set text(hyphenate: true)",
          "សាលារៀន"
        ]),
        selection: { main: { head: 40 } }
      },
      dispatch() {}
    };

    const segmenter = new AutoSegmenterClass(viewMock as any);
    activeSegmenter = segmenter;
    
    // Start state had no hyphenation setting
    const update = {
      docChanged: true,
      changes: {
        iterChanges() {}, // No Khmer ranges edited directly
        mapPos(pos: number) { return pos; }
      },
      state: {
        doc: viewMock.state.doc
      },
      startState: {
        doc: Text.of([
          "#set text(hyphenate: false)",
          "សាលារៀន"
        ])
      },
      transactions: []
    } as any;

    segmenter.update(update);
    // Since hyphenate state changed (false -> true), pendingRanges should cover the whole doc (from 0 to doc.length)!
    expect(segmenter.pendingRanges).toEqual([{ from: 0, to: viewMock.state.doc.length }]);
  });

  test("removes all ZWS and SHY and skips backend call when // @disable-zws is present", async () => {
    const { AutoSegmenterClass } = await import("../src/editor/autoSegmenter");

    let dispatchedChanges: any = null;
    const viewMock = {
      state: {
        doc: Text.of([
          "// @disable-zws",
          "សា\u00adលា\u200bរៀន"
        ]),
        selection: { main: { head: 40 } }
      },
      dispatch(spec: any) {
        dispatchedChanges = spec.changes;
        // Update document state after changes applied
        viewMock.state.doc = Text.of([
          "// @disable-zws",
          "សាលារៀន"
        ]);
      }
    };

    const segmenter = new AutoSegmenterClass(viewMock as any);
    activeSegmenter = segmenter;
    
    // Simulate adding the directive
    const update = {
      docChanged: true,
      changes: {
        iterChanges() {},
        mapPos(pos: number) { return pos; }
      },
      state: {
        doc: viewMock.state.doc
      },
      startState: {
        doc: Text.of([
          "សាលារៀន"
        ])
      },
      transactions: []
    } as any;

    segmenter.update(update);
    expect(segmenter.pendingRanges).toEqual([{ from: 0, to: viewMock.state.doc.length }]);

    // Wait for debounced run
    await wait(350);

    // It should NOT make any backend calls!
    expect(invocations.length).toBe(0);

    // It should dispatch removals of ZWS and SHY!
    // Offset of "សា\u00adលា\u200bរៀន" starts at "// @disable-zws\n".length = 16.
    // In "សា\u00adលា\u200bរៀន":
    // - SHY (\u00ad) is at index 2 (offset 16 + 2 = 18).
    // - ZWS (\u200b) is at index 5 (offset 16 + 5 = 21).
    expect(dispatchedChanges).toEqual([
      { from: 21, to: 22, insert: "" },
      { from: 18, to: 19, insert: "" }
    ]);
  });

  test("block-scoped hyphenation", async () => {
    const { AutoSegmenterClass } = await import("../src/editor/autoSegmenter");

    const viewMock = {
      state: {
        doc: Text.of([
          "សាលារៀន",
          "[",
          "  #set text(hyphenate: true)",
          "  សាលារៀន",
          "]",
          "សាលារៀន"
        ]),
        selection: { main: { head: 100 } }
      },
      dispatch(spec: any) {
        this.dispatched.push(spec.changes);
      },
      dispatched: [] as any[]
    };

    const segmenter = new AutoSegmenterClass(viewMock as any);
    activeSegmenter = segmenter;

    const update = {
      docChanged: true,
      changes: {
        iterChanges(cb: any) {
          cb(0, 0, 0, viewMock.state.doc.length);
        },
        mapPos(pos: number) { return pos; }
      },
      state: { doc: viewMock.state.doc },
      startState: { doc: Text.of([""]) },
      transactions: []
    } as any;

    segmenter.update(update);
    await wait(350);

    expect(invocations.length).toBe(1);
    const req = invocations[0];
    
    const contentText = viewMock.state.doc.toString();
    const w1Start = 0;
    const w2Start = contentText.indexOf("សាលារៀន", 1);
    const w3Start = contentText.indexOf("សាលារៀន", w2Start + 1);

    req.resolve({
      tokens: [
        // Word 1: outer (hyphenate: false)
        {
          provider: "khmer-segmenter",
          sourceFromUtf16: w1Start,
          sourceToUtf16: w1Start + 4,
          sourceText: "សាលា",
          normalizedText: "សាលា",
          hyphenated: "សា\u00adលា"
        },
        {
          provider: "khmer-segmenter",
          sourceFromUtf16: w1Start + 4,
          sourceToUtf16: w1Start + 7,
          sourceText: "រៀន",
          normalizedText: "រៀន"
        },
        // Word 2: inner (hyphenate: true)
        {
          provider: "khmer-segmenter",
          sourceFromUtf16: w2Start,
          sourceToUtf16: w2Start + 4,
          sourceText: "សាលា",
          normalizedText: "សាលា",
          hyphenated: "សា\u00adលា"
        },
        {
          provider: "khmer-segmenter",
          sourceFromUtf16: w2Start + 4,
          sourceToUtf16: w2Start + 7,
          sourceText: "រៀន",
          normalizedText: "រៀន"
        },
        // Word 3: outer (hyphenate: false)
        {
          provider: "khmer-segmenter",
          sourceFromUtf16: w3Start,
          sourceToUtf16: w3Start + 4,
          sourceText: "សាលា",
          normalizedText: "សាលា",
          hyphenated: "សា\u00adលា"
        },
        {
          provider: "khmer-segmenter",
          sourceFromUtf16: w3Start + 4,
          sourceToUtf16: w3Start + 7,
          sourceText: "រៀន",
          normalizedText: "រៀន"
        }
      ]
    });

    await wait(20);

    const changeList = viewMock.dispatched[viewMock.dispatched.length - 1];
    // Changes expected:
    // - ZWS injected at w1Start + 4 (Word 1 gap)
    // - ZWS injected at w2Start + 4 (Word 2 gap)
    // - SHY injected inside Word 2: "សាលា" -> "សា\u00adលា" at w2Start
    // - ZWS injected at w3Start + 4 (Word 3 gap)
    // No SHY inside Word 1 or Word 3!
    expect(changeList).toEqual([
      { from: w3Start + 4, to: w3Start + 4, insert: "\u200b" },
      { from: w2Start + 4, to: w2Start + 4, insert: "\u200b" },
      { from: w2Start, to: w2Start + 4, insert: "សា\u00adលា" },
      { from: w1Start + 4, to: w1Start + 4, insert: "\u200b" }
    ]);
  });

  test("block-scoped disable-zws", async () => {
    const { AutoSegmenterClass } = await import("../src/editor/autoSegmenter");

    const viewMock = {
      state: {
        doc: Text.of([
          "សាលារៀន",
          "[",
          "  // @disable-zws",
          "  សាលារៀន",
          "]",
          "សាលារៀន"
        ]),
        selection: { main: { head: 100 } }
      },
      dispatch(spec: any) {
        this.dispatched.push(spec.changes);
      },
      dispatched: [] as any[]
    };

    const segmenter = new AutoSegmenterClass(viewMock as any);
    activeSegmenter = segmenter;

    const update = {
      docChanged: true,
      changes: {
        iterChanges(cb: any) {
          cb(0, 0, 0, viewMock.state.doc.length);
        },
        mapPos(pos: number) { return pos; }
      },
      state: { doc: viewMock.state.doc },
      startState: { doc: Text.of([""]) },
      transactions: []
    } as any;

    segmenter.update(update);
    await wait(350);

    expect(invocations.length).toBe(1);
    const req = invocations[0];

    const contentText = viewMock.state.doc.toString();
    const w1Start = 0;
    const w2Start = contentText.indexOf("សាលារៀន", 1);
    const w3Start = contentText.indexOf("សាលារៀន", w2Start + 1);

    req.resolve({
      tokens: [
        // Word 1: outer (enabled)
        {
          provider: "khmer-segmenter",
          sourceFromUtf16: w1Start,
          sourceToUtf16: w1Start + 4,
          sourceText: "សាលា",
          normalizedText: "សាលា"
        },
        {
          provider: "khmer-segmenter",
          sourceFromUtf16: w1Start + 4,
          sourceToUtf16: w1Start + 7,
          sourceText: "រៀន",
          normalizedText: "រៀន"
        },
        // Word 2: inner (disabled)
        {
          provider: "khmer-segmenter",
          sourceFromUtf16: w2Start,
          sourceToUtf16: w2Start + 4,
          sourceText: "សាលា",
          normalizedText: "សាលា"
        },
        {
          provider: "khmer-segmenter",
          sourceFromUtf16: w2Start + 4,
          sourceToUtf16: w2Start + 7,
          sourceText: "រៀន",
          normalizedText: "រៀន"
        },
        // Word 3: outer (enabled)
        {
          provider: "khmer-segmenter",
          sourceFromUtf16: w3Start,
          sourceToUtf16: w3Start + 4,
          sourceText: "សាលា",
          normalizedText: "សាលា"
        },
        {
          provider: "khmer-segmenter",
          sourceFromUtf16: w3Start + 4,
          sourceToUtf16: w3Start + 7,
          sourceText: "រៀន",
          normalizedText: "រៀន"
        }
      ]
    });

    await wait(20);

    const changeList = viewMock.dispatched[viewMock.dispatched.length - 1];
    // Changes expected:
    // - ZWS injected at w1Start + 4 (Word 1)
    // - ZWS injected at w3Start + 4 (Word 3)
    // - NO ZWS injected at w2Start + 4 (Word 2 is disabled!)
    expect(changeList).toEqual([
      { from: w3Start + 4, to: w3Start + 4, insert: "\u200b" },
      { from: w1Start + 4, to: w1Start + 4, insert: "\u200b" }
    ]);
  });
});
