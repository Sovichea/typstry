Below is a concrete implementation plan for **Typstry non-destructive Khmer render preparation**.

Goal:

```text
User source files stay clean.
Generated preview/export files receive Khmer word-boundary markers.
Typst/Tinymist renders the generated files.
Editor, diagnostics, and reverse sync map back to original files.
```

---

# Typstry Khmer Render Preparation Implementation Plan

## 0. Core principle

Never modify the user’s `.typ` source files automatically.

Instead, Typstry should maintain two document representations:

```text
Authoring source
  main.typ
  chapters/intro.typ

Rendering source
  .typstry/cache/render/main.typ
  .typstry/cache/render/chapters/intro.typ
```

The rendering source may contain inserted `U+200B` zero-width spaces, but the authoring source should remain unchanged.

---

# Phase 1: Minimal non-destructive renderer

## Objective

Prove that Typstry can compile a generated `.typ` file instead of the original source file.

At this stage, do not worry about reverse sync, diagnostics mapping, or perfect Typst parsing.

## Output structure

For a project like this:

```text
project/
  main.typ
  template.typ
  chapters/
    intro.typ
  figures/
    diagram.png
```

Typstry should generate:

```text
project/
  .typstry/
    cache/
      render/
        main.typ
        template.typ
        chapters/
          intro.typ
        figures/
          diagram.png
```

Source files are copied or symlinked into the render cache. Typst compiles:

```text
.typstry/cache/render/main.typ
```

instead of:

```text
main.typ
```

## Recommended approach

Use **project mirroring** first.

That means the cache directory mirrors the original project structure. This avoids complicated path rewriting.

Preferred:

```text
Source file       → generated segmented copy
Asset file        → symlink or copied file
Directory         → mirrored directory
```

Example:

```text
main.typ                  → .typstry/cache/render/main.typ
chapters/intro.typ        → .typstry/cache/render/chapters/intro.typ
figures/diagram.png       → .typstry/cache/render/figures/diagram.png
refs.yml                  → .typstry/cache/render/refs.yml
```

This keeps imports working:

```typst
#import "template.typ": *
#include "chapters/intro.typ"
#image("figures/diagram.png")
#bibliography("refs.yml")
```

because the generated render tree has the same relative paths.

## Implementation tasks

Create a Rust module:

```text
src-tauri/src/render_prepare/
  mod.rs
  mirror.rs
  scanner.rs
  segment.rs
  sourcemap.rs
```

Initial public API:

```rust
pub struct RenderPrepareOptions {
    pub enable_khmer_zws: bool,
    pub project_root: PathBuf,
    pub entry_file: PathBuf,
    pub cache_root: PathBuf,
    pub generate_source_map: bool,
}

pub struct RenderPrepareResult {
    pub generated_entry_file: PathBuf,
    pub changed_files: Vec<PathBuf>,
    pub warnings: Vec<RenderPrepareWarning>,
}
```

Main function:

```rust
pub fn prepare_render_project(
    options: RenderPrepareOptions,
) -> anyhow::Result<RenderPrepareResult>
```

---

# Phase 2: Conservative Typst text scanner

## Objective

Insert Khmer word boundaries only in safe visible text regions.

Do **not** try to fully parse Typst yet. Build a conservative scanner that avoids dangerous regions.

## First supported segmentation region

Segment plain markup text:

```typst
នេះជាអត្ថបទស្រាវជ្រាវជាភាសាខ្មែរ។
```

Generated:

```typst
នេះ​ ជា​ អត្ថបទ​ ស្រាវជ្រាវ​ ជា​ ភាសា​ ខ្មែរ។
```

or preferably no visible space, only ZWS:

```text
នេះ\u200bជា\u200bអត្ថបទ\u200bស្រាវជ្រាវ\u200bជា\u200bភាសា\u200bខ្មែរ។
```

## Skip these regions in MVP

Do not segment inside:

```typst
#import "..."
#include "..."
#let variable = ...
#show ...
#set ...
#bibliography("...")
#image("...")
#cite(<...>)
$ math $
`raw`
```

