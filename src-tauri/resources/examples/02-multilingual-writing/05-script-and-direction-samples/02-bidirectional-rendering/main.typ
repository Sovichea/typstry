#set document(title: "Bidirectional Text")
#set page(margin: 22mm)
// typsastra:typography:start
// typsastra:document-scripts [{"family":"New Computer Modern","script":"latin","scale":1,"language":"en-US"}]
#set text(
  font: ((name: "New Computer Modern", covers: regex("\p{scx=Latin}")),),
  size: 12pt,
)
// typsastra:typography:end

= Bidirectional Text

#block(
  inset: 10pt,
  fill: luma(235),
  [*Scope:* This example validates Typst output and font coverage. First-class
  RTL editor navigation, selection, deletion, and mixed-direction conformance
  are planned for Typsastra v0.9.0.],
)

Right-to-left passages can contain left-to-right names, times, numbers, and links. Set the language and direction on the passage rather than reversing the source text.

== Arabic

#block(
  width: 100%,
  inset: 12pt,
  stroke: 0.6pt + luma(180),
  text(lang: "ar", dir: rtl)[
    مرحبًا بالعالم. يبدأ الاجتماع الساعة #text(dir: ltr)[10:30 AM] في Studio B.

    رقم الإصدار هو #text(dir: ltr)[Typsastra 0.2.0]، ورقم الصفحة هو 42.
  ],
)

== Hebrew

#block(
  width: 100%,
  inset: 12pt,
  stroke: 0.6pt + luma(180),
  text(lang: "he", dir: rtl)[
    שלום עולם. הפגישה מתחילה בשעה #text(dir: ltr)[10:30 AM] בחדר B.

    גרסת היישום היא #text(dir: ltr)[Typsastra 0.2.0].
  ],
)

== Mixed table

#table(
  columns: (1fr, 1fr, auto),
  inset: 7pt,
  table.header([Language], [Description], [Time]),
  [Arabic], text(lang: "ar", dir: rtl)[موعد التحرير], [09:15],
  [Hebrew], text(lang: "he", dir: rtl)[פגישת עריכה], [11:45],
)
