// Cross-origin isolation service worker.
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
    try {
      // bypass the HTTP cache so header updates apply on the next reload
      const resp = await fetch(req, { cache: "no-store", redirect: "follow" });
      const headers = new Headers(resp.headers);
      headers.set("Cross-Origin-Opener-Policy", COOP);
      headers.set("Cross-Origin-Embedder-Policy", COEP);
      return new Response(resp.body, {
        status: resp.status,
        statusText: resp.statusText,
        headers
      });
    } catch (e) {
      return fetch(req);
    }
  })());
});
