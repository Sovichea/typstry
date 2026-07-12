// Select another compatible family from Document typography if MiSans Khmer is not installed.
// typstella:typography:start
#set text(font: ("MiSans Latin", "MiSans Khmer"))
// typstella:typography:end
#set document(title: "Complex Script Shaping")
#set page(margin: 22mm)
#set text(size: 12pt)
#set par(leading: 0.9em)

= Complex Script Shaping

Complex scripts rely on correct character shaping, combining marks, and font fallback. Do not insert spaces between characters to imitate shaping.

#let sample(name, content) = block(
  width: 100%,
  inset: 11pt,
  radius: 5pt,
  stroke: 0.5pt + luma(185),
  [*#name* \
  #content],
)

#sample("Khmer", [សួស្តី​ពិភពលោក។ អក្សរខ្មែរត្រូវការការរៀបចំតួអក្សរដែលត្រឹមត្រូវ។])

#sample("Lao", [ສະບາຍດີໂລກ. ຕົວອັກສອນລາວຕ້ອງການການຈັດຮູບຮ່າງທີ່ຖືກຕ້ອງ.])

#text(size: 9.5pt, fill: luma(80))[_Note: Lao ICU4X word segmentation and optional `lo_LA` spellcheck are available in Settings → Language Tools._]

#sample("Devanagari", [नमस्ते दुनिया। देवनागरी में अक्षरों और मात्राओं का सही संयोजन आवश्यक है।])

#sample("Bengali", [নমস্কার বিশ্ব। বাংলা অক্ষর ও মাত্রার সঠিক বিন্যাস গুরুত্বপূর্ণ।])

#sample("Myanmar", [မင်္ဂလာပါ ကမ္ဘာ။ မြန်မာစာလုံးများ မှန်ကန်စွာ ပုံဖော်ရန် လိုအပ်သည်။])

== Script-specific scaling

Typstella can generate a uniformly scaled workspace-local font for preview while the source keeps a portable fallback stack:

```typ
#set text(font: ("Your Latin font", "Your preferred Khmer font"))
```
