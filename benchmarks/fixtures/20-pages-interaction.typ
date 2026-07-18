#set page(paper: "a4")
#set text(font: ("Linux Libertine", "New Computer Modern"), size: 10pt)

#for page in range(20) [
  = Interaction benchmark page #(page + 1)

  English research prose provides a repeatable Latin-script surface for preview interaction testing.

  ខ្លឹមសារស្រាវជ្រាវជាភាសាខ្មែរត្រូវបានដាក់បញ្ចូល ដើម្បីសាកល្បងទំព័រពហុភាសា។

  #text(lang: "ar", dir: rtl)[هذا نص بحثي عربي لاختبار عرض الصفحات متعددة اللغات.]

  #lorem(180)

  #if page < 19 { pagebreak() }
]
