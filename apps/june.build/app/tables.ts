// Markdown tables can be wider than a phone screen, so each one scrolls inside its
// own box. A scroll box with nothing focusable inside is unreachable by keyboard —
// so every rendered <table> is wrapped in a focusable, named region, the same way
// the benchmarks page wraps its tables.
export function scrollableTables(html: string): string {
  return html
    .replace(/<table>/g, '<div class="j-table-scroll" tabindex="0" role="region" aria-label="Table"><table>')
    .replace(/<\/table>/g, "</table></div>");
}
