import { describe, expect, test } from "bun:test";
import { EditorState } from "@codemirror/state";
import { ScriptEditingPolicyRegistry, createDefaultEditingPolicyRegistry } from "../src/editor/editingPolicies/registry";
import { khmerEditingPolicy } from "../src/editor/editingPolicies/khmer/policy";
import { khmerCompositionBoundaryState } from "../src/editor/editingPolicies/khmer/composition";
import type { ScriptEditingPolicy } from "../src/editor/editingPolicies/types";

const laoTestPolicy: ScriptEditingPolicy = {
  contractVersion: 1,
  id: "lao-test",
  scripts: ["Laoo"],
  codePointRanges: [{ from: 0x0E80, to: 0x0F00 }],
  shouldMergeBoundary: () => false,
  backwardDeletionRange: (_text, offset) => offset > 0 ? { from: offset - 1, to: offset } : null,
  forwardDeletionRange: (_text, offset, nextBoundary) => nextBoundary > offset
    ? { from: offset, to: nextBoundary }
    : null
};

describe("script editing policy registry", () => {
  test("rejects duplicate policy ids and script ownership", () => {
    const registry = new ScriptEditingPolicyRegistry();
    registry.register(khmerEditingPolicy);
    expect(() => registry.register(khmerEditingPolicy)).toThrow("already registered");

    const duplicateKhmer = { ...laoTestPolicy, id: "other-khmer", scripts: ["Khmr"] };
    expect(() => registry.register(duplicateKhmer)).toThrow("already owned");

    const overlappingKhmer = {
      ...laoTestPolicy,
      id: "overlapping-khmer",
      scripts: ["Mymr"],
      codePointRanges: [{ from: 0x17F0, to: 0x1805 }]
    };
    expect(() => registry.register(overlappingKhmer)).toThrow("overlaps Unicode ownership");
  });

  test("selects exactly one policy from the operation target", () => {
    const registry = createDefaultEditingPolicyRegistry();
    registry.register(laoTestPolicy);
    const text = "A\u1780 B\u0E81";

    expect(registry.policyAt(text, 2, "backward")?.id).toBe("khmer");
    expect(registry.policyAt(text, 4, "forward")?.id).toBe("lao-test");
    expect(registry.policyAt(text, 1, "backward")).toBeNull();
  });

  test("adding another script policy cannot change Khmer boundaries", () => {
    const text = "A \u179F\u1798\u17D2\u1794\u178F\u17D2\u178F\u17B7 \u0E81 B";
    const before = createDefaultEditingPolicyRegistry().boundaries(text);
    const registry = createDefaultEditingPolicyRegistry();
    registry.register(laoTestPolicy);

    expect(registry.boundaries(text)).toEqual(before);
    expect(registry.backwardDeletionRange("\u1798\u17D2\u1794", 3)).toEqual({ from: 1, to: 3 });
  });

  test("never permits a policy to merge across script ownership", () => {
    const registry = createDefaultEditingPolicyRegistry();
    registry.register({ ...laoTestPolicy, shouldMergeBoundary: () => true });
    expect(registry.boundaries("\u0E81\u1780")).toEqual([
      { from: 0, to: 1 },
      { from: 1, to: 2 }
    ]);
  });

  test("validates optional movement hooks against UTF-16 boundaries", () => {
    const registry = createDefaultEditingPolicyRegistry();
    registry.register({
      ...laoTestPolicy,
      movementBoundary: () => 2
    });
    const text = "\u0E81😀";
    expect(registry.movementBoundary(text, 0, "forward", 1)).toBe(1);
  });

  test("falls back to Unicode deletion when a policy returns an invalid range", () => {
    const registry = createDefaultEditingPolicyRegistry();
    registry.register({
      ...laoTestPolicy,
      backwardDeletionRange: () => ({ from: -1, to: 1 }),
      forwardDeletionRange: () => ({ from: 1, to: 99 })
    });
    expect(registry.backwardDeletionRange("\u0E81", 1)).toEqual({ from: 0, to: 1 });
    expect(registry.forwardDeletionRange("\u0E81", 0)).toEqual({ from: 0, to: 1 });
  });

  test("exposes a trailing COENG as an incomplete Khmer composition", () => {
    let state = EditorState.create({ doc: "កក", extensions: [khmerCompositionBoundaryState] });
    state = state.update({
      changes: { from: 1, insert: "្" },
      selection: { anchor: 2 },
      userEvent: "input.type"
    }).state;

    expect(createDefaultEditingPolicyRegistry().incompleteComposition(state)).toEqual({
      policyId: "khmer",
      range: { from: 0, to: 2 }
    });
  });
});
