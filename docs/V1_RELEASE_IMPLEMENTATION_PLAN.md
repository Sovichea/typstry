# Typsastra v1.0 Release Implementation Plan

## Objective

Ship Typsastra v1.0 as a dependable, complex-script-first research writing environment with reproducible project interchange, guided project creation, and explicit release-quality gates.

This plan complements the [complex-script-first implementation plan](./COMPLEX_SCRIPT_FIRST_IMPLEMENTATION_PLAN.md). That plan owns editor, language-provider, preview, and research-workflow architecture. This document owns only the remaining product work and release gates required for v1.0.

The [PDF preview interaction implementation plan](./PDF_PREVIEW_INTERACTION_IMPLEMENTATION_PLAN.md) owns the remaining v1.0 gesture-scroll and scrollbar-release work. Its bounded render concurrency, final-canvas residency, memory, and qualification gates are part of the v1.0 release gate.

## Release principles

1. Stability and data safety take priority over new features.
2. Typst source remains ordinary, portable source. Typsastra metadata may guide the application but must never be required by the standard Typst compiler.
3. A shared project records the compiler environment with which it was exported. Import never silently claims compatibility with a different Typst version.
4. Opening or importing a project never executes project-provided code.
5. Templates are local, reviewable, editable source—not opaque generators.
6. Version-bound means an exact Typst semantic version. Because Typsastra manages Tinymist rather than a standalone compiler, the manifest also records the exact Tinymist version that embeds that Typst version.

## Tracking convention

Tasks use stable IDs such as `V1-I.3`. An item is complete only when implementation, automated tests, user-facing errors, and documentation are finished together.

---

## Workstream V1-I: Version-bound project export and import

### Archive contract

Replace the current unversioned workspace ZIP with a versioned Typsastra project archive. Use the extension `.typsastra` while retaining ZIP as the underlying container format.

Each archive contains ordinary project files plus a generated manifest at:

```text
.typsastra/project.json
```

Proposed schema:

```json
{
  "format": "com.typsastra.project",
  "schemaVersion": 2,
  "createdBy": {
    "application": "Typsastra",
    "version": "0.3.0"
  },
  "project": {
    "name": "Example Research Project",
    "main": "main.typ"
  },
  "toolchain": {
    "typstVersion": "0.x.y",
    "tinymistVersion": "0.x.y",
    "compatibility": "exact"
  },
  "integrity": {
    "algorithm": "sha256",
    "files": {
      "main.typ": "..."
    }
  }
}
```

Rules:

- `format`, `schemaVersion`, exact Typst version, exact Tinymist version, main-file path, and file hashes are mandatory.
- Generated caches, render mirrors, `.git`, `target`, and `node_modules` remain excluded.
- `.typsastra/project.json` is the only generated `.typsastra` content exported.
- Font binaries are never included, regardless of location or license. Recipients install required fonts separately.
- Local generated/scaled fonts remain workspace cache data and are excluded from every archive.
- A legacy plain ZIP may still be exported through an explicitly named **Export Source ZIP** action, but it carries no compatibility promise.
- The archive format must be documented and forward-compatible: unknown optional fields are ignored; unsupported schema versions are rejected with a useful message.

### Import flow

```text
Choose or double-click .typsastra
  -> inspect manifest without extracting
  -> validate schema, paths, sizes, hashes, and archive limits
  -> choose an empty destination folder
  -> compare required and installed toolchains
  -> show compatibility decision
  -> download the exact compatible Tinymist build when approved
  -> extract transactionally to a staging directory
  -> verify extracted hashes
  -> atomically promote the project directory
  -> record the workspace toolchain binding
  -> open the project
```

The compatibility dialog must offer:

- **Download compatible version and import** when the exact toolchain is available;
- **Use installed compatible version and import** when already installed;
- **Import with current version** with an explicit warning that compatibility is not guaranteed;
- **Cancel**.

Changing the toolchain later is allowed from project/toolchain settings. The UI must show that the project is no longer using its exported version and offer **Restore recommended version**.

