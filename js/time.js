// ============================================================
//  Синхронизация серверного времени.
//  Оценка сдвига берётся КОНСЕРВАТИВНО (смещение в «будущее»):
//  теперь() >= реального серверного времени. Задержки сети могут
//  только опоздать — значит честный клиент заявляет флаг С
//  ОПОЗДАНИЕМ, никогда раньше. Раньше заявить невозможно.
// ============================================================
(function () {
  "use strict";
  const T = {
    offset: 0,          // server - local (консервативно, в будущее)
    synced: false,
    _syncing: null
  };

  async function _sample() {
    const t0 = Date.now();
    const { data, error } = await API.rpc("server_now_ms");
    const t1 = Date.now();
    if (error || typeof data !== "number") return null;
    const rtt = t1 - t0;
    const serverAtMid = data;                    // сервер примерно в середине RTT
    const localAtMid = t0 + rtt / 2;
    // консервативная граница: серверные часы >= localAtMid + offset_best + rtt/2
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

  // консервативная оценка серверного времени (>= истинного)
  function now() { return Date.now() + T.offset; }

  setInterval(() => sync(true).catch(() => {}), 120000);

  window.ServerTime = { sync, now };
})();
