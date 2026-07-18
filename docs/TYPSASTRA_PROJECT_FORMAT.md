# Typsastra Project Format

## Status

Schema version 2 provides deterministic source integrity, exact Typst/Tinymist toolchain binding, and secure transactional import. It deliberately does not redistribute fonts.

## Container

- Extension: `.typsastra`
- MIME type: `application/vnd.typsastra.project`
- Container: ZIP
- Manifest: `.typsastra/project.json`
- Source paths: UTF-8, relative, `/`-separated

Generated caches, generated PDFs, `.git`, `.typsastra`, `node_modules`, `target`, and font binaries are excluded. This includes fonts placed elsewhere in the workspace. New exports always use the Typsastra identifiers above.

## Manifest v2

The locked frontend fixture is [`tests/fixtures/projectArchive/manifest-v2.json`](../tests/fixtures/projectArchive/manifest-v2.json).

```json
{
  "format": "com.typsastra.project",
  "schemaVersion": 2,
  "createdBy": {
    "application": "Typsastra",
    "version": "0.5.0"
  },
  "project": {
    "name": "example-project",
    "main": "main.typ"
  },
  "toolchain": {
    "typstVersion": "0.15.0",
    "tinymistVersion": "0.15.0",
    "compatibility": "exact"
  },
  "integrity": {
    "algorithm": "sha256",
    "files": {
      "main.typ": "2b83a4340c92d04b1d547efe022f78975c5c20e4b46baca9a502338b7f47a498"
    }
  }
}
```

Required fields are the format and schema identifiers, creator, Unicode project name, safe relative main `.typ` path, exact toolchain versions, and a SHA-256 digest for every exported file. The main file must be present in the integrity map.

Schema v1 archives are intentionally unsupported. This prerelease breaking change removes the former font-package and render-environment fields instead of retaining obsolete compatibility options.

## Font redistribution policy

Typsastra project export never includes font binaries, regardless of their location, format, license, or Creative Commons/Open Font License status. The same rule applies to **Export Source ZIP**. Supported font extensions are filtered during export, and an imported project archive containing a font binary is rejected.

Recipients must install the fonts required by a document separately. Exact toolchain binding makes compiler behavior reproducible, but it cannot guarantee identical rendering when the same font faces are unavailable. Local generated fonts under `.typsastra/fonts/generated` remain available to the workspace that created them, but they are cache-like local artifacts and are never archived.

## Compatibility and import safety

An unsupported format or schema is rejected. Paths must be relative, Unicode, `/`-separated, and contain no empty, `.` or `..` components. Every extracted file must match its declared digest.

Preflight reads the ZIP central directory and manifest without extracting files. Limits are 512 MiB per archive, 20,000 entries, 256 MiB per entry, 1 GiB total uncompressed data, a 1 MiB manifest, 512-byte paths, and a 200:1 compression ratio for entries larger than 1 MiB. Encrypted entries, links, special files, unsafe names, Unicode/case collisions, and font binaries are rejected.

Import repeats preflight immediately before extraction and compares the manifest SHA-256 shown to the user. Files are streamed into a hidden staging directory, verified, and promoted by directory rename only after the complete archive succeeds. Existing destinations are never overwritten.

## Toolchain decision

The importer classifies the recorded toolchain as `exact-active`, `exact-installed`, or `download-required`. A downloaded Tinymist executable must report the recorded embedded Typst version. Users may deliberately override compatibility after a warning. The selected version is stored in workspace state and restored before the LSP starts.

## Deterministic export

The exporter collects ordinary files without following links, rejects cross-platform path collisions, excludes generated data and fonts, sorts paths lexically, hashes stable reads, and writes a fixed-timestamp ZIP through a staging file. It rereads and rehashes files while writing so concurrent changes fail the export. Empty directories are not stored.

## Source ZIP distinction

**Export Source ZIP** uses the same safe, font-free snapshot collector but omits the project manifest, toolchain binding, and integrity metadata. It is a lightweight source convenience archive, not a rendering-equivalence guarantee.

## Desktop association

Packaged installers register `.typsastra` as **Typsastra Project** with MIME type `application/vnd.typsastra.project`. Typsastra does not claim `.typ` or `.typst`. Installer acceptance is documented in [PACKAGED_PROJECT_IMPORT_TESTS.md](PACKAGED_PROJECT_IMPORT_TESTS.md).
