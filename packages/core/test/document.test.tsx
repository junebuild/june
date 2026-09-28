import { describe, expect, test } from "bun:test";
import type React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { deployOrigin } from "@junejs/core/config";
import { Document, documentTitle, type DocumentConfig } from "@junejs/core/document";

const baseConfig: DocumentConfig = {
  site: { name: "Acme", titleTemplate: "%s — Acme", description: "Acme site" },
  speculationRules: null,
  speculationDelivery: "inline",
  viewTransitions: true,
};

describe("documentTitle()", () => {
  test("applies the title template", () => {
    expect(documentTitle({ title: "Posts" }, baseConfig.site)).toBe("Posts — Acme");
  });

  test("does not template the site name into 'Site — Site' on homepages", () => {
    expect(documentTitle({ title: "Acme" }, baseConfig.site)).toBe("Acme");
  });

  test("falls back to the site name with no metadata", () => {
    expect(documentTitle(undefined, baseConfig.site)).toBe("Acme");
  });
});

describe("Document PNG icon links", () => {
  test("links the host's icons beside the SVG favicon, under basePath", () => {
    const html = renderToStaticMarkup(
      <Document config={{ ...baseConfig, basePath: "/b", icons: { png: "/icon.png", appleTouch: "/apple-touch-icon.png" } }}>
        <main />
      </Document>,
    );
    expect(html).toContain(`<link rel="icon" href="/b/favicon.svg" type="image/svg+xml"/>`);
    expect(html).toContain(`<link rel="icon" href="/b/icon.png" type="image/png" sizes="32x32"/>`);
    expect(html).toContain(`<link rel="apple-touch-icon" href="/b/apple-touch-icon.png"/>`);
  });

  test("the app's own primary icon replaces the letter favicon, typed by extension", () => {
    const render = (icons: DocumentConfig["icons"], site = baseConfig.site) =>
      renderToStaticMarkup(
        <Document config={{ ...baseConfig, site, icons }}>
          <main />
        </Document>,
      );
    const png = render({ primary: "/favicon.png" });
    expect(png).toContain(`<link rel="icon" href="/favicon.png" type="image/png"/>`);
    expect(png).not.toContain("/favicon.svg");
    expect(render({ primary: "/favicon.ico" })).toContain(`<link rel="icon" href="/favicon.ico" type="image/x-icon"/>`);
    // icon.png as the primary isn't linked a second time.
    const iconPng = render({ primary: "/icon.png", png: "/icon.png" });
    expect(iconPng.match(/href="\/icon\.png"/g)).toHaveLength(1);
    // site.icon still wins.
    expect(render({ primary: "/favicon.png" }, { ...baseConfig.site, icon: "/brand.svg" })).toContain(
      `<link rel="icon" href="/brand.svg" type="image/svg+xml"/>`,
    );
  });

  test("no icons config → no extra links", () => {
    const html = renderToStaticMarkup(
      <Document config={baseConfig}>
        <main />
      </Document>,
    );
    expect(html).not.toContain("apple-touch-icon");
    expect(html).not.toContain(`type="image/png"`);
  });
});

describe("Document basePath (deploy subpath)", () => {
  const withAssets: DocumentConfig = {
    ...baseConfig,
    styles: "/_june/global.abc.css",
    moduleStyles: "/_june/modules.abc.css",
    clientScript: "/_june/client.abc.js",
    site: { ...baseConfig.site, icon: undefined },
  };

  test("prefixes root-absolute framework asset URLs with basePath", () => {
    const html = renderToStaticMarkup(
      <Document config={{ ...withAssets, basePath: "/openab/docs" }}>
        <main />
      </Document>,
    );
    expect(html).toContain('href="/openab/docs/_june/global.abc.css"');
    expect(html).toContain('href="/openab/docs/_june/modules.abc.css"');
    expect(html).toContain('src="/openab/docs/_june/client.abc.js"');
    expect(html).toContain('href="/openab/docs/favicon.svg"'); // generated favicon fallback
  });

  test("no basePath (default) leaves the root-absolute URLs untouched", () => {
    const html = renderToStaticMarkup(
      <Document config={withAssets}>
        <main />
      </Document>,
    );
    expect(html).toContain('href="/_june/global.abc.css"');
    expect(html).toContain('src="/_june/client.abc.js"');
    expect(html).toContain('href="/favicon.svg"');
  });

  test("never rewrites protocol-relative or absolute-URL assets", () => {
    const html = renderToStaticMarkup(
      <Document config={{ ...baseConfig, basePath: "/base", styles: "https://cdn.example/app.css", site: { icon: "//cdn.example/i.svg" } }}>
        <main />
      </Document>,
    );
    expect(html).toContain('href="https://cdn.example/app.css"');
    expect(html).toContain('href="//cdn.example/i.svg"');
    expect(html).not.toContain("/base/https:");
    expect(html).not.toContain("/base//cdn");
  });
});

