#set document(title: "Main and Included Files")
#set page(margin: 24mm)
// typsastra:typography:start
// typsastra:document-scripts [{"family":"New Computer Modern","script":"latin","scale":1,"language":"en-US"}]
#set text(
  font: ((name: "New Computer Modern", covers: regex("\p{scx=Latin}")),),
  size: 11pt,
)
// typsastra:typography:end
#set heading(numbering: "1.")

= Main-document preview ownership

This `main.typ` owns the complete document preview.

#include "chapters/included.typ"

Open the included chapter in Explorer. Its editor tab changes, but the preview
continues to represent this complete main document. Use **Set as Main File** on
`main.typ` if the example was opened without a configured main file.
