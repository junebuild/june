//! The engine's safe API on the host target: what it typesets with no host-supplied fonts,
//! how document-scoped fonts come and go, which characters no font covers, and what an error
//! looks like. The wasm32 C ABI is
//! exercised by the JS tests against the built module.

use june_pdf_typst_wasm::Engine;

/// The page count from the page tree root (`/Type/Pages … /Count n`), spacing-agnostic.
fn pages(pdf: &[u8]) -> usize {
    let s = String::from_utf8_lossy(pdf).replace(' ', "");
    let at = s.find("/Type/Pages").expect("a page tree");
    let rest = &s[at..];
    let count = &rest[rest.find("/Count").expect("a page count") + "/Count".len()..];
    count.chars().take_while(|c| c.is_ascii_digit()).collect::<String>().parse().unwrap()
}

#[test]
fn typesets_with_the_embedded_fonts_alone() {
    let mut engine = Engine::new();
    assert!(engine.font_count() > 0, "Typst's default fonts are embedded");
    let pdf = engine.compile("= Weekly revenue\n\nRevenue grew *12%*.\n\n#raw(\"let x = 1;\")".into()).expect("compiles").pdf;
    assert!(pdf.starts_with(b"%PDF-"));
    assert_eq!(pages(&pdf), 1);
    let text = String::from_utf8_lossy(&pdf);
    assert!(text.contains("LibertinusSerif"), "the body font is embedded in the PDF");
    assert!(text.contains("DejaVuSansMono"), "raw text uses the embedded monospace font");
}

#[test]
fn output_is_deterministic() {
    let mut engine = Engine::new();
    let source = "#set document(title: \"Q3\")\n= Q3\n\nSame input, same bytes.";
    assert_eq!(engine.compile(source.into()).unwrap().pdf, engine.compile(source.into()).unwrap().pdf);
}

#[test]
fn long_documents_paginate() {
    let mut engine = Engine::new();
    let body: String = (1..=80).map(|i| format!("== Section {i}\n\nParagraph {i} of the report.\n\n")).collect();
    assert!(pages(&engine.compile(body).unwrap().pdf) > 3);
}

#[test]
fn document_fonts_are_cleared_and_persistent_fonts_stay() {
    let mut engine = Engine::new();
    let base = engine.font_count();
    // A real font file from the embedded set, registered again under each scope.
    let font = typst_assets::fonts().next().unwrap().to_vec();
    assert_eq!(engine.add_document_font(font.clone()), 1);
    assert_eq!(engine.font_count(), base + 1);
    engine.clear_document_fonts();
    assert_eq!(engine.font_count(), base);
    assert_eq!(engine.add_font(font), 1);
    engine.clear_document_fonts();
    assert_eq!(engine.font_count(), base + 1);
}

#[test]
fn characters_no_font_covers_are_reported_once_in_document_order() {
    let mut engine = Engine::new();
    // The embedded fonts are Latin, Greek and Cyrillic: no CJK, no emoji.
    let out = engine.compile("= 報告 Report\n\nHello. 中文報告。 #raw(\"中\")\n\n- 😀".into()).expect("compiles");
    assert!(out.pdf.starts_with(b"%PDF-"), "the PDF is still produced; the host decides");
    assert_eq!(out.missing_glyphs, "報告中文。😀");
}

#[test]
fn covered_text_and_invisible_characters_report_nothing() {
    let mut engine = Engine::new();
    let out = engine.compile("Café — “quoted”, Ελληνικά, Русский.\u{200B}\u{00AD}\u{FE0F}".into()).unwrap();
    assert_eq!(out.missing_glyphs, "");
}

#[test]
fn bytes_that_are_not_a_font_add_nothing() {
    let mut engine = Engine::new();
    let base = engine.font_count();
    assert_eq!(engine.add_document_font(b"not a font".to_vec()), 0);
    assert_eq!(engine.font_count(), base);
}

#[test]
fn errors_name_the_problem_and_no_file_is_reachable() {
    let mut engine = Engine::new();
    let err = engine.compile("#let x = (".into()).unwrap_err();
    assert!(!err.is_empty());
    let err = engine.compile("#read(\"/etc/passwd\")".into()).unwrap_err();
    assert!(err.contains("denied"), "{err}");
    let err = engine.compile("#import \"@preview/cetz:0.3.0\": *".into()).unwrap_err();
    assert!(err.contains("denied"), "{err}");
    // The engine is still usable after an error.
    assert!(engine.compile("ok".into()).is_ok());
}