describe("Document", () => {
  test("emits <meta charSet> (reminder #2: charset lives in the document)", () => {
    const html = renderToStaticMarkup(
      <Document config={baseConfig}>
        <main>hi</main>
      </Document>,
    );
    expect(html).toContain(`<meta charSet="utf-8"/>`);
    // charset must be early in <head> — before <title> — to land in the first 1024 bytes.
    expect(html.indexOf("charSet")).toBeLessThan(html.indexOf("<title>"));
  });

  test("renders the templated title and description", () => {
    const html = renderToStaticMarkup(
      <Document config={baseConfig} metadata={{ title: "Posts", description: "All posts" }}>
        <main />
      </Document>,
    );
    expect(html).toContain("<title>Posts — Acme</title>");
    expect(html).toContain(`name="description" content="All posts"`);
  });

  test("emits OpenGraph tags when openGraph metadata is present", () => {
    const html = renderToStaticMarkup(
      <Document
        config={baseConfig}
        metadata={{ title: "Posts", openGraph: { image: "https://cdn.acme.com/og.png" } }}
      >
        <main />
      </Document>,
    );
    expect(html).toContain(`property="og:title"`);
    expect(html).toContain(`property="og:image" content="https://cdn.acme.com/og.png"`);
  });

  test("view transitions: default cross-fade is a snappy 120ms, not the UA default", () => {
    const html = renderToStaticMarkup(
      <Document config={baseConfig}>
        <main />
      </Document>,
    );
    expect(html).toContain("@view-transition");
    expect(html).toContain("animation-duration: 120ms");
  });

  test("view transitions: a number sets the cross-fade duration", () => {
    const html = renderToStaticMarkup(
      <Document config={{ ...baseConfig, viewTransitions: 250 }}>
        <main />
      </Document>,
    );
    expect(html).toContain("animation-duration: 250ms");
  });

  test("view transitions: 'instant' activates with no animation (0ms)", () => {
    const html = renderToStaticMarkup(
      <Document config={{ ...baseConfig, viewTransitions: "instant" }}>
        <main />
      </Document>,
    );
    expect(html).toContain("@view-transition");
    expect(html).toContain("animation-duration: 0ms");
  });

  test("view transitions: false drops the @view-transition rule entirely", () => {
    const html = renderToStaticMarkup(
      <Document config={{ ...baseConfig, viewTransitions: false }}>
        <main />
      </Document>,
    );
    expect(html).not.toContain("@view-transition");
  });

  test("inlines speculation rules only with inline delivery", () => {
    const withRules: DocumentConfig = {
      ...baseConfig,
      speculationRules: JSON.stringify({ prerender: [] }),
    };
    const inline = renderToStaticMarkup(
      <Document config={withRules}>
        <main />
      </Document>,
    );
    expect(inline).toContain(`type="speculationrules"`);

    const header = renderToStaticMarkup(
      <Document config={{ ...withRules, speculationDelivery: "header" }}>
        <main />
      </Document>,
    );
    expect(header).not.toContain(`type="speculationrules"`);
  });
});

