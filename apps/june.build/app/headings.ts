// Heading anchors for markdown-rendered pages (docs + blog). The framework gives every
// heading in entry.html a GitHub-compatible id (@junejs/core/slug) and nothing else —
// how an anchor LOOKS is the app's call. This site adds a "#" link after h2–h4, shown
// on hover / keyboard focus (global.css .j-anchor). A heading authored as raw HTML may
// carry other attributes around its id; only the id matters here.

export function withAnchorLinks(html: string): string {
  return html.replace(/<h([234])(\s[^>]*)>([\s\S]*?)<\/h\1>/g, (m, level: string, attrs: string, inner: string) => {
    const id = /\sid="([^"]+)"/.exec(attrs)?.[1];
    if (!id) return m;
    return `<h${level}${attrs}>${inner}<a class="j-anchor" href="#${id}" aria-label="Link to this section">#</a></h${level}>`;
  });
}
