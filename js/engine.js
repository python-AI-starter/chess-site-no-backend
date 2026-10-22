// Stockfish 19 WASM engine host. The engine binaries (~94 MB with the
// embedded NNUE network) are fetched from a third-party CDN by the client
// and stored in the browser Cache Storage, so a repeat open of the analysis
// panel does not re-download them and the database never sees any engine
// traffic. The web worker is created from a blob: URL of the cached loader
// with the wasm reference patched to a blob: URL of the cached binary.
//
// Builds: the multi-threaded build needs cross-origin isolation
// (SharedArrayBuffer). The build is picked once per browser according to
// crossOriginIsolated; without isolation the single-threaded build is used
// and the Threads option stays at 1.
(function () {
  "use strict";

  const CFG = window.SITE_CONFIG;
  const VERSION = "19.0.1";
  // reliable third-party CDNs serving the npm package with CORS enabled
  const CDNS = [
    `https://unpkg.com/stockfish@${VERSION}/bin`,
    `https://cdn.jsdelivr.net/npm/stockfish@${VERSION}/bin`
  ];
  const CACHE_NAME = "ladya-sf19-v1";

  // single-threaded (works everywhere) vs multi-threaded (needs isolation)
  function buildNames() {
    const mt = typeof crossOriginIsolated !== "undefined" && crossOriginIsolated;
    return mt
      ? { js: "stockfish-19.js", wasm: "stockfish-19.wasm", mt: true }
      : { js: "stockfish-19-single.js", wasm: "stockfish-19-single.wasm", mt: false };
  }

  const Host = {
    _worker: null,
    _wasmUrl: null,   // blob URL kept alive for the whole page session
    _jsUrl: null,
    _status: "idle",  // idle | loading | ready | error
    _loadingPromise: null,
    _listeners: [],   // status change callbacks
    _lineHandlers: [],
    _progressSubs: [],// download progress callbacks

    status() { return this._status; },
    isMultiThreaded() { return !!this._mt; },
    onStatus(cb) { this._listeners.push(cb); return () => {
      const i = this._listeners.indexOf(cb); if (i >= 0) this._listeners.splice(i, 1);
    }; },
    onProgress(cb) { this._progressSubs.push(cb); return () => {
      const i = this._progressSubs.indexOf(cb); if (i >= 0) this._progressSubs.splice(i, 1);
    }; },
    _emitStatus() { for (const cb of this._listeners) { try { cb(this._status); } catch (e) {} } },
    _emitProgress(phase, got, total) {
      for (const cb of this._progressSubs) { try { cb(phase, got, total); } catch (e) {} }
    },
    _setStatus(s) { if (this._status !== s) { this._status = s; this._emitStatus(); } },

    // Load (and cache) the engine, then start the worker. Safe to call
    // repeatedly and from several panels: the download runs once.
    async ensure() {
      if (this._status === "ready") return this._worker;
      if (this._status === "loading") return this._loadingPromise;
      if (typeof WebAssembly !== "object") {
        this._setStatus("error");
        throw new Error("WebAssembly is not supported by this browser");
      }
      this._setStatus("loading");
      this._loadingPromise = this._load();
      try {
        await this._loadingPromise;
        this._setStatus("ready");
        return this._worker;
      } catch (e) {
        this._setStatus("error");
        this._loadingPromise = null;
        throw e;
      }
    },

    async _load() {
      const names = buildNames();
      this._mt = names.mt;
      const cache = await caches.open(CACHE_NAME).catch(() => null);

      // fetch with progress, then cache; or take straight from the cache
      const get = async (file, phase) => {
        const url = `${CFG.ENGINE_CDN_BASE || CDNS[0]}/${file}`;
        if (cache) {
          const hit = await cache.match(url).catch(() => null);
          if (hit) return await hit.blob();
        }
        let lastErr = null;
        for (const base of [CFG.ENGINE_CDN_BASE || CDNS[0], ...CDNS.filter(c => c !== (CFG.ENGINE_CDN_BASE || CDNS[0]))]) {
          const u = `${base}/${file}`;
          try {
            const resp = await fetch(u, { mode: "cors" });
            if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${u}`);
            let blob;
            if (resp.body) {
              const total = Number(resp.headers.get("content-length")) || 0;
              const reader = resp.body.getReader();
              const parts = [];
              let got = 0;
              for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                parts.push(value);
                got += value.length;
                this._emitProgress(phase, got, total);
              }
              blob = new Blob(parts, { type: resp.headers.get("content-type") || "application/octet-stream" });
            } else {
              blob = await resp.blob();
            }
            if (cache) {
              // re-wrap to drop Vary and keep only what is needed
              const clean = new Response(blob, { headers: {
                "content-type": resp.headers.get("content-type") || "application/octet-stream",
                "content-length": String(blob.size)
              } });
              await cache.put(url, clean).catch(() => {});
            }
            return blob;
          } catch (e) { lastErr = e; }
        }
        throw lastErr || new Error(`Failed to fetch ${file}`);
      };

      const jsBlob = await get(names.js, "js");
      const wasmBlob = await get(names.wasm, "wasm");
      if (this._wasmUrl) URL.revokeObjectURL(this._wasmUrl);
      this._wasmUrl = URL.createObjectURL(wasmBlob.slice(0, wasmBlob.size, "application/wasm"));
      if (this._jsUrl) URL.revokeObjectURL(this._jsUrl);
      this._jsUrl = URL.createObjectURL(new Blob([await jsBlob.text()], { type: "text/javascript" }));

      // The loader reads the wasm location from the worker URL hash
      // (its documented cross-origin mechanism): the blob worker gets the
      // cached loader, the hash carries the blob URL of the cached binary.
      this._worker = new Worker(this._jsUrl + "#" + encodeURIComponent(this._wasmUrl));
      this._worker.onmessage = (e) => this._onLine(typeof e.data === "string" ? e.data : (e.data && e.data.line) || "");
      this._worker.onerror = (e) => {
        console.error("Stockfish worker error:", e.message || e);
        this._setStatus("error");
      };

      // UCI handshake
      await this._handshake();
      this._send("setoption name UCI_AnalyseMode value true");
      this._send("ucinewgame");
    },

    _handshake() {
      return new Promise((resolve, reject) => {
        // cold start compiles a ~94 MB wasm module, allow generous time
        const to = setTimeout(() => { this._handshakeWait = null; reject(new Error("Engine did not respond (handshake timeout)")); }, 120000);
        this._handshakeWait = (line) => {
          if (/^uciok/.test(line)) {
            this._send("isready");     // the same handler then matches readyok
          } else if (/^readyok/.test(line)) {
            clearTimeout(to);
            this._handshakeWait = null;
            resolve();
          }
        };
        this._send("uci");
      });
    },

    _onLine(line) {
      if (this._handshakeWait) { this._handshakeWait(line); }
      for (const cb of this._lineHandlers) {
        try { cb(line); } catch (e) {}
      }
    },

    _send(cmd) { if (this._worker) this._worker.postMessage(cmd); },

    // subscribe to raw UCI lines; returns an unsubscribe function
    onLine(cb) {
      this._lineHandlers.push(cb);
      return () => {
        const i = this._lineHandlers.indexOf(cb);
        if (i >= 0) this._lineHandlers.splice(i, 1);
      };
    },

    send(cmd) { this._send(cmd); },

    // stop any current search and free the CPU (the worker stays alive:
    // closing the analysis panel must not re-download or re-instantiate)
    stopSearch() {
      this._send("stop");
    }
  };

  window.EngineHost = Host;
})();
