// POLICY TEMPLATE — Copy this directory to src/editor/editingPolicies/<script-name>/
// and edit every TODO comment before registering your policy.
//
// This file implements the ScriptEditingPolicy interface for a new complex script.
// The registry validates: contractVersion, id, scripts (ISO 15924), codePointRanges,
// and non-overlapping ownership with other registered policies.
//
// Required methods (no default):
//   shouldMergeBoundary  — when two adjacent code points belong to one editing unit
//   backwardDeletionRange — what Delete-Backward removes at a given cursor offset
//   forwardDeletionRange  — what Delete-Forward removes at a given cursor offset
//
// Optional methods:
//   movementBoundary / selectionBoundary — override grapheme navigation
//   temporaryBoundary    — ephemeral boundary during composition (see composition.ts)
//   incompleteCompositionRange — the incomplete syllable/cluster currently being typed
//   editorExtensions     — CodeMirror extensions (state fields, decorations, event handlers)
//
// OWNERSHIP RULES (enforced by registry.ts):
//   - Each ISO 15924 script code MUST be owned by exactly one registered policy.
//   - Unicode code-point ranges MUST NOT overlap with any other policy's ranges.
//   - Khmer owns Khmr / 0x1780–0x17FF. Do not claim overlapping ranges.
//   - Generic CodeMirror commands MUST NOT contain script-specific branches.
//     All script logic belongs inside this file and its companion composition.ts.

import type { EditingRange, ScriptEditingPolicy } from "../types";
import { codePointAtOffset, previousCodePointOffset } from "../unicode";

// TODO: Replace with your script's name (lowercase, no spaces). Must be unique.
const POLICY_ID = "template-script";

// TODO: Replace with the ISO 15924 four-letter script code(s) this policy owns.
// Examples: "Latn" (Latin), "Cyrl" (Cyrillic), "Arab" (Arabic), "Thai" (Thai)
// Full list: https://www.unicode.org/iso15924/iso15924-codes.html
const OWNED_SCRIPTS: readonly string[] = ["Zzzz"]; // "Zzzz" = Unknown — replace this

// TODO: Declare the inclusive-from / exclusive-to Unicode scalar value ranges
// for every code point this policy handles. Must not overlap with Khmer (0x1780–0x17FF)
// or any other registered policy.
//
// Example for Thai (U+0E00–U+0E7F):
//   { from: 0x0E00, to: 0x0E80 }
//
// You can declare multiple ranges for scripts that span disjoint Unicode blocks.
const OWNED_CODE_POINT_RANGES = [
  { from: 0x0000, to: 0x0001 }, // TODO: Replace with your script's actual code point range(s)
] as const;

// ---------------------------------------------------------------------------
// Helpers — Replace or delete as needed for your script
// ---------------------------------------------------------------------------

function isScriptCodePoint(codePoint: number): boolean {
  // TODO: Return true if the code point belongs to your script.
  // Keep this O(1) — called on every cursor move and deletion.
  return OWNED_CODE_POINT_RANGES.some(r => codePoint >= r.from && codePoint < r.to);
}

// ---------------------------------------------------------------------------
// Policy implementation
// ---------------------------------------------------------------------------

