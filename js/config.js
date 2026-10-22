// Client configuration. Only the publishable key belongs here: it is
// meant for the browser and is protected by RLS policies in the database.
// The secret key (sb_secret_...) must never reach the frontend.
window.SITE_CONFIG = {
  SUPABASE_URL: "https://ypbxswichuimotfmmqaf.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_gIMha3lcktQgr129BRo46w_chlB34_v",
  SITE_NAME: "Ладья",
  // safety margin for flag claims: the conservative server-time estimate
  // must pass the deadline plus this margin before claiming
  FLAG_CLAIM_MARGIN_MS: 1000,
  // auto-claim the flag once the opponent clock reads zero
  AUTO_FLAG_DELAY_MS: 1200,
  // Stockfish 19 WASM (npm package "stockfish", ~94 MB with the embedded
  // NNUE net). Loaded by the browser from a third-party CDN and cached in
  // Cache Storage; the database is never involved. The base below must
  // serve the package /bin files with CORS enabled.
  ENGINE_CDN_BASE: "https://unpkg.com/stockfish@19.0.1/bin",
  // memory cap (MB) offered in the engine settings
  ENGINE_HASH_MAX_MB: 1024
};