Also skip:

```text
URLs
file paths
labels
references
comments
code blocks
inline raw text
```

## Scanner states

Implement a simple state machine:

```rust
enum TypstScanState {
    MarkupText,
    CodeExpression,
    String,
    Math,
    RawInline,
    RawBlock,
    LineComment,
    BlockComment,
}
```

For the first version, only transform text when:

```rust
state == TypstScanState::MarkupText
```

Everything else is copied unchanged.

## Conservative rule

When unsure, do not segment.

This is important. A false negative only means the preview is not perfectly broken in one place. A false positive can break the Typst document.

---

# Phase 3: Khmer run detection and ZWS insertion

## Objective

Within safe markup text, detect Khmer text runs, segment them, and insert ZWS between words.

## Pipeline

```text
safe text chunk
→ split into Khmer and non-Khmer runs
→ segment Khmer runs
→ insert U+200B between segmented Khmer words
→ preserve original punctuation and Latin text
```

Example input:

```text
Typstry គាំទ្រការសរសេរអត្ថបទស្រាវជ្រាវក្នុងភាសាខ្មែរ។
```

Possible generated output:

```text
Typstry គាំទ្រ\u200bការ\u200bសរសេរ\u200bអត្ថបទ\u200bស្រាវជ្រាវ\u200bក្នុង\u200bភាសា\u200bខ្មែរ។
```

## Do not insert ZWS

Avoid inserting ZWS:

```text
before punctuation
after opening punctuation
inside existing ZWS-separated text
inside numbers
inside Latin words
inside URLs
inside Typst syntax
```

## Suggested function

```rust
pub fn prepare_khmer_text_for_rendering(
    input: &str,
    segmenter: &KhmerSegmenter,
) -> PreparedText
```

Return both text and mapping information:

```rust
pub struct PreparedText {
    pub output: String,
    pub mappings: Vec<TextMapping>,
}
```

Even if source maps are not used immediately, generate mapping data from the beginning.

---

# Phase 4: Source map generation

## Objective

Every generated render file should have a map back to its original file.

Generated files contain inserted characters that do not exist in the original source. Reverse sync and diagnostics require a map.

## Source map file structure

For each generated file:

```text
.typstry/cache/maps/chapters/intro.typ.map.json
```

Example:

```json
{
  "version": 1,
  "source_file": "/project/chapters/intro.typ",
  "generated_file": "/project/.typstry/cache/render/chapters/intro.typ",
  "mappings": [
    {
      "generated_start": 0,
      "generated_end": 12,
      "source_start": 0,
      "source_end": 12,
      "kind": "original"
    },
    {
      "generated_start": 12,
      "generated_end": 15,
      "source_start": 12,
      "source_end": 12,
      "kind": "inserted_zws"
    }
  ]
}
```

## Mapping kinds

```rust
enum MappingKind {
    Original,
    InsertedZws,
    InsertedShy,
    GeneratedWrapper,
}
```

For inserted ZWS:

```text
generated_start..generated_end maps to source_start..source_start
```

That is a zero-length source span at the insertion boundary.

## Required lookup functions

```rust
pub fn generated_to_source(
    generated_file: &Path,
    generated_offset: usize,
) -> Option<SourcePosition>
```

```rust
pub fn source_to_generated(
    source_file: &Path,
    source_offset: usize,
) -> Option<GeneratedPosition>
```

For reverse sync, the first one is more important.

---

# Phase 5: Compile/export using generated entry file

## Objective

Typstry preview/export should compile the generated file.

Instead of:

```bash
typst compile main.typ
```

use:

```bash
typst compile .typstry/cache/render/main.typ
```

For Tinymist, the preview root should point to:

```text
.typstry/cache/render/main.typ
```

not the original `main.typ`.

## UX behavior

User opens:

```text
main.typ
```

Typstry internally previews:

```text
.typstry/cache/render/main.typ
```

The user should not need to know this unless debugging.

Show a small status indicator:

```text
Khmer render preparation: enabled
```

