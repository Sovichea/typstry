# Font-Free Project Export Tests

Run these checks for `.typsastra` and source ZIP exports on Windows, Linux, and macOS:

- Place TTF, OTF, TTC, OTC, WOFF, WOFF2, EOT, DFONT, FON, FNT, PFA, and PFB files at several workspace depths; none may appear in either export.
- Confirm legacy `.typsastra/fonts` content is removed during migration and generated PDFs and preview cache files remain excluded.
- Confirm source files, bibliography files, figures, and workspace settings still round-trip.
- Import a valid schema-v2 archive and verify source integrity and toolchain selection.
- Add a font binary directly to a crafted archive and confirm preflight rejects it before extraction.
- Add removed schema-v1 font-package fields to a schema-v2 manifest and confirm parsing rejects them.
- Confirm the import dialog explains that required fonts must be installed separately.
- Confirm a project using locally installed fonts and globally cached scaled variants still previews normally before export.
