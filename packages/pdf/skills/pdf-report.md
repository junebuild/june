---
name: pdf-report
description: Write a document and deliver it as a PDF attachment with render_pdf.
when-to-use: the user asks for a PDF, a report or summary to download, print or forward, or a document to share.
---
# Delivering a PDF

1. Gather what the document needs first (query tools, earlier messages). Don't render a
   draft and then render again — each render_pdf call attaches another file.
2. Write the whole document as Markdown in one piece:
   - Open with a `#` title, then a one-paragraph summary of the key result.
   - Use `##` sections, short paragraphs, and bullet lists for findings.
   - Put figures in tables (`| a | b |` with a `|---|---|` row); right-align numbers
     with `|--:|`.
   - Use code blocks only for code or queries.
   - Images are not supported: describe a chart's message in words or a table.
   - Write in the user's language, and pass it as `lang` (e.g. `zh-TW`, `en`, `ja`).
3. Call `render_pdf` with `markdown`, a descriptive `filename` (e.g.
   `revenue-2026-w41.pdf`), and `lang`.
4. Reply in one or two sentences: what the PDF covers and the headline number or
   conclusion. The user receives the file as an attachment — don't paste its content
   into the chat.
5. If render_pdf returns an error, read it, fix the Markdown, and try once more. If it
   fails again, give the user the content as a normal message and say the PDF couldn't
   be produced.
