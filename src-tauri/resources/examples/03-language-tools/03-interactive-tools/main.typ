#set document(title: "Interactive Language Tools")
#set page(margin: 24mm)
// typstella:typography:start
#set text(font: ("MiSans Latin", "MiSans Khmer"), size: 11pt)
// typstella:typography:end
#set heading(numbering: "1.")
#set par(leading: 0.7em)

= Interactive Language Tools

Typstella offers interactive language tools such as spellcheck and word completion. These are controlled from Settings (`Ctrl+,`) and are independent of script-aware editor navigation.

== Khmer Spellcheck and Completion

Khmer support is bundled by default. Typstella will underline unknown words with a blue informational squiggle. 

Press the trigger key (usually `Ctrl+Space`) while your cursor is inside a Khmer word to see completion suggestions based on the current prefix.

រឿងព្រេងនិទានខ្មែរ គឺជារតនសម្បត្តិវប្បធម៌ដ៏មានតម្លៃ។

== English Spellcheck

English (US) spellcheck is also bundled. It identifies misspellings and suggests corrections.

This sentance contains an intentional typo. // <- intentional misspelling — right-click to correct

== Mixed Language Analysis

When you mix languages, Typstella automatically routes each script to the appropriate language provider. The Khmer segmenter only analyzes Khmer characters, and the English dictionary only checks Latin characters.

នៅក្នុងសៀវភៅដ៏តូចនេះ យើងសូមលើកយករឿង Typst examples មកបង្ហាញ។

== Installing Additional Languages

To add spellcheck and completion for other languages:
1. Open Settings (`Ctrl+,`).
2. Go to the *Language Tools* section.
3. Find your language in the catalog and click *Install*.

Typstella will download the dictionary and immediately activate it for your documents. You can safely remove dictionaries at any time.
