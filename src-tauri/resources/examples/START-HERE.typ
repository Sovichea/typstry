#set document(title: "Typsastra Unicode Examples")
#set page(margin: 24mm)
// typsastra:typography:start
#set text(font: "MiSans Latin", size: 11pt)
// typsastra:typography:end
#set heading(numbering: "1.")

= Typsastra Unicode Examples

This workspace contains editable examples for learning Typst and testing multilingual documents.

== 01. Basics

- `01-writing-basics`: Typst markup, tables, references, and equations.
- `02-unicode-math`: Unicode symbols and mathematical notation.

== 02. Typography and Scripts

- `01-mixed-scripts`: Latin, Greek, Cyrillic, Armenian, Georgian, Ethiopic, and IPA.
- `02-bidirectional-text`: Arabic and Hebrew alongside Latin text and numbers.
- `03-complex-script-shaping`: Khmer, Lao, Devanagari, Bengali, and Myanmar.
- `04-cjk-layout`: Chinese, Japanese, and Korean layout.

== 03. Language Tools

Typsastra offers interactive language tools such as spellcheck and word completion, controlled from Settings (`Ctrl+,` or `Cmd+,`).

- `01-khmer-deep-support`: Khmer language document with Cetz circuit diagrams.
- `02-khmer-segmentation-comparison`: Khmer justify-only baseline, experimental render preparation, and recommended tracking-tuned justification.
- `03-interactive-tools`: A demonstration of the language tools layer, spellcheck, and typing word completion.
- `04-lao-enhanced-support`: A multi-file Lao document demonstrating word segmentation and optional spellcheck.

== 04. Projects

- `01-simple-thesis`: Three chapters demonstrating labels and cross-chapter references.
- `02-khmer-folklore-book`: A multi-file Khmer folklore book with five included stories and a table of contents.
- `03-typsastra-readme`: The Typsastra project README built as a Typst project.

== Templates

- `templates/multilingual-article`: A reusable multi-file article structure.

Open any `main.typ` file from the explorer. These files are your own writable copies, so you can change them freely.

When Typsastra detects a script that needs another font, choose the font you prefer from the notification or Settings.

Imported template sections use their configured main-document preview.
