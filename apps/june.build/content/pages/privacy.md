---
title: Privacy
description: What june.build does with your requests — no accounts, no cookies, no analytics; one local theme setting, Google Fonts, and Cloudflare as the host.
---
## The short version

june.build has no accounts, sets no cookies, and runs no analytics or
advertising scripts. It does not ask for, store, or sell personal information.

## What stays in your browser

The theme switch remembers your choice (light or dark) in your browser's
`localStorage` under the key `june-theme`. It never leaves your device, and
clearing site data removes it.

## What the site processes

- **Page requests.** The site is served by Cloudflare Workers. Like any web
  host, Cloudflare receives your IP address, user agent and the URL you request
  in order to deliver the page and protect the network; see
  [Cloudflare's privacy policy](https://www.cloudflare.com/privacypolicy/).
  This site does not add its own request logging on top.
- **"Ask this site" searches.** A query typed into the search box is sent to
  this site's own `/mcp` endpoint, matched against the site's pages in memory,
  and answered. The query is not stored.
- **Agent traffic.** Requests to `/mcp`, `/api/*`, `/llms.txt` and the
  `.md`/`.json` versions of pages are handled the same way as page requests,
  with nothing retained beyond what the host processes.

## Third parties

Pages load the Geist typefaces from Google Fonts, so your browser requests
them from Google, which receives your IP address; see
[Google's privacy policy](https://policies.google.com/privacy). Links to
GitHub and npm take you to those services, whose own policies apply.

## Changes and questions

This page lives in the site's public repository, so every change to it is
visible in the
[commit history](https://github.com/junebuild/june/commits/main/apps/june.build/content/pages/privacy.md).
Questions go through the [contact page](/contact).
