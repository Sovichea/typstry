#set document(title: "CJK Layout")
#set page(margin: 22mm)
// typstella:typography:start
#set text(font: "MiSans Latin", size: 11pt)
// typstella:typography:end
#set par(justify: true)

= CJK Layout

Language metadata affects punctuation and spacing behavior. Each passage below sets its language explicitly.

== Simplified Chinese

#text(lang: "zh", region: "CN")[
排版不仅是文字的排列，也是信息结构与阅读节奏的设计。中文与 Latin 文字、数字 2026 混排时，应保持自然的间距与换行。
]

== Traditional Chinese

#text(lang: "zh", region: "TW")[
排版不只是文字的排列，也是資訊結構與閱讀節奏的設計。中文與 Latin 文字、數字 2026 混排時，應保持自然的間距與換行。
]

== Japanese

#text(lang: "ja")[
多言語の文書では、句読点「、。」と括弧（ ）の配置、そして Latin 文字との間隔が読みやすさに影響します。
]

== Korean

#text(lang: "ko")[
다국어 문서에서는 문장 부호와 줄바꿈, 그리고 Latin 문자 및 숫자 2026과의 간격이 읽기 쉬운 조판에 중요합니다.
]
