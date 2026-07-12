# Typstella v1.0 Release Implementation Plan

## Objective

Ship Typstella v1.0 as a dependable, complex-script-first research writing environment with reproducible project interchange, guided project creation, and explicit release-quality gates.

This plan complements the [complex-script-first implementation plan](./COMPLEX_SCRIPT_FIRST_IMPLEMENTATION_PLAN.md). That plan owns editor, language-provider, preview, and research-workflow architecture. This document owns only the remaining product work and release gates required for v1.0.

## Release principles

1. Stability and data safety take priority over new features.
2. Typst source remains ordinary, portable source. Typstella metadata may guide the application but must never be required by the standard Typst compiler.
3. A shared project records the compiler environment with which it was exported. Import never silently claims compatibility with a different Typst version.
4. Opening or importing a project never executes project-provided code.
5. Templates are local, reviewable, editable source—not opaque generators.
6. Version-bound means an exact Typst semantic version. Because Typstella manages Tinymist rather than a standalone compiler, the manifest also records the exact Tinymist version that embeds that Typst version.

## Tracking convention

Tasks use stable IDs such as `V1-I.3`. An item is complete only when implementation, automated tests, user-facing errors, and documentation are finished together.

---

## Workstream V1-I: Version-bound project export and import

### Archive contract

Replace the current unversioned workspace ZIP with a versioned Typstella project archive. Use the extension `.typstella` while retaining ZIP as the underlying container format.

Each archive contains ordinary project files plus a generated manifest at:

```text
.typstella/project.json
```

Proposed schema:

```json
{
  "format": "com.typstella.project",
  "schemaVersion": 1,
  "createdBy": {
    "application": "Typstella",
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
  "fonts": [
    {
      "id": "misans-khmer-regular",
      "family": "MiSans Khmer",
      "postscriptName": "MiSansKhmer-Regular",
      "style": "normal",
      "weight": 400,
      "stretch": 100,
      "path": ".typstella/fonts/package/MiSansKhmer-Regular.ttf",
      "sha256": "...",
      "license": {
        "name": "...",
        "redistributable": true
      }
    }
  ],
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
- `.typstella/project.json` and the verified font payload under `.typstella/fonts/package/` are the only generated `.typstella` content exported.
- Every font face resolved for document rendering is declared and included, including the actual generated/scaled face when complex-script scaling is active. Disposable generated-font cache paths are not copied directly; export creates a verified package payload.
- Package dependencies are declared when known. Third-party fonts are included only when their redistribution and modification terms permit it; otherwise version-bound export is blocked until the user replaces or legally resolves the font.
- A legacy plain ZIP may still be exported through an explicitly named **Export Source ZIP** action, but it carries no compatibility promise.
- The archive format must be documented and forward-compatible: unknown optional fields are ignored; unsupported schema versions are rejected with a useful message.

### Import flow

```text
Choose or double-click .typstella
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

### Self-contained render fonts

A `.typstella` archive must contain every exact font face declared for project rendering plus every additional fallback face resolved by the exported render. This union prevents an unused-but-configured complex-script fallback from disappearing merely because the current revision does not contain that script. Import must not depend on a similarly named system font, because family names alone do not guarantee identical outlines, shaping tables, metrics, or version.

```text
Export preflight
  -> resolve every face declared by project typography configuration
  -> compile the selected project revision with the bound toolchain
  -> capture every additional resolved font/fallback face
  -> resolve the exact source font bytes
  -> verify font identity, format, license, and embedding/redistribution rights
  -> copy the exact bytes into .typstella/fonts/package/
  -> record face metadata, provenance, and SHA-256
  -> compile once against only the packaged font path
  -> require equivalent successful output before writing the archive
```

Required behavior:

- Include the faces required by every declared project render family and each resolved regular, bold, italic, bold-italic, variable-font instance/source, fallback, symbol, math, emoji, CJK, and complex-script face used by the document.
- Treat dynamically constructed or unresolved font-family expressions as an export blocker unless the user resolves them through an explicit project font declaration. Static source scanning alone is never proof of completeness.
- Include render-only uniformly scaled fonts as the actual generated font used for rendering, together with source-font hash, scale, generator version, and applicable license metadata.
- Preserve full OpenType font files by default. Do not subset complex-script fonts until shaping, variation, licensing, and glyph-closure tests prove subsetting safe.
- Store fonts project-locally and give the packaged directory priority when starting Tinymist/Typst for that workspace. Never install imported fonts into the operating system.
- Verify imported font hashes before loading them. Reject undeclared fonts, unsupported formats, malformed collections, excessive sizes/face counts, path collisions, and a manifest identity that disagrees with parsed font metadata.
- Prevent family-name collisions from selecting a system font ahead of the packaged face. Rendering is keyed by the packaged identity and hash, not merely the family string.
- Display a font preflight table with **Included**, **Missing**, **Ambiguous**, **License required**, or **Not redistributable** status. Do not silently substitute fonts.
- If a font cannot be redistributed, block **Export Typstella Project** and offer to select a redistributable replacement. **Export Source ZIP** may remain available but must state that it is not render-reproducible and must not copy a restricted system font.
- Record license name, license/source URL when known, copyright/vendor, modification permission, redistribution permission, and OS/2 embedding restrictions. A user assertion may supply missing provenance for their own font, but it must not override an explicit restrictive license.
- Imported projects use their packaged fonts for preview and PDF export even when other font versions are installed. Users may deliberately replace a font later, which marks the rendering environment as modified.

For standard Typst CLI portability, the imported project documentation should expose the equivalent command:

```text
typst compile --font-path .typstella/fonts/package main.typ
```

The `.typ` source remains ordinary Typst source; the font-path argument supplies the archived rendering environment.

### File association and double-click behavior

Installed desktop packages should register `.typstella` as **Typstella Project**, with MIME type `application/vnd.typstella.project`, and use the Typstella application icon. The Tauri bundle configuration is expected to declare:

```json
{
  "bundle": {
    "fileAssociations": [
      {
        "ext": ["typstella"],
        "name": "Typstella Project",
        "description": "Version-bound Typstella project archive",
        "mimeType": "application/vnd.typstella.project",
        "role": "Editor",
        "rank": "Owner",
        "exportedType": {
          "identifier": "com.typstella.project",
          "conformsTo": ["public.data", "public.archive"]
        }
      }
    ]
  }
}
```

Double-click is an import entry point, not permission to extract immediately:

```text
Operating system opens project.typstella
  -> Typstella receives and canonicalizes the file path
  -> queue the request until native state and frontend are ready
  -> inspect format and manifest
  -> show the normal import and compatibility flow
  -> extract only after user confirmation
```

Cold launch and already-running behavior must both work. When Typstella is already open, a single-instance handoff should deliver the path to the existing window, focus it, and open one import dialog. Repeated OS events for the same canonical path must be deduplicated. Unsupported/corrupt files receive an error without changing the active workspace.