### Font-free project interchange

Typsastra treats fonts as external runtime dependencies. Project and source ZIP exports filter all recognized font binaries without inspecting their licenses. Schema v2 contains no font-package option or rendering-environment claim. Import rejects archives containing font binaries, while the dialog explains that recipients must install required fonts separately. This keeps interchange small and avoids silently assuming redistribution rights.

### File association and double-click behavior

Installed desktop packages should register `.typsastra` as **Typsastra Project**, with MIME type `application/vnd.typsastra.project`, and use the Typsastra application icon. The Tauri bundle configuration is expected to declare:

```json
{
  "bundle": {
    "fileAssociations": [
      {
        "ext": ["typsastra"],
        "name": "Typsastra Project",
        "description": "Version-bound Typsastra project archive",
        "mimeType": "application/vnd.typsastra.project",
        "role": "Editor",
        "rank": "Owner",
        "exportedType": {
          "identifier": "com.typsastra.project",
          "conformsTo": ["public.data", "public.archive"]
        }
      }
    ]
  }
}
```

Double-click is an import entry point, not permission to extract immediately:

```text
Operating system opens project.typsastra
  -> Typsastra receives and canonicalizes the file path
  -> queue the request until native state and frontend are ready
  -> inspect format and manifest
  -> show the normal import and compatibility flow
  -> extract only after user confirmation
```

Cold launch and already-running behavior must both work. When Typsastra is already open, a single-instance handoff should deliver the path to the existing window, focus it, and open one import dialog. Repeated OS events for the same canonical path must be deduplicated. Unsupported/corrupt files receive an error without changing the active workspace.

Installer verification is required for Windows MSI/NSIS, Linux DEB/RPM desktop integration, and macOS application bundles. AppImage association depends on the user's desktop integration mechanism, so Typsastra must not claim automatic association for a standalone AppImage.

### Checklist

- [x] **V1-I.1 Define the archive schema.** Add typed Rust and TypeScript representations, schema documentation, sample valid archives, and compatibility rules.
- [x] **V1-I.2 Split the export commands.** Rename the existing behavior to source ZIP export and add version-bound project export.
- [x] **V1-I.3 Record the effective compiler.** Read the active managed Tinymist and its embedded Typst version at export time; fail clearly when no validated toolchain is active.
- [x] **V1-I.4 Add deterministic manifest generation.** Normalize archive paths, sort entries, calculate SHA-256 hashes, and use a stable schema encoding.
- [x] **V1-I.5 Harden archive writing.** Exclude generated/private directories, handle Unicode filenames, preserve empty directories only when necessary, and reject files that change during export.
- [x] **V1-I.6 Add preflight inspection.** Read and validate the manifest before extraction; impose entry-count, per-file, total-uncompressed-size, path-length, and compression-ratio limits.
- [x] **V1-I.7 Prevent unsafe extraction.** Reject absolute paths, `..`, symlinks/reparse points, duplicate normalized paths, reserved Windows device names, and case-folding collisions.
- [x] **V1-I.8 Add transactional import.** Extract to a staging directory, verify every hash, clean up failed imports, and never overwrite a non-empty destination.
- [x] **V1-I.9 Resolve compatible toolchains.** Match the exact embedded Typst version, prefer the recorded Tinymist version, and only offer releases whose embedded compiler metadata has been verified.
- [x] **V1-I.10 Add the compatibility dialog.** Explain exact match, alternative build, unavailable version, offline state, and the consequences of overriding the pin.
- [x] **V1-I.11 Add per-workspace toolchain binding.** Store the recommended and selected versions separately; restarting Typsastra must restore the workspace selection without unexpectedly changing other projects.
- [x] **V1-I.12 Add menus and progress UI.** File menu actions: **Import Typsastra Project**, **Export Typsastra Project**, and **Export Source ZIP**. Use the `*.typsastra` filter for version-bound projects. Downloads, validation, extraction, and cleanup must be cancellable where safe.
- [x] **V1-I.13 Add migration behavior.** Continue opening normal folders and legacy ZIP exports without inventing a compatibility guarantee; document how to re-export them in the new format.
- [x] **V1-I.14 Test the interchange contract.** Cover Unicode paths, large projects, corrupt ZIPs, zip-slip, hash mismatch, missing main files, unavailable versions, cancellation, disk-full behavior, and Windows/Linux/macOS round trips.
- [x] **V1-I.15 Register the file association.** Add `.typsastra`, `application/vnd.typsastra.project`, the exported macOS type, the Typsastra icon, and installer metadata without claiming ownership of `.typ` or `.typst` source files.
- [x] **V1-I.16 Route OS-open events safely.** Handle cold launch and single-instance handoff, queue requests until initialization completes, canonicalize and deduplicate paths, focus the existing window, and invoke the same import controller used by the File menu.
- [x] **V1-I.17 Test packaged double-click import.** Verify association, icon, cold/warm launch, spaces and Unicode paths, corrupt archives, repeated events, cancellation, and uninstall cleanup on every supported installer format.
- [x] **V1-I.18 Adopt font-free archives.** Remove font-package and render-environment fields in schema v2.
- [x] **V1-I.19 Exclude font binaries.** Filter recognized desktop and web-font formats from project and source ZIP exports.
- [x] **V1-I.20 Reject font-bearing archives.** Fail preflight before extraction when a font binary is present.
- [x] **V1-I.21 Preserve local font workflows.** Continue using workspace-generated fonts locally without archiving them.
- [x] **V1-I.22 Explain external font requirements.** Tell importers that required fonts must be installed separately.
- [x] **V1-I.23 Keep export lightweight.** Remove PDF font auditing, licensing checks, duplicate compilation, and font payload limits.
- [x] **V1-I.24 Test font-free interchange.** Cover every filtered extension, crafted archives, source ZIPs, local generated fonts, and cross-platform round trips.

