# Script-specific font assignments

This example demonstrates why ordinary fallback order is insufficient when a
script font contains glyphs for another script, and how Typsastra combines
Unicode `scx` coverage with independent script scaling.

## Try it

1. Open **Document Typography** from the `Aa` toolbar button.
2. Keep Khmer before Latin and confirm that each script uses its assigned font.
3. Change Khmer and Latin scales independently.
4. Apply the configuration and test forward and inverse sync.
5. Export the PDF and compare it with preview. Non-`1.0` scales are
   experimental because Typst may normalize generated fonts during PDF
   subsetting; use `1.0` for dependable PDF output.

Tutorial: <https://github.com/Sovichea/typsastra/blob/main/docs/tutorials/DOCUMENT_TYPOGRAPHY.md>