Optional debug command:

```text
Open generated render file
Open render source map
Clear render cache
```

---

# Phase 6: Live preview update pipeline

## Objective

When the user edits source files, regenerate affected render files and refresh preview.

## Watch flow

```text
User edits source
→ debounce
→ prepare affected file
→ update render cache
→ notify preview server
→ preview refreshes
```

Recommended debounce:

```text
150–300 ms
```

## Important optimization

Do not regenerate the whole project on every keystroke.

Start simple, but design for this:

```text
Changed file only → regenerate changed render file
Entry/import graph changed → regenerate affected files
Asset changed → update symlink/copy only
```

## Cache key

For each `.typ` file:

```text
cache_key = hash(source_content)
          + hash(segmenter_dictionary_version)
          + render_prepare_version
          + options
```

If unchanged, skip regeneration.

---

# Phase 7: Diagnostics mapping

## Objective

Typst diagnostics will refer to generated cache files. Typstry should show them on original files.

Example Typst diagnostic:

```text
.typstry/cache/render/chapters/intro.typ:42:10
```

Typstry should map it back to:

```text
chapters/intro.typ:42:7
```

because inserted ZWS may shift offsets.

## Implementation

When receiving a diagnostic:

```text
generated file + generated range
→ load corresponding source map
→ map generated range to source range
→ display diagnostic in editor
```

For inserted ZWS-only locations, map to nearest original position.

## Rule

If mapping fails, show the diagnostic but indicate it came from the generated render file.

Do not hide errors.

---

# Phase 8: Reverse sync

## Objective

When the user clicks in preview, Typstry should jump to the correct original source location.

Preview position comes from generated file:

```text
generated render file + generated offset/range
```

Map it to:

```text
original source file + source offset/range
```

using the source map.

## Inserted ZWS behavior

If click lands on inserted ZWS:

```text
ខ្មែរ\u200bស្រាវជ្រាវ
```

map to the boundary between the two original words.

Suggested policy:

```text
Inserted ZWS after word → source offset at end of previous word
Inserted ZWS before word → source offset at start of next word
```

Pick one and keep it consistent. I recommend mapping to the **end of the previous word**.

---

# Phase 9: Better Typst syntax support

## Objective

Gradually expand where segmentation is allowed.

After MVP, add support for visible strings in known functions.

Safe candidates:

```typst
#heading("ការណែនាំ")
#figure(caption: "រូបភាពប្រព័ន្ធ")
#table(caption: "តារាងលទ្ធផល")
```

Risky candidates:

```typst
#image("ឯកសារ.png")
#bibliography("ឯកសារ.yml")
#cite(<paper-key>)
#label("...")
```

## Suggested strategy

Maintain a whitelist of visible-text contexts.

Example:

```rust
enum StringContext {
    VisibleText,
    FilePath,
    Identifier,
    CitationKey,
    Unknown,
}
```

Only segment:

```rust
StringContext::VisibleText
```

Skip:

```rust
FilePath
Identifier
CitationKey
Unknown
```

---

# Phase 10: Settings and controls

## Required settings

Add project/user settings:

```json
{
  "khmerRenderPreparation": {
    "enabled": true,
    "insertZws": true,
    "insertShy": false,
    "segmentPlainMarkupText": true,
    "segmentVisibleStrings": false,
    "debugGeneratedFiles": false
  }
}
```

## Per-file/per-region directives

Support comments:

```typst
// typstry: disable-khmer-render-prep
```

```typst
// typstry: enable-khmer-render-prep
```

Maybe later:

```typst
// typstry: no-segment-start
...
// typstry: no-segment-end
```

This is useful for special cases, poems, code examples, or documents where exact spacing matters.

---

# Phase 11: Testing plan

## Unit tests

Test scanner behavior:

```text
plain Khmer text → segmented
math → unchanged
raw block → unchanged
import path → unchanged
image path → unchanged
bibliography path → unchanged
comment → unchanged
mixed Khmer-English → only Khmer segmented
existing ZWS → not duplicated
```

## Source map tests

