//! The Typst → PDF engine behind `@junejs/pdf-typst-wasm` (docs/rfc-agent-files.md §4).
//!
//! Only `typst` + `typst-pdf`: none of typst.ts's IDE features (vector rendering, incremental
//! compilation, queries), and no wasm-bindgen glue — the module has zero imports, so the same
//! file instantiates on Node, Bun, Deno and Cloudflare Workers. Measured on the spike
//! (docs/rfc-agent-files.md, Appendix A): 2 ms Worker startup, 40 ms of CPU for a warm one-page
//! render in production.
//!
//! Fonts come in two scopes. Typst's own default fonts (Libertinus Serif, New Computer
//! Modern, DejaVu Sans Mono) are embedded, so a Latin document needs nothing from the host.
//! The host adds more: PERSISTENT fonts live as long as the engine (a family the app always
//! uses), DOCUMENT fonts are cleared before the next document (a CJK subset cut to one
//! document's characters) — one engine per isolate serves every request, and fonts must not
//! pile up in it.
//!
//! `Engine` is the safe API (tests use it); `ffi` is the C ABI the JS host calls.

use typst::diag::{FileError, FileResult, Severity, SourceDiagnostic};
use typst::foundations::{Bytes, Datetime, Duration};
use typst::syntax::{FileId, RootedPath, Source, VirtualPath, VirtualRoot};
use typst::text::{Font, FontBook};
use typst::utils::LazyHash;
use typst::{Library, LibraryExt, World};
use typst_layout::PagedDocument;

/// How long a memoized result survives unused, in compilations. Bounds the memo cache of an
/// engine that serves many different documents.
const MEMO_MAX_AGE: usize = 10;

pub struct Engine {
    library: LazyHash<Library>,
    persistent: Vec<Font>,
    document: Vec<Font>,
    book: LazyHash<FontBook>,
    main: FileId,
    source: Option<Source>,
}

impl Default for Engine {
    fn default() -> Self {
        Self::new()
    }
}

impl Engine {
    /// An engine with Typst's embedded default fonts.
    pub fn new() -> Self {
        let persistent: Vec<Font> = typst_assets::fonts().flat_map(|data| Font::iter(Bytes::new(data))).collect();
        let main = RootedPath::new(VirtualRoot::Project, VirtualPath::new("/main.typ").expect("a valid path")).intern();
        let mut engine = Self { library: LazyHash::new(Library::default()), persistent, document: Vec::new(), book: LazyHash::new(FontBook::new()), main, source: None };
        engine.rebuild_book();
        engine
    }

    /// Register a font file (TTF, OTF or a collection) for the engine's lifetime. Returns the
    /// number of faces it held; 0 means the bytes were not a font.
    pub fn add_font(&mut self, data: Vec<u8>) -> usize {
        let added = Font::iter(Bytes::new(data)).collect::<Vec<_>>();
        let n = added.len();
        self.persistent.extend(added);
        self.rebuild_book();
        n
    }

    /// Register a font file for the next document only (see `clear_document_fonts`).
    pub fn add_document_font(&mut self, data: Vec<u8>) -> usize {
        let added = Font::iter(Bytes::new(data)).collect::<Vec<_>>();
        let n = added.len();
        self.document.extend(added);
        self.rebuild_book();
        n
    }

    /// Drop the document-scoped fonts.
    pub fn clear_document_fonts(&mut self) {
        if !self.document.is_empty() {
            self.document.clear();
            self.rebuild_book();
        }
    }

    /// The number of font faces the engine can use.
    pub fn font_count(&self) -> usize {
        self.persistent.len() + self.document.len()
    }

    /// Typeset a Typst source into a PDF. The error is the document's error diagnostics, one
    /// per line, with their hints.
    pub fn compile(&mut self, source: String) -> Result<Vec<u8>, String> {
        self.source = Some(Source::new(self.main, source));
        let result = typst::compile::<PagedDocument>(&*self).output.and_then(|doc| typst_pdf::pdf(&doc, &typst_pdf::PdfOptions::default()));
        self.source = None;
        comemo::evict(MEMO_MAX_AGE);
        result.map_err(|diags| describe(&diags))
    }

    fn rebuild_book(&mut self) {
        self.book = LazyHash::new(FontBook::from_fonts(self.persistent.iter().chain(&self.document)));
    }
}

