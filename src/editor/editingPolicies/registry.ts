import { khmerEditingPolicy } from "./khmer/policy";
import type { EditingDirection, EditingRange, ScriptEditingPolicy } from "./types";
import { codePointAtOffset, previousCodePointOffset, unicodeGraphemeBoundaries } from "./unicode";

export class ScriptEditingPolicyRegistry {
  private readonly policies: ScriptEditingPolicy[] = [];
  private readonly scriptOwners = new Map<string, string>();

  register(policy: ScriptEditingPolicy): void {
    if (this.policies.some(candidate => candidate.id === policy.id)) {
      throw new Error(`Editing policy '${policy.id}' is already registered.`);
    }
    for (const script of policy.scripts) {
      const owner = this.scriptOwners.get(script);
      if (owner) throw new Error(`Unicode script '${script}' is already owned by editing policy '${owner}'.`);
    }
    this.policies.push(policy);
    for (const script of policy.scripts) this.scriptOwners.set(script, policy.id);
  }

  policyAt(text: string, offset: number, direction: EditingDirection): ScriptEditingPolicy | null {
    const target = direction === "backward" ? previousCodePointOffset(text, offset) : offset;
    const codePoint = codePointAtOffset(text, target);
    return codePoint === null ? null : this.policies.find(policy => policy.ownsCodePoint(codePoint)) ?? null;
  }

  boundaries(text: string, temporaryBoundary: number | null = null): EditingRange[] {
    const raw = unicodeGraphemeBoundaries(text);
    const merged: EditingRange[] = [];
    for (const boundary of raw) {
      const previous = merged[merged.length - 1];
      if (previous && this.shouldMerge(text, boundary.from)) previous.to = boundary.to;
      else merged.push({ ...boundary });
    }
    return splitAtBoundary(merged, temporaryBoundary);
  }

  backwardDeletionRange(text: string, offset: number): EditingRange | null {
    const policy = this.policyAt(text, offset, "backward");
    if (policy) return policy.backwardDeletionRange(text, offset);
    if (offset <= 0) return null;
    return { from: previousCodePointOffset(text, offset), to: offset };
  }

  editorExtensions(): Extension[] {
    return this.policies.flatMap(policy => [...(policy.editorExtensions ?? [])]);
  }

  temporaryBoundary(state: EditorState): number | null {
    for (const policy of this.policies) {
      const boundary = policy.temporaryBoundary?.(state) ?? null;
      if (boundary !== null) return boundary;
    }
    return null;
  }

  forwardDeletionRange(text: string, offset: number, temporaryBoundary: number | null = null): EditingRange | null {
    if (offset < 0 || offset >= text.length) return null;
    const nextBoundary = this.boundaries(text, temporaryBoundary)
      .find(boundary => boundary.from <= offset && offset < boundary.to)?.to ?? text.length;
    const policy = this.policyAt(text, offset, "forward");
    if (policy) return policy.forwardDeletionRange(text, offset, nextBoundary);
    return nextBoundary > offset ? { from: offset, to: nextBoundary } : null;
  }

  private shouldMerge(text: string, boundary: number): boolean {
    const leftOffset = previousCodePointOffset(text, boundary);
    const left = codePointAtOffset(text, leftOffset);
    const right = codePointAtOffset(text, boundary);
    if (left === null || right === null) return false;
    const leftPolicy = this.policies.find(policy => policy.ownsCodePoint(left));
    const rightPolicy = this.policies.find(policy => policy.ownsCodePoint(right));
    return leftPolicy !== undefined
      && leftPolicy === rightPolicy
      && leftPolicy.shouldMergeBoundary(text, boundary);
  }
}

function splitAtBoundary(boundaries: EditingRange[], position: number | null): EditingRange[] {
  if (position === null) return boundaries;
  const result: EditingRange[] = [];
  for (const boundary of boundaries) {
    if (boundary.from < position && position < boundary.to) {
      result.push({ from: boundary.from, to: position }, { from: position, to: boundary.to });
    } else {
      result.push(boundary);
    }
  }
  return result;
}

export function createDefaultEditingPolicyRegistry(): ScriptEditingPolicyRegistry {
  const registry = new ScriptEditingPolicyRegistry();
  registry.register(khmerEditingPolicy);
  return registry;
}

export const editingPolicyRegistry = createDefaultEditingPolicyRegistry();
import type { EditorState, Extension } from "@codemirror/state";