### Acceptance criteria

- [ ] Exported projects state the exact compiler environment used to produce them.
- [ ] Import never extracts project content before archive validation and destination confirmation.
- [ ] A compatible managed toolchain can be installed from the import dialog and is selected for that workspace.
- [ ] Choosing another version displays a persistent compatibility warning but does not prevent deliberate use.
- [ ] Double-clicking a `.typsastra` file opens one validated import flow in either a new or already-running Typsastra instance.
- [ ] `.typsastra` and source ZIP exports contain no font binaries or generated font cache.
- [ ] Font-bearing archives are rejected before extraction, and recipients are told to install required fonts separately.
- [ ] Ordinary `.typ` sources still compile outside Typsastra.
- [ ] Malicious or malformed archives cannot write outside the chosen destination or leave a partial project presented as successful.

---

## Workstream V1-N: New project workflow

Add **Create New Project** to the welcome screen and File menu. The wizard collects a project name, destination, template, language/font preferences, author metadata, and optional bibliography choice. It previews the file tree before creation.

Project names must be validated independently from display titles. The folder name should be portable across Windows, Linux, and macOS; the document title may contain any valid Unicode text.

### Template A: Blank project

Purpose: smallest possible portable starting point.

```text
project-name/
  main.typ
```

`main.typ`:

```typst
= Hello, world!

Start writing with Typsastra and Typst.
```

Do not add a template library, package dependency, or generated assets.

### Template B: Technical report

Purpose: proposals, engineering reports, design documents, evaluations, and internal technical documentation.

```text
project-name/
  main.typ
  template.typ
  references.bib
  sections/
    01-executive-summary.typ
    02-background.typ
    03-requirements.typ
    04-design-and-method.typ
    05-results.typ
    06-risks-and-recommendations.typ
    07-conclusion.typ
  figures/
    README.md
  data/
    README.md
```

Features: cover page, revision/date metadata, numbered headings, table/figure captions, equations, references, appendix-ready structure, and Unicode fallback fonts. The default source must compile without external assets.

