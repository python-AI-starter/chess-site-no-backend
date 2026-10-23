// Stockfish 19 WASM engine host. The engine binaries (~94 MB with the
// embedded NNUE network) are fetched from a third-party CDN by the client
// and stored in the browser Cache Storage, so a repeat open of the analysis
// panel does not re-download them and the database never sees any engine
// traffic. The web worker is created from a blob: URL of the cached loader
// with the wasm reference patched to a blob: URL of the cached binary.
//
// Builds: the multi-threaded build needs cross-origin isolation
// (SharedArrayBuffer). Isolation is provided entirely in the client:
// coi-sw.js (registered by index.html) adds the COOP/COEP headers to page
// navigations, which works on any static host including GitHub Pages, so no
// server code is involved. With isolation the multi-threaded build gives a
// near-linear speedup with the Threads option; without it (service worker
// unavailable or blocked) the single-threaded build is used and Threads
// stays at 1. If the multi-threaded build fails to start, the host falls
// back to the single-threaded one automatically.
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
  function isIsolated() {
    return typeof crossOriginIsolated !== "undefined" && crossOriginIsolated;
  }
  // On the very first visit the service worker registers and reloads the
  // page; wait briefly so a fast click on the analysis panel does not start
  // downloading the single-threaded build right before the reload.
  async function isolated() {
    if (isIsolated()) return true;
    if (!(navigator.serviceWorker && (await navigator.serviceWorker.getRegistration()))) return false;
    await new Promise((res) => {
      const t0 = Date.now();
      const id = setInterval(() => {
        if (isIsolated() || Date.now() - t0 > 1500) { clearInterval(id); res(); }
      }, 100);
    });
    return isIsolated();
  }
  function buildNames(mt) {
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
    _mt: false,
    _mtFailed: false, // multi-threaded build tried and failed -> use single
    _options: [],     // applied "name X value Y" setoption payloads, replayed after a restart
    _lastSearch: null,// {fen, go} of the running/last search, replayed after a restart
    _wdTimer: null,   // watchdog timer
    WD_TIMEOUT: 10000,// max silence between engine outputs during a search

    status() { return this._status; },
    isMultiThreaded() { return !!this._mt; },
    // threads to suggest when the user has not chosen a value: half the
    // logical cores (Lichess-like default), capped to keep the UI responsive
    autoThreads() {
      const cores = navigator.hardwareConcurrency || 2;
      return Math.max(1, Math.min(8, Math.floor(cores / 2) || 1));
    },
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
      // pick the multi-threaded build when the page is cross-origin
      // isolated; if it fails to start, retry once with the single build
      const names = this._mtFailed ? buildNames(false) : buildNames(await isolated());
      this._mt = names.mt;
      // Cache Storage exists only in secure contexts; without it the
      // binaries are just re-fetched on each open
      const cache = ("caches" in window) ? await caches.open(CACHE_NAME).catch(() => null) : null;

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

      // UCI handshake; a broken multi-threaded build falls back to the
      // single-threaded one once (the pthread pool needs SharedArrayBuffer
      // to spawn threads)
      try {
        await this._handshake();
      } catch (e) {
        try { this._worker.terminate(); } catch (e2) {}
        this._worker = null;
        if (this._mt && !this._mtFailed) {
          this._mtFailed = true;
          this._mt = false;
          if (this._wasmUrl) { URL.revokeObjectURL(this._wasmUrl); this._wasmUrl = null; }
          if (this._jsUrl) { URL.revokeObjectURL(this._jsUrl); this._jsUrl = null; }
          await this._load();
          return;
        }
        throw e;
      }
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
      if (this._readyWait && /^readyok/.test(line)) this._readyWait.onreadyok();
      if (/^bestmove/.test(line)) this._disarmWatchdog();
      else if (/^info depth/.test(line)) this._feedWatchdog();
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

    // Wait for readyok. UCI input is serialized this way, which also gives
    // the thread pool time to settle after a Threads change: a search sent
    // back-to-back with the resize can deadlock the worker for good.
    ready(timeout) {
      if (this._readyWait) this._readyWait.onreadyok();   // settle a pending wait
      const wait = {};
      return new Promise((resolve, reject) => {
        wait.timer = setTimeout(() => {
          if (this._readyWait === wait) this._readyWait = null;
          reject(new Error("Engine did not respond (isready timeout)"));
        }, timeout || 10000);
        wait.onreadyok = () => {
          if (this._readyWait !== wait) return;
          clearTimeout(wait.timer);
          this._readyWait = null;
          resolve();
        };
        this._readyWait = wait;
        this._send("isready");
      });
    },

    // Apply option changes (payloads without the "setoption" prefix) and
    // wait for the engine to confirm; the list is replayed after a restart
    async configure(cmds) {
      this._options = cmds.slice();
      for (const c of this._options) this._send("setoption " + c);
      await this.ready();
    },

    // Start a search. The request is remembered so the watchdog can replay
    // it if the worker wedges.
    search(fen, movetime) {
      const go = movetime > 0 ? `go movetime ${movetime}` : "go infinite";
      if (this._lastSearch) this._send("stop");   // safe even when idle
      this._lastSearch = { fen, go };
      this._send(`position fen ${fen}`);
      this._send(go);
      this._armWatchdog();
    },

    // stop any current search and free the CPU (the worker stays alive:
    // closing the analysis panel must not re-download or re-instantiate)
    stopSearch() {
      this._lastSearch = null;
      this._disarmWatchdog();
      this._send("stop");
    },

    // Watchdog: a wedged worker (for example a search deadlocked after a
    // Threads change) would otherwise show "thinking" forever with no way
    // to recover from the UI. If no engine output arrives while a search
    // is running, the worker is rebuilt from the cached binaries and the
    // search is replayed; nothing is re-downloaded.
    _armWatchdog() {
      this._disarmWatchdog();
      this._wdTimer = setTimeout(() => this._wdFire(), this.WD_TIMEOUT);
    },
    _disarmWatchdog() {
      if (this._wdTimer) { clearTimeout(this._wdTimer); this._wdTimer = null; }
    },
    _feedWatchdog() {
      if (!this._lastSearch || !this._wdTimer) return;
      clearTimeout(this._wdTimer);
      this._wdTimer = setTimeout(() => this._wdFire(), this.WD_TIMEOUT);
    },
    async _wdFire() {
      this._wdTimer = null;
      if (!this._lastSearch || this._status !== "ready") return;
      const last = this._lastSearch;
      try { this._worker.terminate(); } catch (e) {}
      this._worker = null;
      this._status = "idle";
      this._loadingPromise = null;
      try {
        await this.ensure();
        if (this._status !== "ready") return;
        for (const c of this._options) this._send("setoption " + c);
        await this.ready().catch(() => {});
        this._send(`position fen ${last.fen}`);
        this._send(last.go);
        this._armWatchdog();
      } catch (e) {
        this._setStatus("error");
      }
    }
  };

  window.EngineHost = Host;
})();
