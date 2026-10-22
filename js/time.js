// Server time synchronization. The offset is estimated conservatively,
// biased into the future: now() never reports earlier than true server
// time, so honest flag claims can only arrive late, never early.
(function () {
  "use strict";
  const T = {
    offset: 0,          // server - local, biased forward
    synced: false,
    _syncing: null
  };

  async function _sample() {
    const t0 = Date.now();
    const { data, error } = await API.rpc("server_now_ms");
    const t1 = Date.now();
    if (error || typeof data !== "number") return null;
    const rtt = t1 - t0;
    const serverAtMid = data;                    // server timestamp around mid-RTT
    const localAtMid = t0 + rtt / 2;
    // conservative bound: server clock >= localAtMid + best offset + rtt/2
    const offsetBest = serverAtMid - localAtMid;
    return { rtt, offset: offsetBest + rtt / 2 };
  }

  async function sync(force) {
    if (T._syncing && !force) return T._syncing;
    T._syncing = (async () => {
      let best = null;
      for (let i = 0; i < 4; i++) {
        const s = await _sample();
        if (s && (!best || s.rtt < best.rtt)) best = s;
      }
      if (best) { T.offset = best.offset; T.synced = true; }
      T._syncing = null;
    })();
    return T._syncing;
  }

  // conservative server time estimate, never earlier than true time
  function now() { return Date.now() + T.offset; }

  setInterval(() => sync(true).catch(() => {}), 120000);

  window.ServerTime = { sync, now };
})();
