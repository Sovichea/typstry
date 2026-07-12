# Typstella Project Format

## Status

Schema version 1 is implemented through `V1-I.24`. It binds source to exact Typst/Tinymist versions, provides deterministic source integrity, secure transactional import, and verified project-local render fonts. An archive with `fontsPackaged: false` must not be described as hermetically render-reproducible.

## Container

- Extension: `.typstella`
- MIME type: `application/vnd.typstella.project`
- Container: ZIP
- Manifest: `.typstella/project.json`
- Source paths: UTF-8, relative, `/`-separated

Generated caches, `.git`, `.typstella`, `node_modules`, and `target` directories are excluded. The exporter adds only audited font payloads under `.typstella/fonts/package/`; other managed cache content remains excluded.

## Manifest v1

The locked frontend fixture is [`tests/fixtures/projectArchive/manifest-v1.json`](../tests/fixtures/projectArchive/manifest-v1.json).

```json
{
  "format": "com.typstella.project",
  "schemaVersion": 1,
  "createdBy": {
    "application": "Typstella",
    "version": "0.3.0"
  },
  "project": {
    "name": "example-project",
    "main": "main.typ"
  },
  "toolchain": {
    "typstVersion": "0.13.1",
    "tinymistVersion": "0.13.10",
    "compatibility": "exact"
  },
  "renderEnvironment": {
    "fontsPackaged": false
  },
  "fonts": [],
  "integrity": {
    "algorithm": "sha256",
    "files": {
      "main.typ": "2b83a4340c92d04b1d547efe022f78975c5c20e4b46baca9a502338b7f47a498"
    }
  }
}
```

## Required fields

- `format` must equal `com.typstella.project`.
- `schemaVersion` must equal `1` for the current implementation.
- `createdBy.application` must equal `Typstella`; its version is recorded without a timestamp so identical input remains deterministic.
- `project.name` is the Unicode workspace folder name.
- `project.main` is a safe relative `.typ` path and must appear in `integrity.files`.
- `toolchain.typstVersion` and `toolchain.tinymistVersion` are obtained from the active validated managed executable.
- `toolchain.compatibility` is `exact`.
- `renderEnvironment.fontsPackaged` states whether every declared/resolved render font is present and verified.
- `fonts` contains the packaged-font declarations. It is empty in the initial exporter.
- `integrity.algorithm` is `sha256`; every exported source file has one lowercase 64-character digest.

## Compatibility rules

1. A different `format` is not a Typstella project.
2. An unsupported `schemaVersion` is rejected. Future readers may ignore unknown optional fields only after the schema defines them as optional.
3. Exact toolchain compatibility means the recorded Tinymist build and its embedded Typst version are the preferred environment. Import override behavior is implemented in later tasks.
4. `fontsPackaged: false` means source/toolchain integrity is available but font equivalence is not guaranteed.
5. A path is invalid when it is absolute, contains `..`, uses backslashes, contains an empty component, or is not valid Unicode.
6. Every file must match its recorded digest before an import can be promoted successfully.

## Import preflight limits

Preflight reads the ZIP central directory and manifest only. Nothing is extracted at this stage.

- Maximum archive file size: 512 MiB.
- Maximum entries: 20,000.
- Maximum entry size: 256 MiB.
- Maximum total uncompressed size: 1 GiB.
- Maximum manifest size: 1 MiB.
- Maximum UTF-8 archive path: 512 bytes.
- Maximum compression ratio for entries larger than 1 MiB: 200:1.
- Encrypted entries, symbolic links, special files, non-UTF-8 names, unsafe relative paths, Windows reserved names, trailing dots/spaces, control characters, normalized Unicode collisions, and case-folded collisions are rejected.
- The non-directory archive entries must match `integrity.files` exactly, except for `.typstella/project.json` itself.

Import repeats preflight immediately before extraction and compares the manifest SHA-256 with the value shown to the user. Files are written into a hidden staging directory beside the destination, hashed while streaming, and promoted by directory rename only after every declared file verifies. Existing destination folders are never overwritten.

