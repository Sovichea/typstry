# Language Contributor Guide

This document describes the complete path for adding support for a new language or script to Typsastra. Follow the steps in order. Each step has a validation command so you can confirm progress before moving forward.

## Before You Start

### 1. Understand the support levels

Typsastra uses three capability tiers. Choose the tier you are targeting and note that higher tiers require more work and more review.

| Tier | What it includes | Example |
|------|-----------------|---------|
| **Basic** | Hunspell-compatible dictionary only. Reasonable spellcheck; no reliable tokenization. The UI labels this as fallback support. | Arabic, Bengali |
| **Enhanced** | Custom tokenizer or boundary logic. Better word segmentation than Unicode grapheme clusters alone. | Lao (ICU4X) |
| **Deep** | Full editing policy + dedicated segmenter + spellcheck + word completion + performance-validated fixtures. | Khmer |

Do not claim a higher tier than your implementation actually delivers. The `support_level` and `boundary_quality` fields in your provider are shown directly to users.

### 2. Verify your language and data sources

Before writing code, record answers to these questions:

- **Language name and BCP 47 tag:** e.g. `lo` (Lao), `si` (Sinhala)
- **ISO 15924 script code(s):** e.g. `Laoo`, `Sinh` — must be a valid 4-letter code from [iso15924](https://www.unicode.org/iso15924/iso15924-codes.html)
- **Unicode block(s):** e.g. `U+0E80–U+0EFF` (Lao) — find in [Unicode charts](https://www.unicode.org/charts/)
- **Dictionary source:** URL, repository, or upstream project
- **Dictionary license:** Must be a redistributable open-source license (SPDX expression). The registry **rejects** providers with `"unknown"` licenses.
- **Segmentation approach:** Unicode grapheme baseline, ICU word break, custom dictionary/segmenter?
- **Named maintainer:** Who will review future changes to this provider? A GitHub username is sufficient.

### 3. Check for conflicts

Run the existing test suite to establish your baseline before changing any code:

```bash
bun test
bun run conform
cargo test --lib
```

All tests must pass before you begin. If any fail, report the issue rather than working around it.

---

## Step 1 — Create the Rust provider (required for all tiers)

### 1a. Copy the provider template

```bash
cp docs/templates/provider_template.rs \
   src-tauri/src/segmentation/<language_id>_provider.rs
```

Replace `<language_id>` with a lowercase identifier matching your BCP 47 tag (e.g. `lo`, `si_LK`).

### 1b. Fill in the required fields

Open the new file and edit every `TODO` comment. The mandatory fields are:

| Method | Requirement |
|--------|-------------|
| `id()` | Unique, stable string. Convention: BCP 47 tag or `engine:locale`. Must not change after first stable release. |
| `display_name()` | Human-readable name for the Settings panel. |
| `language_tag()` | BCP 47 language tag. |
| `scripts()` | ISO 15924 script code(s). |
| `license()` | Non-empty, non-`"unknown"` SPDX expression. |
| `stability()` | `"experimental"` until promotion criteria are met. |
| `pattern()` | Regex matching script Unicode range(s). Must be tight; avoid over-matching. |
| `supports()` | Fast O(n) check. |
| `analyze()` | Segment text; return byte offsets into the **original** UTF-8 string. |
| `suggestions()` | Correction candidates, at most `limit` entries. |

### 1c. Validate byte-offset invariants

Every token from `analyze()` must satisfy:

- `from` and `to` are byte offsets into the UTF-8 `text` argument.
- `from` and `to` fall on valid UTF-8 character boundaries (`text.is_char_boundary(offset)`).
- `from <= to`.
- Tokens are non-overlapping and sorted by `from`.

The `byte_offsets_are_valid_utf8_boundaries` test in the template catches most violations.

### 1d. Run the unit tests

```bash
cargo test --lib segmentation::<language_id>_provider
```

All template tests must pass before proceeding.

---

## Step 2 — Register the provider

Open `src-tauri/src/segmentation/registry.rs`. Find `SegmentationRegistry::new()` and add your provider:

```rust
// At the top of the file, add:
mod <language_id>_provider;
use <language_id>_provider::TemplateProvider; // rename to your struct

// Inside SegmentationRegistry::new():
registry.register_provider(Arc::new(YourProvider::new()));
```

> **Note:** Only register **stable** providers unconditionally in `new()`. Experimental providers should be gated behind a user setting until promotion criteria are met.

Run the full Rust test suite:

```bash
cargo test --lib
```

Check that `all_registered_providers_have_licenses` still passes.

---

## Step 3 — Create language analysis fixtures (required)

Fixtures are locked reference tests. Once committed, changing them requires a documented justification. They protect against regressions when the segmenter or dictionary changes.

### 3a. Copy the fixture template

```bash
mkdir -p tests/fixtures/<language_id>
cp tests/fixtures/template/language.json \
   tests/fixtures/<language_id>/language.json
```

### 3b. Fill in fixture entries

Replace every `REPLACE_ME` placeholder with real language examples covering:

| Category | Description |
|----------|-------------|
| **Canonical** | Words your dictionary knows are correct |
| **Unknown** | Words your dictionary flags as incorrect |
| **Non-canonical** | Input that requires normalization (ZWSP, ZWNJ stripped) |
| **Mixed-script** | Script text alongside Latin characters |
| **Non-BMP** | Emoji or supplementary-plane code points in surrounding text |
| **Performance** | A representative ~100-word document for timing reference |

### 3c. Write a reference test file

Create `tests/<language_id>Reference.test.ts` modeled on `tests/laoReference.test.ts`. Import your fixture and assert that the provider's output matches each expected entry.

Run:

```bash
bun test tests/<language_id>Reference.test.ts
```

---

## Step 4 — Create a script editing policy (deep support only)

Skip this step for basic or enhanced support. A policy is required only when Unicode grapheme boundaries are not sufficient for correct cursor movement, selection, or deletion in your script.

### 4a. Copy the policy template

```bash
cp -r src/editor/editingPolicies/template \
      src/editor/editingPolicies/<script_name>
```

### 4b. Fill in the policy

Open `src/editor/editingPolicies/<script_name>/policy.ts` and edit every `TODO`:

| Field | Requirement |
|-------|-------------|
| `id` | Unique lowercase string. Convention: lowercase script name. |
| `scripts` | ISO 15924 code(s) — must not overlap with `Khmr` or any other registered policy. |
| `codePointRanges` | Must not overlap with any other registered policy's ranges. |
| `shouldMergeBoundary` | Returns true only when both adjacent code points belong to **this** policy. |
| `backwardDeletionRange` | `to` must equal `offset`; return null for offset ≤ 0. |
| `forwardDeletionRange` | `from` must equal `offset`. |

### 4c. Create editing fixtures

```bash
mkdir -p tests/fixtures/<script_name>
cp tests/fixtures/template/editing.json \
   tests/fixtures/<script_name>/editing.json
```

Fill in representative editing examples for every fixture category.

### 4d. Register the policy

In `src/editor/editingPolicies/registry.ts`, add your policy to `createDefaultEditingPolicyRegistry()`:

```typescript
import { yourScriptEditingPolicy } from "./<script_name>/policy";

export function createDefaultEditingPolicyRegistry() {
  const registry = new ScriptEditingPolicyRegistry();
  registry.register(khmerEditingPolicy);
  registry.register(yourScriptEditingPolicy); // ← add here
  return registry;
}
```

### 4e. Run the conformance suite

```bash
bun run conform
```

All existing Khmer tests must still pass. Your new policy tests must also pass.

---

## Step 5 — Run the full validation matrix

```bash
bun test                    # all frontend tests
bun run conform             # policy + provider conformance
bun run build               # TypeScript compilation
cargo fmt --check           # from src-tauri/
cargo check --lib           # from src-tauri/
cargo test --lib            # from src-tauri/
```

All commands must complete without errors before submitting.

---

## Step 6 — Document your language

Add or update the following:

- `docs/LANGUAGE_TOOLS.md` — add an entry describing your language's capabilities, data source, and limitations.
- Your provider's `docs/templates/` files or inline code comments should document any known segmentation limitations.
- If your language has a known maintainer, add their name to the provider's `display_name` or a `MAINTAINERS` comment block.

---

## Step 7 — Submit for review

Open a pull request with:

- The new provider file and tests.
- The fixture files.
- The edited policy file and tests (if applicable).
- An update to `docs/LANGUAGE_TOOLS.md`.
- A brief description of the language, data source, and license.

A reviewer will check:

- [ ] All validation matrix commands pass on Windows and Linux.
- [ ] `license()` is non-empty and non-`"unknown"`.
- [ ] `stability()` is `"experimental"` unless promotion criteria are met.
- [ ] No Khmer regression: `bun test tests/khmerReference.test.ts` passes unchanged.
- [ ] No generic CodeMirror code was modified.
- [ ] No new script-specific regexes in `appController.ts` or `extensions.ts`.

---

## Promotion from experimental to stable

See [docs/COMPATIBILITY_POLICY.md](./COMPATIBILITY_POLICY.md) for the complete promotion checklist.

In summary, a provider reaches stable status when:

1. All fixture categories are filled with real, reviewed language examples.
2. The provider passes the full validation matrix on Windows and Linux release builds.
3. Performance gates pass: analysis p95 < 100 ms, suggestions p95 < 50 ms.
4. Known limitations are documented in `docs/LANGUAGE_TOOLS.md`.
5. A named maintainer (GitHub username) is declared.
6. A reviewer with knowledge of the language has approved the fixture content.

After promotion, `stability()` changes to `"stable"` and the provider is registered unconditionally in `SegmentationRegistry::new()`.