### Template C: IEEE-style research paper

Purpose: a compact two-column research-paper starting point.

```text
project-name/
  main.typ
  ieee-style.typ
  references.bib
  sections/
    abstract.typ
    introduction.typ
    related-work.typ
    methodology.typ
    results.typ
    conclusion.typ
  figures/
    README.md
  data/
    README.md
```

Features: title, authors and affiliations, abstract, keywords, two-column body, numbered figures/tables/equations, citations, and bibliography. Label it **IEEE-style**, not an official IEEE submission template, until its output has been validated against current publisher requirements. Keep it self-contained or pin every Typst package dependency explicitly in the project manifest.

### Template D: Thesis

Purpose: undergraduate, graduate, and doctoral long-form research.

```text
project-name/
  main.typ
  thesis.typ
  references.bib
  front-matter/
    title-page.typ
    declaration.typ
    abstract.typ
    acknowledgements.typ
  chapters/
    01-introduction.typ
    02-literature-review.typ
    03-methodology.typ
    04-results.typ
    05-discussion.typ
    06-conclusion.typ
  appendices/
    appendix-a.typ
  figures/
    README.md
  data/
    README.md
```

Features: configurable institution/degree/supervisor metadata, Roman-numbered front matter, Arabic-numbered main matter, chapter-level page starts, list of figures/tables, bibliography, appendices, and complex-script-safe typography.

### Template E: Book

Purpose: monographs, textbooks, manuals, and other long documents.

```text
project-name/
  main.typ
  book.typ
  references.bib
  front-matter/
    title-page.typ
    copyright.typ
    preface.typ
  parts/
    01-foundations/
      part.typ
      01-first-chapter.typ
    02-applications/
      part.typ
      01-second-chapter.typ
  back-matter/
    glossary.typ
    bibliography.typ
  figures/
    README.md
```

Features: recto chapter starts, running heads, configurable trim size and margins, parts/chapters, front and back matter, figures, bibliography, glossary placeholder, and print-friendly PDF defaults. Index generation should be optional until its behavior is reliable.

### Checklist

- [ ] **V1-N.1 Define the template descriptor contract.** IDs are stable; labels, descriptions, preview image, files, minimum Typst version, and optional dependencies are declared as data.
- [ ] **V1-N.2 Build the creation service in Rust.** Validate paths, reject collisions, create through a staging directory, and roll back completely on failure.
- [ ] **V1-N.3 Build the project wizard.** Support keyboard navigation, Unicode titles, portable folder names, destination selection, template choice, and a file-tree preview.
- [ ] **V1-N.4 Add welcome and File menu entry points.** Both must invoke the same controller and creation service.
- [ ] **V1-N.5 Implement the blank template.** Keep it dependency-free and verify its exact generated contents.
- [ ] **V1-N.6 Implement the technical-report template.** Include meaningful placeholder content and accessible figure/table examples.
- [ ] **V1-N.7 Implement the IEEE-style template.** Add the visible non-official disclaimer, two-column layout, citations, and mixed-script regression content.
- [ ] **V1-N.8 Implement the thesis template.** Verify multi-file preview, outline, bibliography, numbering, forward navigation, and export.
- [ ] **V1-N.9 Implement the book template.** Verify long-document pagination, parts, running content, virtualized preview, and export.
- [ ] **V1-N.10 Add typography choices.** Generate a global fallback font stack from supported settings; do not generate per-script `show regex(...)` rules.
- [ ] **V1-N.11 Add metadata and licensing.** Templates state their license, bundled asset sources, and dependency versions.
- [ ] **V1-N.12 Add compile fixtures.** Every template must compile on all supported platforms with its declared toolchain and include Latin, Khmer, and at least one other complex-script smoke test where appropriate.
- [ ] **V1-N.13 Add creation failure tests.** Cover invalid/reserved names, existing destinations, read-only locations, interrupted writes, unavailable dependencies, and Unicode paths.

