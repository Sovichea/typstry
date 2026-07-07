import { describe, expect, test } from "bun:test";
import { ScriptEditingPolicyRegistry, createDefaultEditingPolicyRegistry } from "../src/editor/editingPolicies/registry";
import { khmerEditingPolicy } from "../src/editor/editingPolicies/khmer/policy";
import type { ScriptEditingPolicy } from "../src/editor/editingPolicies/types";

const thaiTestPolicy: ScriptEditingPolicy = {
  id: "thai-test",
  scripts: ["Thai"],
  ownsCodePoint: codePoint => codePoint >= 0x0E00 && codePoint <= 0x0E7F,
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

    const duplicateKhmer = { ...thaiTestPolicy, id: "other-khmer", scripts: ["Khmr"] };
    expect(() => registry.register(duplicateKhmer)).toThrow("already owned");
  });

  test("selects exactly one policy from the operation target", () => {
    const registry = createDefaultEditingPolicyRegistry();
    registry.register(thaiTestPolicy);
    const text = "A\u1780 B\u0E01";

    expect(registry.policyAt(text, 2, "backward")?.id).toBe("khmer");
    expect(registry.policyAt(text, 4, "forward")?.id).toBe("thai-test");
    expect(registry.policyAt(text, 1, "backward")).toBeNull();
  });

  test("adding another script policy cannot change Khmer boundaries", () => {
    const text = "A \u179F\u1798\u17D2\u1794\u178F\u17D2\u178F\u17B7 \u0E01 B";
    const before = createDefaultEditingPolicyRegistry().boundaries(text);
    const registry = createDefaultEditingPolicyRegistry();
    registry.register(thaiTestPolicy);

    expect(registry.boundaries(text)).toEqual(before);
    expect(registry.backwardDeletionRange("\u1798\u17D2\u1794", 3)).toEqual({ from: 1, to: 3 });
  });
});