export const templateScriptEditingPolicy: ScriptEditingPolicy = {
  // contractVersion MUST equal SCRIPT_EDITING_POLICY_CONTRACT_VERSION (currently 1).
  // If the registry upgrades the contract version, all policies must update together.
  contractVersion: 1,

  id: POLICY_ID,

  // ISO 15924 script codes this policy exclusively owns.
  scripts: [...OWNED_SCRIPTS],

  // Unicode code-point ranges (inclusive from, exclusive to).
  codePointRanges: [...OWNED_CODE_POINT_RANGES],

  // Optional: CodeMirror extensions (state fields, decorations, view plugins).
  // Import from a companion composition.ts if your script needs transient state.
  // editorExtensions: [templateCompositionBoundaryState],

  // ---------------------------------------------------------------------------
  // shouldMergeBoundary(text, boundary): boolean
  //
  // Called for every raw Unicode grapheme boundary in the document.
  // Return true if the code points on both sides of `boundary` form one
  // indivisible editing unit (e.g., a consonant + dependent vowel cluster).
  //
  // Returning true merges the left and right graphemes into one EditingRange.
  // Returning false keeps them separate.
  //
  // IMPORTANT: Both the left and right code points must belong to this policy
  // (i.e., be in OWNED_CODE_POINT_RANGES). Return false for cross-script boundaries.
  // ---------------------------------------------------------------------------
  shouldMergeBoundary(text: string, boundary: number): boolean {
    const leftOffset = previousCodePointOffset(text, boundary);
    const left = codePointAtOffset(text, leftOffset);
    const right = codePointAtOffset(text, boundary);
    if (left === null || right === null) return false;
    if (!isScriptCodePoint(left) || !isScriptCodePoint(right)) return false;

    // TODO: Add your merge logic here.
    // Example: merge if the right code point is a dependent vowel or diacritic.
    // return isDependentMark(right);
    return false;
  },

  // ---------------------------------------------------------------------------
  // backwardDeletionRange(text, offset): EditingRange | null
  //
  // Return the range [from, to) to DELETE when the user presses Backspace
  // with the cursor at `offset`. The registry falls back to the previous
  // code point if you return null or an invalid range.
  //
  // SAFE DEFAULTS:
  //   - Always return a range whose `to === offset`.
  //   - Never return a range that crosses a surrugate pair mid-character.
  //   - Return null if offset <= 0 (nothing to delete).
  // ---------------------------------------------------------------------------
  backwardDeletionRange(text: string, offset: number): EditingRange | null {
    if (offset <= 0) return null;

    // TODO: Implement script-aware backward deletion.
    // Example: delete a consonant + its COENG subscript form together.
    // See khmer/policy.ts for a reference implementation.

    // Default: delete the previous code point.
    return { from: previousCodePointOffset(text, offset), to: offset };
  },

  // ---------------------------------------------------------------------------
  // forwardDeletionRange(text, offset, nextBoundary): EditingRange | null
  //
  // Return the range [from, to) to DELETE when the user presses Delete (forward)
  // with the cursor at `offset`. `nextBoundary` is the next grapheme boundary
  // as computed by the registry (already merged by shouldMergeBoundary).
  //
  // SAFE DEFAULTS:
  //   - Always return a range whose `from === offset`.
  //   - Return null or { from: offset, to: nextBoundary } for simple cases.
  // ---------------------------------------------------------------------------
  forwardDeletionRange(_text: string, offset: number, nextBoundary: number): EditingRange | null {
    if (nextBoundary <= offset) return null;

    // TODO: Override if forward deletion should consume more than nextBoundary.
    // Most policies can use this default.
    return { from: offset, to: nextBoundary };
  },

  // ---------------------------------------------------------------------------
  // OPTIONAL: movementBoundary / selectionBoundary
  //
  // Override cursor movement (Arrow keys) or selection extension (Shift+Arrow).
  // Return null or unicodeBoundary to accept the default grapheme boundary.
  //
  // movementBoundary?(text, offset, direction, unicodeBoundary): number | null
  // selectionBoundary?(text, offset, direction, unicodeBoundary): number | null
  // ---------------------------------------------------------------------------
};

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------
// In src/editor/editingPolicies/registry.ts, add:
//
//   import { templateScriptEditingPolicy } from "./<script-name>/policy";
//
//   export function createDefaultEditingPolicyRegistry() {
//     const registry = new ScriptEditingPolicyRegistry();
//     registry.register(khmerEditingPolicy);
//     registry.register(templateScriptEditingPolicy); // ← add this line
//     return registry;
//   }
//
// Only add to createDefaultEditingPolicyRegistry() once the acceptance tests pass.
// Keep experimental policies behind a feature flag or settings guard until then.