fn describe(diags: &[SourceDiagnostic]) -> String {
    let lines: Vec<String> = diags
        .iter()
        .filter(|d| d.severity == Severity::Error)
        .map(|d| {
            let mut line = d.message.to_string();
            for hint in &d.hints {
                line.push_str(" (hint: ");
                line.push_str(&hint.v);
                line.push(')');
            }
            line
        })
        .collect();
    if lines.is_empty() { "the document could not be typeset".into() } else { lines.join("\n") }
}

impl World for Engine {
    fn library(&self) -> &LazyHash<Library> {
        &self.library
    }
    fn book(&self) -> &LazyHash<FontBook> {
        &self.book
    }
    fn main(&self) -> FileId {
        self.main
    }
    fn source(&self, id: FileId) -> FileResult<Source> {
        match &self.source {
            Some(s) if id == self.main => Ok(s.clone()),
            // No file system and no packages: a document is one self-contained source.
            _ => Err(FileError::AccessDenied),
        }
    }
    fn file(&self, _id: FileId) -> FileResult<Bytes> {
        Err(FileError::AccessDenied)
    }
    fn font(&self, index: usize) -> Option<Font> {
        let n = self.persistent.len();
        if index < n { self.persistent.get(index).cloned() } else { self.document.get(index - n).cloned() }
    }
    fn today(&self, _offset: Option<Duration>) -> Option<Datetime> {
        None // deterministic output; a document that needs today's date gets it from the host
    }
}

/// The C ABI for the JS host: one engine per module instance, single-threaded. Buffers are
/// allocated in this module's memory with `alloc` and handed over; the result of the last call
/// that produces one is read through `output_ptr` / `output_len`.
#[cfg(target_arch = "wasm32")]
mod ffi {
    use std::cell::RefCell;

    use super::Engine;

    thread_local! {
        static ENGINE: RefCell<Option<Engine>> = const { RefCell::new(None) };
        static OUTPUT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
    }

    fn with_engine<T>(f: impl FnOnce(&mut Engine) -> T) -> T {
        ENGINE.with(|cell| f(cell.borrow_mut().get_or_insert_with(Engine::new)))
    }

    // Buffers cross the ABI as boxed slices: a Box<[u8]>'s allocation is exactly `len` bytes,
    // so the host's (ptr, len) pair is all it takes to rebuild it. A Vec's capacity may exceed
    // the length it was asked for, and rebuilding one with the wrong capacity is undefined
    // behavior.
    fn rebuild(ptr: *mut u8, len: usize) -> *mut [u8] {
        std::ptr::slice_from_raw_parts_mut(ptr, len)
    }

    /// # Safety
    /// `ptr`/`len` must describe a buffer from `alloc`; ownership moves to the callee.
    unsafe fn take(ptr: *mut u8, len: usize) -> Vec<u8> {
        unsafe { Box::from_raw(rebuild(ptr, len)) }.into_vec()
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn alloc(len: usize) -> *mut u8 {
        Box::into_raw(vec![0u8; len].into_boxed_slice()).cast::<u8>()
    }

    /// # Safety
    /// `ptr`/`len` must come from `alloc` and not have been handed over.
    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn dealloc(ptr: *mut u8, len: usize) {
        drop(unsafe { Box::from_raw(rebuild(ptr, len)) });
    }

    /// Initialize the engine (embedded fonts) ahead of the first document.
    #[unsafe(no_mangle)]
    pub extern "C" fn init() -> usize {
        with_engine(|e| e.font_count())
    }

    /// # Safety
    /// See `take`. `document` != 0 scopes the font to the next document.
    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn add_font(ptr: *mut u8, len: usize, document: u32) -> usize {
        let data = unsafe { take(ptr, len) };
        with_engine(|e| if document != 0 { e.add_document_font(data) } else { e.add_font(data) })
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn clear_document_fonts() {
        with_engine(|e| e.clear_document_fonts());
    }

    /// # Safety
    /// See `take`; the buffer holds UTF-8. Returns 0 with the PDF as output, or 1 with the
    /// error text as output.
    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn compile(ptr: *mut u8, len: usize) -> u32 {
        let bytes = unsafe { take(ptr, len) };
        let (status, out) = match String::from_utf8(bytes) {
            Err(_) => (1, b"the source is not UTF-8".to_vec()),
            Ok(source) => match with_engine(|e| e.compile(source)) {
                Ok(pdf) => (0, pdf),
                Err(msg) => (1, msg.into_bytes()),
            },
        };
        OUTPUT.with(|o| *o.borrow_mut() = out);
        status
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn output_ptr() -> *const u8 {
        OUTPUT.with(|o| o.borrow().as_ptr())
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn output_len() -> usize {
        OUTPUT.with(|o| o.borrow().len())
    }
}
