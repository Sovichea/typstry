import { describe, expect, test } from "bun:test";
import { EditorState } from "@codemirror/state";
import fixture from "./fixtures/lao/editing.json";
import { createDefaultEditingPolicyRegistry } from "../src/editor/editingPolicies/registry";
import { unicodeGraphemeBoundaries } from "../src/editor/editingPolicies/unicode";

describe("locked Lao portability fixtures", () => {
  test("uses the Unicode grapheme baseline without registering a Lao policy", () => {
    expect(fixture.fixtureVersion).toBe(1);
    const registry = createDefaultEditingPolicyRegistry();
    for (const example of fixture.graphemes) {
      const expected = example.ranges.map(([from, to]) => ({ from, to }));
      expect(unicodeGraphemeBoundaries(example.text)).toEqual(expected);
      expect(registry.boundaries(example.text)).toEqual(expected);
      expect(registry.policyAt(example.text, 0, "forward")).toBeNull();
    }
  });

  test("keeps deletion source-safe without Khmer tailoring", () => {
    const registry = createDefaultEditingPolicyRegistry();
    expect(registry.backwardDeletionRange("ກ່າ", 3)).toEqual({ from: 2, to: 3 });
    expect(registry.forwardDeletionRange("ກ່າ", 0)).toEqual({ from: 0, to: 2 });
    expect(registry.incompleteComposition(EditorState.create({ doc: "ກ່າ" }))).toBeNull();
  });

  test("leaves Khmer ownership unchanged", () => {
    const registry = createDefaultEditingPolicyRegistry();
    expect(registry.policyAt("សម្បត្តិ", 1, "backward")?.id).toBe("khmer");
    expect(registry.policyAt("ພາສາລາວ", 1, "backward")).toBeNull();
  });
});
