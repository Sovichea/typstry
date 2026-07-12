#set document(
  title: "A Small Typst Document",
  author: "Typstella",
)
#set page(margin: 24mm)
// typstella:typography:start
#set text(font: "MiSans Latin", size: 11pt)
// typstella:typography:end
#set heading(numbering: "1.")

= A Small Typst Document <start>

Typst combines lightweight markup with functions and scripting. Text can be *strong*, _emphasized_, or linked to @summary.

== Lists and values

- Headings create a document outline.
- Labels make sections addressable.
- Functions control layout and styling.

#let measurements = (
  ("Alpha", 12.5),
  ("Beta", 18.2),
  ("Gamma", 15.7),
)

#table(
  columns: (1fr, auto),
  inset: 7pt,
  stroke: 0.5pt + luma(180),
  table.header([*Sample*], [*Value*]),
  ..measurements.map(row => (row.at(0), str(row.at(1)))).flatten(),
)

== Mathematics

The quadratic formula is

$ x = (-b plus.minus sqrt(b^2 - 4 a c)) / (2 a). $

== Summary <summary>

This section is referenced from the introduction. Hold Control and click the reference to navigate here.
