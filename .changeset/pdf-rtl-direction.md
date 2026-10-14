---
"@junejs/pdf": patch
---

A right-to-left document is laid out right to left even without a `lang` (#392). Before, an Arabic or Hebrew document rendered with no `lang` came out left to right: the letters still joined, but headings and last lines sat on the left and closing punctuation landed on the wrong side. With no usable `lang`, the document's first letter now decides, the way Unicode's bidi rule P2 decides for a paragraph. If a `lang` is given, Typst still takes the direction from it.