describe("Document social tags (on by default)", () => {
  const render = (props: Partial<React.ComponentProps<typeof Document>> = {}) =>
    renderToStaticMarkup(
      <Document config={baseConfig} {...props}>
        <main />
      </Document>,
    );

  test("a page with no openGraph metadata still unfurls", () => {
    const html = render({ metadata: { title: "Posts" }, pageUrl: "https://acme.com/posts?ref=x" });
    expect(html).toContain(`property="og:title" content="Posts — Acme"`);
    expect(html).toContain(`property="og:description" content="Acme site"`);
    expect(html).toContain(`property="og:type" content="website"`);
    expect(html).toContain(`property="og:site_name" content="Acme"`);
    expect(html).toContain(`property="og:locale" content="en"`);
    expect(html).toContain(`name="twitter:card" content="summary"`);
    // The query string is not part of the page's identity.
    expect(html).toContain(`rel="canonical" href="https://acme.com/posts"`);
    expect(html).toContain(`property="og:url" content="https://acme.com/posts"`);
  });

  test("site.url wins over the request origin and makes a relative og:image absolute", () => {
    const html = render({
      config: { ...baseConfig, site: { ...baseConfig.site, url: "https://acme.com/", lang: "zh-TW" } },
      metadata: { openGraph: { image: "/og/home.png", imageWidth: 1200, imageHeight: 630 } },
      pageUrl: "http://localhost:3000/about",
    });
    expect(html).toContain(`property="og:url" content="https://acme.com/about"`);
    expect(html).toContain(`property="og:image" content="https://acme.com/og/home.png"`);
    expect(html).toContain(`property="og:image:width" content="1200"`);
    expect(html).toContain(`property="og:image:height" content="630"`);
    expect(html).toContain(`property="og:image:alt" content="Acme"`);
    expect(html).toContain(`property="og:locale" content="zh_TW"`);
    expect(html).toContain(`name="twitter:card" content="summary_large_image"`);
  });

  test("with no public origin, URL-derived tags are omitted, not emitted wrong", () => {
    const html = render({ pageUrl: "https://prerender.june/about", metadata: { openGraph: { image: "/og.png" } } });
    expect(html).not.toContain("prerender.june");
    expect(html).not.toContain(`rel="canonical"`);
    expect(html).not.toContain(`property="og:url"`);
    // A root-relative image can't be resolved → dropped (and no large card for it).
    expect(html).not.toContain(`property="og:image"`);
    expect(html).toContain(`name="twitter:card" content="summary"`);
  });

  test("public origin precedence: locale domain > site.url > deploy domain > request", () => {
    const withDeploy = { ...baseConfig, deployOrigin: "https://acme.com" };
    // Prerendered: the deploy domain fills in for the placeholder host.
    expect(render({ config: withDeploy, pageUrl: "https://prerender.june/about" })).toContain(
      `property="og:url" content="https://acme.com/about"`,
    );
    // Live on another host (e.g. *.workers.dev): still canonicalizes to the deploy domain.
    expect(render({ config: withDeploy, pageUrl: "https://acme.workers.dev/about" })).toContain(
      `rel="canonical" href="https://acme.com/about"`,
    );
    // site.url beats the deploy domain.
    const withBoth = { ...withDeploy, site: { ...baseConfig.site, url: "https://www.acme.com" } };
    expect(render({ config: withBoth, pageUrl: "https://acme.com/about" })).toContain(
      `property="og:url" content="https://www.acme.com/about"`,
    );
    // A locale's own domain beats both: example.fr pages canonicalize to example.fr.
    expect(render({ config: withBoth, pageUrl: "https://acme.fr/a-propos", onLocaleDomain: true })).toContain(
      `rel="canonical" href="https://acme.fr/a-propos"`,
    );
  });

  test("an explicit canonical is kept (and absolutized); noindex pages get none by default", () => {
    const site = { ...baseConfig.site, url: "https://acme.com" };
    const explicit = render({
      config: { ...baseConfig, site },
      metadata: { canonical: "/posts" },
      pageUrl: "https://acme.com/posts/page/2",
    });
    expect(explicit).toContain(`rel="canonical" href="https://acme.com/posts"`);
    const noindex = render({
      config: { ...baseConfig, site },
      metadata: { title: "Not found", robots: "noindex" },
      pageUrl: "https://acme.com/missing",
    });
    expect(noindex).not.toContain(`rel="canonical"`);
  });

  test("twitter:site from site.twitter; twitter card and creator from metadata", () => {
    const html = render({
      config: { ...baseConfig, site: { ...baseConfig.site, twitter: "@acme" } },
      metadata: { twitter: { card: "summary", creator: "@jane" }, openGraph: { image: "https://cdn/x.png" } },
    });
    expect(html).toContain(`name="twitter:site" content="@acme"`);
    expect(html).toContain(`name="twitter:creator" content="@jane"`);
    expect(html).toContain(`name="twitter:card" content="summary"`);
  });

  test("the homepage carries WebSite JSON-LD, escaped against </script>", () => {
    const html = render({
      config: { ...baseConfig, site: { ...baseConfig.site, description: "a </script> b" } },
      pageUrl: "https://acme.com/",
      isHome: true,
    });
    expect(html).toContain(`<script type="application/ld+json">`);
    expect(html).toContain(`"@type":"WebSite"`);
    expect(html).toContain(`"url":"https://acme.com/"`);
    expect(html).toContain("a \\u003c/script> b");
    expect(render({ pageUrl: "https://acme.com/posts" })).not.toContain("ld+json");
  });

  const jsonLd = (html: string) =>
    JSON.parse(html.match(/<script type="application\/ld\+json">(.*?)<\/script>/)![1]!) as {
      "@context": string;
      "@graph": Record<string, any>[];
    };

  test("no organization declared → the @graph is the WebSite alone (nothing invented)", () => {
    const ld = jsonLd(render({ config: { ...baseConfig, site: { ...baseConfig.site, twitter: "@acme" } }, pageUrl: "https://acme.com/", isHome: true }));
    expect(ld["@context"]).toBe("https://schema.org");
    expect(ld["@graph"].map((n) => n["@type"])).toEqual(["WebSite"]);
    expect(ld["@graph"][0]!.publisher).toBeUndefined();
  });

  test("site.organization → an Organization the WebSite names as publisher", () => {
    const ld = jsonLd(
      render({
        config: {
          ...baseConfig,
          site: {
            ...baseConfig.site,
            name: "Acme",
            icon: "/logo.svg",
            twitter: "@acme",
            organization: {
              email: "hi@acme.com",
              sameAs: ["https://github.com/acme", "https://x.com/acme"],
              address: { addressLocality: "Springfield", addressCountry: "US" },
            },
            jsonLd: { "@context": "https://schema.org", "@type": "SoftwareApplication", name: "Acme CLI", publisher: { "@id": "https://acme.com/#organization" } },
          },
        },
        pageUrl: "https://acme.com/",
        isHome: true,
      }),
    );
    const [site, org, app] = ld["@graph"];
    expect(site!.publisher).toEqual({ "@id": "https://acme.com/#organization" });
    expect(org).toMatchObject({
      "@type": "Organization",
      "@id": "https://acme.com/#organization",
      name: "Acme",
      url: "https://acme.com/",
      logo: "https://acme.com/logo.svg",
      // declared profiles + the twitter handle's, deduped
      sameAs: ["https://github.com/acme", "https://x.com/acme"],
      contactPoint: { "@type": "ContactPoint", contactType: "customer support", email: "hi@acme.com" },
      address: { "@type": "PostalAddress", addressLocality: "Springfield", addressCountry: "US" },
    });
    // app-authored nodes join the graph; their own @context is dropped
    expect(app).toEqual({ "@type": "SoftwareApplication", name: "Acme CLI", publisher: { "@id": "https://acme.com/#organization" } });
  });

  test("under a basePath, the @ids are site-home-based but the organization's url defaults to the origin", () => {
    const ld = jsonLd(
      render({
        config: {
          ...baseConfig,
          basePath: "/docs",
          site: { ...baseConfig.site, url: "https://acme.github.io", organization: { name: "Acme" } },
        },
        pageUrl: "https://prerender.june/",
        isHome: true,
      }),
    );
    const [site, org] = ld["@graph"];
    expect(site).toMatchObject({ "@id": "https://acme.github.io/docs/#website", url: "https://acme.github.io/docs/" });
    expect(org).toMatchObject({ "@id": "https://acme.github.io/docs/#organization", url: "https://acme.github.io/" });
  });

  test("basePath is part of the public URL", () => {
    const html = render({
      config: { ...baseConfig, basePath: "/docs", site: { ...baseConfig.site, url: "https://acme.github.io" } },
      metadata: { openGraph: { image: "/og.png" } },
      pageUrl: "https://prerender.june/intro",
    });
    expect(html).toContain(`property="og:url" content="https://acme.github.io/docs/intro"`);
    expect(html).toContain(`property="og:image" content="https://acme.github.io/docs/og.png"`);
  });
});

