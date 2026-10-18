---
"@junejs/pdf": patch
---

PDF text direction now follows Unicode's bidi rules, and each block picks its own (#392). Before, the whole document took one direction, from `lang` or from the first letter's script. That missed text such as an Arabic heading starting with tatweel, and an Arabic quotation inside an English report stayed left to right.

- **Document direction.** It comes from `lang`, using the same language list Typst does. Without a `lang`, the first strong character by Unicode `Bidi_Class` decides (Unicode 17 data, generated and pinned by sha256).
- **Each block** — paragraph, heading, table cell, list — picks its own direction the same way, like HTML's `dir="auto"`, and is set right to left (or left to right) only where it differs.
  - A list turns as a whole, so the bullets stay with their items.
  - A right-to-left mark (U+200F) at the start of a block forces right to left.
- **Code blocks** count as they render: their HTML entities are not decoded when deciding direction.
- `render_pdf`'s `lang` description now says that it also sets the page direction.
