# Script-Aware Editor Policies

Typstry separates editor navigation from spellcheck, completion, and document segmentation. Script editing policies run synchronously in CodeMirror and define safe cursor and deletion behavior for a Unicode script. They do not depend on a dictionary or Rust language provider.

## Architecture

The implementation lives under `src/editor/editingPolicies/`:

```text
types.ts                 shared policy contract
unicode.ts               Unicode grapheme and code-point primitives
registry.ts              ownership, routing, and built-in registration
khmer/policy.ts          pure Khmer boundary and deletion rules
khmer/composition.ts     transient CodeMirror state and visual shaping guard
```

`src/editor/grapheme.ts` is the language-neutral CodeMirror command layer. It asks the registry for boundaries and deletion ranges, handles selections and multiple cursors, merges overlapping changes, and dispatches one transaction.

Each ISO 15924 script code has at most one owner. The registry rejects duplicate policy IDs and duplicate script ownership. At a boundary, tailoring is allowed only when both adjacent code points belong to the same registered policy. This prevents a newly registered policy from changing Khmer clusters.

## Current Khmer behavior

- Left/right movement and shift-selection use Khmer-tailored grapheme boundaries.
- Backspace deletes one Unicode code point, except `COENG + consonant`, which is one deletion unit.
- Forward Delete removes the complete following Khmer grapheme cluster.
- Typing COENG before an existing consonant creates a temporary composition boundary.
- A transient ZWNJ widget interrupts browser shaping at that boundary without entering the document, LSP input, saved file, or Typst preview.
- When invisible characters are enabled, the ZWNJ widget uses the former SHY marker color. When they are disabled, it retains zero-width cursor geometry so returning to the boundary still shows the caret.
- Cursor and selection movement preserve the temporary boundary. Completing the subscript or editing away its `COENG | consonant` structure clears it; unrelated edits map it to the new UTF-16 position.

Do not replace the transient widget with a persisted ZWNJ and do not normalize or clean source text after an edit. A command must change only its declared deletion range.

## Adding a policy

Create a directory such as `src/editor/editingPolicies/thai/` and implement `ScriptEditingPolicy` from `types.ts`:

```ts
export const thaiEditingPolicy: ScriptEditingPolicy = {
  id: "thai",
  scripts: ["Thai"],

  ownsCodePoint(codePoint) {
    return codePoint >= 0x0E00 && codePoint <= 0x0E7F;
  },

  shouldMergeBoundary(text, boundary) {
    // Return true only when this policy owns both sides and the Unicode
    // baseline split must be tailored for this script.
    return false;
  },

  backwardDeletionRange(text, offset) {
    // Return a line-local, half-open UTF-16 range or null.
    return null;
  },

  forwardDeletionRange(text, offset, nextBoundary) {
    return nextBoundary > offset ? { from: offset, to: nextBoundary } : null;
  }
};
```

Register it explicitly in `createDefaultEditingPolicyRegistry()` in `registry.ts`:

```ts
registry.register(khmerEditingPolicy);
registry.register(thaiEditingPolicy);
```

No generic CodeMirror keybinding change is required.

## Optional composition behavior

Some scripts need transaction-aware behavior that cannot be derived from static text. Keep it inside the script directory as a CodeMirror `StateField`, decoration, or transaction helper. Expose it through the policy:

```ts
editorExtensions: [thaiCompositionState],
temporaryBoundary: getTemporaryThaiBoundary,
```

The registry installs these extensions and queries the active temporary boundary. Runtime widgets must be editor-only and must not modify source text.

## Contract and constraints

- Use UTF-16 offsets because CodeMirror uses UTF-16 positions.
- Never split a surrogate pair.
- Start from the Unicode grapheme baseline and tailor only demonstrated script behavior.
- `scripts` must use unique ISO 15924 codes.
- `ownsCodePoint` must not claim another policy's characters.
- `shouldMergeBoundary` must not merge across scripts.
- Return half-open ranges `[from, to)` within the current logical line.
- Return `null` when the policy cannot safely handle an operation.
- Preserve ordinary selection deletion; custom rules apply to empty cursors.
- Do not perform normalization, dictionary lookup, spellcheck, or IPC in an editing policy.
- Keep policy functions deterministic and fast enough for every keystroke.

## Required tests

Add pure unit tests and include these cases:

- movement through representative clusters;
- backward and forward deletion ranges;
- combining marks and malformed input;
- document start and end;
- mixed Latin, Khmer, the new script, and emoji;
- multiple cursors and overlapping ranges;
- non-BMP text before and after the script;
- duplicate registration rejection;
- Khmer boundary and deletion results remain unchanged after registering the new policy.

Run:

```bash
bun test
bun run build
```

Policies that add native code or cross the Rust boundary also require the Rust validation commands listed in `DEVELOPMENT.md`.