describe("deployOrigin()", () => {
  test("https://<deploy.domain>, or undefined", () => {
    expect(deployOrigin({ deploy: { domain: "acme.com" } })).toBe("https://acme.com");
    expect(deployOrigin({})).toBeUndefined();
  });
});

describe("Document theme-color", () => {
  const render = (config: DocumentConfig) =>
    renderToStaticMarkup(
      <Document config={config}>
        <main />
      </Document>,
    );

  test("June's starter look alone → the starter background", () => {
    expect(render(baseConfig)).toContain(`<meta name="theme-color" content="#fbfbf8"/>`);
  });

  test("an app stylesheet or cssReset:false → no guess", () => {
    expect(render({ ...baseConfig, styles: "/_june/global.css" })).not.toContain("theme-color");
    expect(render({ ...baseConfig, moduleStyles: "/_june/modules.css" })).not.toContain("theme-color");
    expect(render({ ...baseConfig, cssReset: false })).not.toContain("theme-color");
  });

  test("site.themeColor wins; { light, dark } emits one tag per colour scheme", () => {
    const one = render({ ...baseConfig, styles: "/g.css", site: { ...baseConfig.site, themeColor: "#07080a" } });
    expect(one).toContain(`<meta name="theme-color" content="#07080a"/>`);
    const both = render({ ...baseConfig, site: { ...baseConfig.site, themeColor: { light: "#fff", dark: "#000" } } });
    expect(both).toContain(`<meta name="theme-color" media="(prefers-color-scheme: light)" content="#fff"/>`);
    expect(both).toContain(`<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#000"/>`);
    expect(both).not.toContain(`content="#fbfbf8"`);
  });
});
