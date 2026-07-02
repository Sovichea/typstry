#set document(title: "Typstry Unicode Examples")
#set page(margin: 24mm)
// typstry:typography:start
#set text(font: "MiSans Latin", size: 11pt)
// typstry:typography:end
#set heading(numbering: "1.")

= Typstry Unicode Examples

This workspace contains editable examples for learning Typst and testing multilingual documents.

== Examples

- `01-writing-basics`: Typst markup, tables, references, and equations.
- `02-mixed-scripts`: Latin, Greek, Cyrillic, Armenian, Georgian, Ethiopic, and IPA.
- `03-bidirectional-text`: Arabic and Hebrew alongside Latin text and numbers.
- `04-complex-script-shaping`: Khmer, Lao, Devanagari, Bengali, and Myanmar.
- `05-cjk-layout`: Chinese, Japanese, and Korean layout.
- `06-unicode-math`: Unicode symbols and mathematical notation.
- `07-khmer-example`: Khmer language document with Cetz circuit diagrams.
- `08-simple-thesis`: Three chapters demonstrating labels and cross-chapter references.
- `09-khmer-segmentation-comparison`: Illustrating the difference between no ZWS, with ZWS, and with ZWS+SHY.
- `templates/multilingual-article`: A reusable multi-file article structure.

Open any `main.typ` file from the explorer. These files are your own writable copies, so you can change them freely.

When Typstry detects a script that needs another font, choose the font you prefer from the notification or Settings.

Imported template sections start with `// @allow-preview`, so opening one directly enables its independent live preview.
