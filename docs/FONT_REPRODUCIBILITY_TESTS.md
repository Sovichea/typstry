# Font Reproducibility Release Tests

Run on clean Windows, Linux, and macOS virtual machines using packaged Typstella builds.

- Export/import a Latin project with regular, bold, italic, math, and symbol faces.
- Repeat with Khmer shaping, another complex script, CJK, a variable font, a TTC collection, and a Typstella-generated scaled font.
- Install a conflicting system font with the same family but another PostScript identity; imported preview and PDF must use the packaged identity.
- Remove every source system font after export, import the project, and verify preview/PDF still compile.
- Compare resolved PostScript sets and normalized PDF page raster hashes across platforms. Record raster tolerances separately from identity failures.
- Confirm restricted embedding, missing/unrecognized licenses, corrupt data, incorrect indices, hash mismatches, duplicates, oversized files, excessive collection faces, and excessive total bytes are rejected before renderer startup.
- Confirm imported fonts never appear in the OS font registry/catalog after preview, export, restart, or uninstall.
- Confirm an ordinary source ZIP contains no packaged fonts or reproducibility claim.
