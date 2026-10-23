// Cross-origin isolation service worker and SPA fallback.
//
// GitHub Pages serves static files and cannot add custom response headers,
// while the multi-threaded Stockfish build needs SharedArrayBuffer, which
// the browser only exposes to a cross-origin isolated page (COOP + COEP on
// the document response). This worker adds the two headers to every page
// navigation itself, so the whole mechanism lives in the client and the
// site keeps a fully serverless architecture:
//   Cross-Origin-Opener-Policy: same-origin
//   Cross-Origin-Embedder-Policy: require-corp
//
// The same navigation handler doubles as the SPA fallback for the History
// API router: a client-side route such as /forum or /editor/<fen> has no
// file behind it, so the host would answer with its 404 page. The worker
// detects that and serves the app entry point instead, injecting a <base>
// tag with the registration scope so relative asset paths resolve against
// the app root at any route depth (project-page deployments included).
//
// The inline bootstrap in index.html registers this file and reloads the
// page once; from then on every navigation is served with the headers and
// window.crossOriginIsolated is true. Cross-origin subresources are safe
// under require-corp: the site fetches everything foreign (Supabase, the
// engine CDN) with CORS, and same-origin files need no extra headers.
"use strict";

const COOP = "same-origin";
const COEP = "require-corp";

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (event) => {
  const req = event.request;
  // only document responses carry COOP; other requests pass through
  if (req.mode !== "navigate") return;
  event.respondWith((async () => {
    const scopePath = new URL(self.registration.scope).pathname;
    const inApp = new URL(req.url).pathname.startsWith(scopePath);
    let resp;
    try {
      // bypass the HTTP cache so header updates apply on the next reload
      resp = await fetch(req, { cache: "no-store", redirect: "follow" });
    } catch (e) {
      try {
        resp = await fetch(scopePath + "index.html", { cache: "no-store" });
      } catch (e2) {
        return fetch(req);
      }
    }
    // SPA fallback: the host returned its error page for a client-side route
    if (inApp && !resp.ok) {
      try {
        const idx = await fetch(scopePath + "index.html", { cache: "no-store" });
        if (idx.ok) resp = idx;
      } catch (e) {}
    }
    const headers = new Headers(resp.headers);
    headers.set("Cross-Origin-Opener-Policy", COOP);
    headers.set("Cross-Origin-Embedder-Policy", COEP);
    const isHtml = (headers.get("content-type") || "").includes("text/html");
    if (inApp && resp.ok && isHtml) {
      try {
        let html = await resp.text();
        if (!/<base\s/i.test(html)) {
          html = html.replace(/<head([^>]*)>/i, `<head$1><base href="${scopePath}">`);
          headers.set("Content-Type", "text/html; charset=utf-8");
        }
        return new Response(html, { status: resp.status, statusText: resp.statusText, headers });
      } catch (e) { /* stream already consumed earlier: fall through */ }
    }
    return new Response(resp.body, {
      status: resp.status,
      statusText: resp.statusText,
      headers
    });
  })());
});
