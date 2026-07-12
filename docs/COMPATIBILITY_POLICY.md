# Compatibility Policy

This document defines versioning rules, stability contracts, and promotion criteria for Typstella's language provider and editing policy systems.

## Provider ID stability

A provider's `id()` value is stored in user settings to persist installed dictionaries and language preferences. Once a provider ID is declared stable, it must not change. Changing a stable ID is a breaking change and requires a migration entry.

Rules:
- IDs must be lowercase with only letters, digits, hyphens, and underscores.
- Convention: BCP 47 tag (`lo`, `bn_BD`) or `engine:locale` (`hunspell:th`).
- Experimental providers may change their ID before reaching stable status, but must document the change in their PR.
- Stable providers must not rename their ID. If a rename is unavoidable, ship a migration record (see below).

## Capability schema versioning

The `PROVIDER_CAPABILITY_SCHEMA_VERSION` constant in `src-tauri/src/segmentation/provider.rs` versions the serialized capability shape. The TypeScript frontend reads this to determine which fields are available.

Rules:
- Any **additive** change (new optional field with a default) increments the patch version in a comment only; the constant stays the same.
- Any **breaking** change (renamed field, removed field, changed semantics) increments `PROVIDER_CAPABILITY_SCHEMA_VERSION` by 1.
- When the schema version increments, the TypeScript frontend must be updated in the same PR to handle both the old and new schema, or drop support for the old one with a documented migration path.

Current schema version: **1**

## Settings migrations

When a stable provider ID changes or a capability schema field is removed, a migration record must be added to the settings validation logic in `src/settings.ts`.

A migration record must include:
- The old ID or field name.
- The new ID or field name (or `null` if removed).
- The version at which the change was made.
- A brief rationale.

If an installed language entry refers to an unknown provider ID, Typstella must silently remove the entry rather than error. The provider can be re-installed by the user.

---

## Promotion criteria: experimental → stable

A language provider or editing policy must meet **all** of the following criteria before its `stability()` changes from `"experimental"` to `"stable"`:

### 1. Named maintainer

A GitHub username or a link to an upstream project is declared in the provider source file. The maintainer is responsible for reviewing future changes to the provider's fixtures and dictionary data.

### 2. Fixture coverage

All fixture categories in `tests/fixtures/<language>/language.json` and (if applicable) `tests/fixtures/<script>/editing.json` must be filled with real language examples reviewed by someone with language knowledge:

| Fixture category | Required |
|------------------|----------|
| Canonical words (known) | ✅ |
| Unknown / misspelled words | ✅ |
| Non-canonical / normalized forms | ✅ |
| Mixed-script ranges | ✅ |
| Non-BMP code points in surrounding text | ✅ |
| Performance sample (~100 words) | ✅ |

### 3. Validation matrix

All commands in the validation matrix must pass on both Windows and Linux release builds:

```bash
bun test
bun run conform
bun run build
cargo fmt --check
cargo check --lib
cargo test --lib
```

### 4. Performance gates

- Language analysis p95 latency after debounce: **≤ 100 ms**
- Suggestion lookup p95 latency: **≤ 50 ms**
- Suggestions capped at `limit` entries (never unbounded).
- No full-dictionary scan in the interactive analysis path.

Measure by running `bun test tests/performanceDiagnostics.test.ts` and comparing against the budgets defined in `docs/PERFORMANCE_GATES.md`.

### 5. Documented limitations

Known limitations must be documented in `docs/LANGUAGE_TOOLS.md` under the language's entry. Examples of required documentation:

- Compound words that the tokenizer splits incorrectly.
- Script variants or dialects not covered by the dictionary.
- Known false-positive or false-negative classes in spellcheck.
- Any condition under which `analyze()` returns an error.

### 6. No Khmer regression

Running `bun test tests/khmerReference.test.ts` must produce identical results to the baseline. Any difference is a blocker.

### 7. License declaration

`license()` must return a valid SPDX expression or attribution string. `"unknown"` and empty strings are rejected by the registry.

---

## Additive vs. breaking changes

| Change type | Breaking? | Action required |
|-------------|-----------|-----------------|
| Adding an optional field to `ProviderCapabilities` | No | Update default in trait; add handling in TypeScript |
| Renaming a `ProviderCapabilities` field | **Yes** | Increment schema version; add migration |
| Removing a `ProviderCapabilities` field | **Yes** | Increment schema version; add migration |
| Changing a stable provider's `id()` | **Yes** | Add migration; update stored settings |
| Changing an experimental provider's `id()` | No | Document in PR |
| Adding a new language provider | No | Follow contributor guide; start as experimental |
| Changing `SCRIPT_EDITING_POLICY_CONTRACT_VERSION` | **Yes** | Update all registered policies in the same PR |
| Changing a policy's `scripts` ownership | **Yes** | Confirm no overlap; run full conform suite |

---

## Deprecation process

1. Mark the provider as deprecated in its `display_name()` or a `// @deprecated` comment.
2. Set `stability()` to `"deprecated"` if the trait is extended to support that value; otherwise keep it as `"experimental"`.
3. Keep the provider registered for one minor release cycle (or two months, whichever is longer).
4. Remove the provider in the following release, adding a migration record if the ID was stable.

---

## CI enforcement (P9.9)

The `contributor-contracts.yml` GitHub Actions workflow automatically checks:

- `bun run conform` — policy and provider conformance tests.
- `cargo test --lib segmentation` — includes `all_registered_providers_have_licenses`.
- `cargo test --lib examples` — example workspace integrity.
- Khmer regression: `bun test tests/khmerReference.test.ts` must be unchanged.

A PR that fails any of these checks cannot be merged.