Installer verification is required for Windows MSI/NSIS, Linux DEB/RPM desktop integration, and macOS application bundles. AppImage association depends on the user's desktop integration mechanism, so Typstella must not claim automatic association for a standalone AppImage.

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
- [x] **V1-I.11 Add per-workspace toolchain binding.** Store the recommended and selected versions separately; restarting Typstella must restore the workspace selection without unexpectedly changing other projects.
- [x] **V1-I.12 Add menus and progress UI.** File menu actions: **Import Typstella Project**, **Export Typstella Project**, and **Export Source ZIP**. Use the `*.typstella` filter for version-bound projects. Downloads, validation, extraction, and cleanup must be cancellable where safe.
- [x] **V1-I.13 Add migration behavior.** Continue opening normal folders and legacy ZIP exports without inventing a compatibility guarantee; document how to re-export them in the new format.
- [x] **V1-I.14 Test the interchange contract.** Cover Unicode paths, large projects, corrupt ZIPs, zip-slip, hash mismatch, missing main files, unavailable versions, cancellation, disk-full behavior, and Windows/Linux/macOS round trips.
- [x] **V1-I.15 Register the file association.** Add `.typstella`, `application/vnd.typstella.project`, the exported macOS type, the Typstella icon, and installer metadata without claiming ownership of `.typ` or `.typst` source files.
- [x] **V1-I.16 Route OS-open events safely.** Handle cold launch and single-instance handoff, queue requests until initialization completes, canonicalize and deduplicate paths, focus the existing window, and invoke the same import controller used by the File menu.
- [x] **V1-I.17 Test packaged double-click import.** Verify association, icon, cold/warm launch, spaces and Unicode paths, corrupt archives, repeated events, cancellation, and uninstall cleanup on every supported installer format.
- [x] **V1-I.18 Capture effective render fonts.** Union exact faces declared by project typography configuration with faces resolved by the bound compilation; do not rely on regex/source scanning or family names alone.
- [x] **V1-I.19 Add font provenance and license validation.** Parse supported font formats, embedding restrictions, source metadata, redistribution/modification permission, and generated-font provenance; produce actionable blockers.
- [x] **V1-I.20 Build the packaged font payload.** Copy exact verified faces into `.typstella/fonts/package/`, use deterministic names, hash every file, and record all face/style/variation metadata in the manifest.
- [x] **V1-I.21 Verify hermetic rendering.** Before finalizing export, compile against the packaged font directory with ordinary system resolution excluded or audited; fail if a different or missing face is selected.
- [x] **V1-I.22 Load imported fonts project-locally.** Verify hashes and font structure, prioritize packaged faces for the workspace's Tinymist/Typst processes, and never register them with the OS.
- [x] **V1-I.23 Add font-package security limits.** Bound file size, total font bytes, collection face count, parsing time, supported formats, normalized paths, and duplicate family/PostScript identities.
- [x] **V1-I.24 Test font reproducibility.** Cover clean machines, conflicting system versions, variable fonts, math/symbol fonts, CJK and complex scripts, Khmer shaping, scaled generated fonts, restricted licenses, corrupt fonts, and cross-platform PDF comparison.

### Acceptance criteria

- [ ] Exported projects state the exact compiler environment used to produce them.
- [ ] Import never extracts project content before archive validation and destination confirmation.
- [ ] A compatible managed toolchain can be installed from the import dialog and is selected for that workspace.
- [ ] Choosing another version displays a persistent compatibility warning but does not prevent deliberate use.
- [ ] Double-clicking a `.typstella` file opens one validated import flow in either a new or already-running Typstella instance.
- [ ] A `.typstella` export contains every exact font face used by its validated render or fails with an actionable font/license report.
- [ ] Import preview and PDF export use only the verified packaged font identities regardless of conflicting system fonts.
- [ ] No imported font is installed globally, and malformed/untrusted font payloads are rejected before renderer initialization.
- [ ] Ordinary `.typ` sources still compile outside Typstella.
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

Start writing with Typstella and Typst.
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
- [ ] Generated projects are ordinary Typst projects and do not require Typstella to compile.
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

### v1.0 release gate

Typstella is eligible for v1.0 only when:

- all `V1-I`, `V1-N`, and `V1-S` acceptance criteria pass;
- no known data-loss, unsafe extraction, project corruption, or toolchain-selection blocker remains;
- Khmer editing and language-tool regression suites pass;
- long multi-file documents preview and export within documented limits;
- Windows and Linux release builds pass the full installer-to-export workflow;
- macOS is either verified to the same standard or clearly labeled with narrower support;
- documentation describes project format compatibility, recovery, privacy, supported platforms, and known limitations.

---

## Plan boundaries

Post-v1.0 work is tracked separately:

- [Typstella v1.x implementation plan](./V1X_IMPLEMENTATION_PLAN.md)
- [Typstella v2 implementation plan](./V2_IMPLEMENTATION_PLAN.md)

## Recommended priority order

1. Finish `V1-S` foundations that protect user data.
2. Implement the versioned archive contract, secure import preflight, and self-contained font packaging.
3. Implement workspace-bound toolchain selection and download flow.
4. Complete transactional import/export, file association, and cross-platform tests.
5. Implement the shared new-project service and blank template.
6. Add technical report, IEEE-style paper, thesis, and book templates one at a time with compile fixtures.
7. Freeze features and run the v1.0 release-candidate period.
8. Begin [v1.x work](./V1X_IMPLEMENTATION_PLAN.md) only after the v1.0 release gate passes.
