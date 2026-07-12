# Typstella v2 Implementation Plan

## Status

This is a direction document, not an active release commitment. Begin implementation only after v1.x adoption and evidence clarify the real needs, costs, and risks. v1.x remains the product priority.

## Objective

Explore major interaction changes that are intentionally outside the backward-compatible v1.x series, beginning with real-time AI grammar/spellcheck integration. A possible WYSIWYM editing mode may be researched separately, but the code editor remains a first-class workflow.

## Design principles

1. Preserve deterministic Language Tools and label probabilistic AI results distinctly.
2. Never weaken Khmer or other provider-specific behavior to fit a generic AI result.
3. Privacy, scope, cost, latency, provenance, and user control are product requirements.
4. Code-based Typst authoring remains supported even if another editing surface is introduced.
5. Major features require community validation before architecture is frozen.

---

## Workstream V2-L: Real-time AI grammar and spellcheck

v1.x permits manually requested AI review as a response or proposed patch. v2 may integrate continuous/on-type AI grammar and spelling analysis with editor issues, but only through a separate AI diagnostics layer—not by pretending the model is a deterministic dictionary provider.

### Required research

- Define acceptable latency and cost for continuous multilingual analysis.
- Determine privacy-preserving selection, paragraph, file, and project scopes.
- Measure false positives and useful confidence thresholds by language/script.
- Define stable issue ranges across rapid edits and Unicode normalization.
- Separate grammar/style suggestions from spelling facts and deterministic provider output.
- Define dismissal, ignore, explanation, provenance, and offline behavior.
- Evaluate local models and remote providers without hardcoding one vendor.

### Checklist

- [ ] **V2-L.1 Define a versioned AI diagnostics contract.** Include provider/model, scope, revision, source hash/range, category, confidence, explanation, proposed edit, and provenance.
- [ ] **V2-L.2 Keep diagnostic stores separate.** Deterministic LSP, Language Tools, and AI diagnostics remain independently filterable and disableable.
- [ ] **V2-L.3 Add revision-safe scheduling.** Bound requests, cancel superseded work, redact excluded scopes, and reject stale results.
- [ ] **V2-L.4 Add explicit real-time consent and budgets.** Users choose provider, scope, frequency, cost/usage limits, and allowed files.
- [ ] **V2-L.5 Add visual differentiation.** AI grammar/style/spelling marks cannot be mistaken for compiler or dictionary facts.
- [ ] **V2-L.6 Add explanation and review.** Every issue shows why it was suggested and requires acceptance before mutation.
- [ ] **V2-L.7 Add multilingual evaluation.** Test Khmer and additional complex scripts with native reviewers before claiming support.
- [ ] **V2-L.8 Add prompt-injection and data-exfiltration defenses.** Document content cannot widen scope or authorize tools.
- [ ] **V2-L.9 Add local/offline adapters where practical.** Capability and quality are reported honestly.
- [ ] **V2-L.10 Add deterministic CI with mock providers.** Live-provider evaluation is separate, consented, and never required for normal CI.

### Promotion gates

- [ ] Users can distinguish AI suggestions from deterministic diagnostics without opening details.
- [ ] No content outside the configured scope is transmitted.
- [ ] Continuous analysis remains bounded under rapid typing and long documents.
- [ ] False-positive and latency targets are defined and met for every advertised language.
- [ ] Disabling AI removes all AI diagnostics without changing deterministic tools.

---

## Workstream V2-W: Optional WYSIWYM research

WYSIWYM is not required for v1.x and must not distract from the stable code editor. If revisited, prototype it as an optional view over the same canonical Typst source and project model.

### Research constraints

- The CodeMirror source document remains canonical until a round-trip model proves lossless behavior.
- Unknown Typst syntax must remain editable and preserved, not flattened or discarded.
- Multi-file projects, templates, functions, bibliography, raw blocks, figures, equations, and complex scripts must round-trip.
- Switching editing surfaces cannot change source formatting or semantics unexpectedly.
- The feature may be abandoned if reliable lossless transformation is not feasible.

### Checklist

- [ ] **V2-W.1 Define supported Typst syntax and explicit opaque-node behavior.**
- [ ] **V2-W.2 Build a lossless source/structure round-trip corpus.**
- [ ] **V2-W.3 Prototype block editing without replacing the code editor.**
- [ ] **V2-W.4 Validate Unicode, bidi, IME, Khmer navigation, and accessibility.**
- [ ] **V2-W.5 Validate multi-file ownership and revision-safe preview/source sync.**
- [ ] **V2-W.6 Make a documented continue/stop decision from test evidence.**

---

## Workstream V2-S: Adoption and migration

- [ ] Define migration from v1.x settings, assistant configuration, project manifests, and ignored diagnostics.
- [ ] Preserve `.typstella` archive compatibility or provide explicit conversion tooling.
- [ ] Publish privacy, AI-provider, cost, model-quality, and supported-language documentation.
- [ ] Run an opt-in preview period before enabling any real-time AI feature broadly.
- [ ] Keep a supported mode with all AI features disabled.

## v2 release gate

No v2 feature may compromise v1.x source portability, project/font reproducibility, deterministic Language Tools, recovery, or complex-script correctness. Real-time AI remains opt-in, and the code editor remains available regardless of WYSIWYM research outcome.