Test:

```text
generated_to_source on original text
generated_to_source on inserted ZWS
source_to_generated around inserted boundaries
diagnostic range mapping
multi-byte Khmer UTF-8 offsets
UTF-16 editor offsets if needed
```

## Integration tests

Test project mirroring:

```text
main.typ importing template.typ
main.typ including chapters/intro.typ
image path still works
bibliography path still works
generated entry compiles
```

## Visual regression tests

Create PDFs/screenshots for:

```text
narrow Khmer paragraph
justified Khmer paragraph
mixed Khmer-English paragraph
Khmer heading
Khmer figure caption
Khmer table caption
imported Khmer chapter
raw/code/math heavy document
```

Compare before/after render.

---

# Recommended implementation order

## Milestone 1: Render cache MVP

Deliverable:

```text
Typstry can generate .typstry/cache/render/main.typ
and compile from it.
```

Tasks:

```text
1. Create render_prepare module.
2. Mirror project directory.
3. For .typ files, copy unchanged.
4. For assets, symlink/copy.
5. Compile generated entry.
```

No segmentation yet.

---

## Milestone 2: Plain Khmer text segmentation

Deliverable:

```text
Plain Khmer paragraphs get ZWS in generated render files.
Original files remain unchanged.
```

Tasks:

```text
1. Add conservative scanner.
2. Segment only MarkupText state.
3. Insert U+200B.
4. Skip math/raw/code/comments.
5. Add unit tests.
```

---

## Milestone 3: Source map foundation

Deliverable:

```text
Every generated .typ file has a .map.json file.
```

Tasks:

```text
1. Emit mappings while writing generated file.
2. Add generated_to_source lookup.
3. Add source_to_generated lookup later if needed.
4. Test inserted ZWS mapping.
```

---

## Milestone 4: Preview integration

Deliverable:

```text
Live preview renders generated files.
Editor source remains clean.
```

Tasks:

```text
1. Change preview entry path to cache/render/main.typ.
2. Watch original source files.
3. Regenerate changed render files.
4. Refresh preview.
5. Add UI indicator.
```

---

## Milestone 5: Diagnostics mapping

Deliverable:

```text
Typst errors in generated files appear in original editor files.
```

Tasks:

```text
1. Intercept diagnostics from preview/compiler.
2. Convert generated path/range to source path/range.
3. Display mapped diagnostics.
4. Fallback gracefully if mapping fails.
```

---

## Milestone 6: Reverse sync

Deliverable:

```text
Clicking preview jumps to original source location.
```

Tasks:

```text
1. Capture preview-generated source location.
2. Map generated location to original source.
3. Jump editor to original file/offset.
4. Handle inserted ZWS locations.
```

---

## Milestone 7: Visible string support

Deliverable:

```text
Khmer headings/captions in simple string contexts can also be segmented.
```

Tasks:

```text
1. Track simple function contexts.
2. Whitelist visible-text arguments.
3. Keep file paths/cite keys untouched.
4. Add tests.
```

---

# Important technical recommendation

Start with **ZWS only**.

Do not insert SHY for Khmer in the initial render pipeline.

Use:

```text
U+200B ZERO WIDTH SPACE
```

for Khmer word-boundary opportunities.

Leave:

```text
U+00AD SOFT HYPHEN
```

for later Latin/technical hyphenation experiments, not Khmer segmentation.

This keeps the first version simpler and typographically safer.

---

# Final architecture

The final system should look like this:

```text
Original source files
        ↓
Typstry file watcher
        ↓
Render preparation pipeline
        ↓
.typstry/cache/render/*.typ
.typstry/cache/maps/*.map.json
        ↓
Typst/Tinymist preview/export
        ↓
Diagnostics/reverse sync
        ↓
Mapped back to original source files
```

The user experience should be simple:

```text
Write clean Khmer source.
Preview renders with correct Khmer line breaking.
Exported PDF has correct Khmer line breaking.
No invisible characters are inserted into the source unless explicitly requested.
```

That should be the core promise of Typstry’s second feature.