### Acceptance criteria

- [ ] A user can create every template from either entry point and immediately preview it.
- [ ] Generated projects are ordinary Typst projects and do not require Typsastra to compile.
- [ ] No template downloads or executes code during creation.
- [ ] Templates compile in CI with their declared Typst version.
- [ ] Project creation never leaves a partial directory after a reported failure.

---

## Workstream V1-S: Release stability and data-safety gates

These gates take priority over every other v1.0 feature.

- [ ] **V1-S.1 Add crash-safe saving and recovery.** Use atomic writes, preserve unsaved buffers for recovery, and test process interruption.
- [ ] **V1-S.2 Add settings and workspace migrations.** Every persisted schema has a version, forward rejection, backward migration, and fixture tests.
- [ ] **V1-S.3 Add backup/restore documentation.** Users can identify source, project metadata, app settings, dictionaries, and disposable caches.
- [ ] **V1-S.4 Establish supported-platform release tests.** Test install, upgrade, uninstall, workspace restore, toolchain download, template creation, project import/export, preview, and PDF export.
- [ ] **V1-S.5 Add signed-artifact and checksum policy.** Publish checksums for release assets and sign installers wherever the platform release process supports it.
- [ ] **V1-S.6 Add offline and degraded-mode behavior.** Existing projects remain editable when release catalogs, dictionaries, or toolchain servers are unavailable.
- [ ] **V1-S.7 Add accessibility gates.** Keyboard-only project creation/import, readable focus, scalable UI text, screen-reader labels for core controls, and reduced-motion support.
- [ ] **V1-S.8 Add resource ceilings.** Define startup, idle memory, long-PDF memory, typing latency, import/export, and template compile budgets on Windows and Linux.
- [ ] **V1-S.9 Add destructive-operation review.** Import, overwrite, delete, toolchain removal, and external-file reconciliation require explicit and tested safeguards.
- [ ] **V1-S.10 Run a release-candidate period.** Freeze features, publish migration notes, collect beta reports, and resolve all data-loss, security, crash, and blocker-severity issues before v1.0.
- [ ] **V1-S.11 Complete PDF preview interaction qualification.** Finish phases PV0 through PV5 in the [PDF preview interaction plan](./PDF_PREVIEW_INTERACTION_IMPLEMENTATION_PLAN.md), publish Windows and Linux results, and resolve blocker-severity gesture-scroll, scrollbar-release, blank-page, stale-generation, and unbounded-memory failures.

### v1.0 release gate

Typsastra is eligible for v1.0 only when:

- all `V1-I`, `V1-N`, and `V1-S` acceptance criteria pass;
- no known data-loss, unsafe extraction, project corruption, or toolchain-selection blocker remains;
- Khmer editing and language-tool regression suites pass;
- long multi-file documents preview and export within documented limits;
- the PDF preview interaction gates pass for gesture scrolling and scrollbar release;
- Windows and Linux release builds pass the full installer-to-export workflow;
- macOS is either verified to the same standard or clearly labeled with narrower support;
- documentation describes project format compatibility, recovery, privacy, supported platforms, and known limitations.

---

## Plan boundaries

Post-v1.0 work is tracked separately:

- [Typsastra v1.x implementation plan](./V1X_IMPLEMENTATION_PLAN.md)
- [Typsastra v2 implementation plan](./V2_IMPLEMENTATION_PLAN.md)

## Recommended priority order

1. Finish `V1-S` foundations that protect user data.
2. Implement the versioned archive contract, secure import preflight, and self-contained font packaging.
3. Implement workspace-bound toolchain selection and download flow.
4. Complete transactional import/export, file association, and cross-platform tests.
5. Implement the shared new-project service and blank template.
6. Add technical report, IEEE-style paper, thesis, and book templates one at a time with compile fixtures.
7. Freeze features and run the v1.0 release-candidate period.
8. Begin [v1.x work](./V1X_IMPLEMENTATION_PLAN.md) only after the v1.0 release gate passes.