## Toolchain decision

The importer classifies the recorded toolchain as:

- `exact-active`: recorded Tinymist and embedded Typst are active;
- `exact-installed`: the exact pair is installed and can be selected;
- `download-required`: the recorded Tinymist must be downloaded and its reported embedded Typst version verified.

The user may deliberately import with the current toolchain after a separate warning, but Typstella displays that rendering compatibility is not guaranteed. A downloaded executable whose embedded Typst version differs from the manifest is rejected before extraction.

The manifest version is the project's **recommended** toolchain. Typstella stores the version actually selected for each workspace separately in workspace state. Reopening a workspace restores that selection before its LSP starts; selecting a version for one workspace does not rewrite another workspace's binding.

## Deterministic export

The exporter:

- recursively collects ordinary files while rejecting symbolic links and unsupported entry types;
- rejects case-insensitive archive-path collisions for cross-platform safety;
- sorts paths lexically;
- hashes stable file reads before constructing the manifest;
- writes the manifest first, then source files in sorted order;
- uses a fixed ZIP timestamp, permissions, and compression method;
- rereads and rehashes every file while writing, rejecting a file changed during export;
- stages the ZIP beside its destination and publishes it only after the writer finishes.

Empty directories are not stored because Typst projects do not require them to compile. A future schema may declare a required empty directory explicitly if a real workflow needs one.

## Font reproducibility

Export compiles the selected main document with the bound Tinymist/Typst toolchain and reads the exact PostScript face identities embedded in its PDF. This avoids guessing from family names or scanning Typst source. Every resolved identity must map to an exact file-backed face.

Typstella accepts TTF, OTF, and TTC payloads. It validates face indices, collection counts, OpenType structure and embedding flags, and requires a recognized redistributable license in font metadata. Missing provenance, restricted embedding, unrecognized licenses, corrupt fonts, and unresolved compiler faces block version-bound export. Generated scaled fonts must also permit modification.

Font files receive deterministic names derived from PostScript identity and SHA-256. Export recompiles with `--ignore-system-fonts` and only `.typstella/fonts/package/`; the resolved PostScript set must exactly match the original compile before the archive is published.

On import, font paths and hashes are validated during archive preflight and extraction. Before starting Tinymist, Typstella reparses every packaged face, checks its face index and digest, supplies the package directory through `TYPST_FONT_PATHS`, and disables ordinary system-font resolution. Fonts remain project-local and are never installed with the operating system.

Security limits are 64 MiB per font file, 256 MiB total packaged fonts, 64 faces per collection, and 128 declared faces. Duplicate normalized paths or PostScript-name/face-index identities are rejected. Cross-platform release verification is defined in [FONT_REPRODUCIBILITY_TESTS.md](FONT_REPRODUCIBILITY_TESTS.md).

## Source ZIP distinction

**Export Source ZIP** uses the same safe, sorted snapshot collector but does not include `.typstella/project.json`, toolchain compatibility, or integrity metadata. It is a convenience archive and carries no reproducible-rendering guarantee.

## Migration from folders and source ZIPs

Existing project folders remain valid Typstella workspaces. A legacy/source ZIP is not treated as a version-bound project: extract it with the operating system, open the extracted folder, select and test the intended toolchain, set the main file, then choose **File > Export Typstella Project**. This creates a new `.typstella` archive with explicit toolchain and integrity metadata. Typstella does not infer or promise compatibility for an ordinary folder or ZIP.

## Desktop association and OS-open routing

Packaged installers register `.typstella` as **Typstella Project** with MIME type `application/vnd.typstella.project` and the Typstella application icon. Typstella intentionally does not claim `.typ` or `.typst` files. Cold-launch arguments and warm single-instance events enter one native queue, which accepts existing `.typstella` files only, canonicalizes and deduplicates them, focuses the existing window, and invokes the same preflight/import controller as the File menu.

The installer acceptance procedure is documented in [PACKAGED_PROJECT_IMPORT_TESTS.md](PACKAGED_PROJECT_IMPORT_TESTS.md).
