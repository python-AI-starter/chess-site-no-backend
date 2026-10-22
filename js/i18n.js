// Localization. The language is picked from the browser settings:
// Russian or Chinese browsers get ru/zh, everything else gets English.
// Dictionaries live in locales/<lang>.json as flat key-value maps.
// Server messages (PostgREST errors, RPC error fields) are translated
// through an exact-match table with a few regex fallbacks.
(function () {
  "use strict";

  const I18n = { lang: "en", dict: {} };

  function detect() {
    const langs = (navigator.languages && navigator.languages.length)
      ? navigator.languages : [navigator.language || "en"];
    for (const l of langs) {
      const s = String(l || "").toLowerCase();
      if (s.startsWith("ru")) return "ru";
      if (s.startsWith("zh")) return "zh";
    }
    return "en";
  }

  async function loadDict(lang) {
    const res = await fetch(`locales/${lang}.json`, { cache: "no-cache" });
    if (!res.ok) throw new Error(`locales/${lang}.json: ${res.status}`);
    return await res.json();
  }

  // init(): detect the language, load its dictionary (English as
  // fallback), localize the static shell. Awaits once at startup before
  // the first render.
  I18n.init = async function () {
    this.lang = detect();
    document.documentElement.lang = this.lang;
    try {
      this.dict = await loadDict(this.lang);
    } catch (e) {
      this.dict = {};
      try { this.dict = await loadDict("en"); this.lang = "en"; } catch (e2) {}
    }
    // static shell: title, meta description, nav links, theme button
    document.title = this.t("site.title");
    const meta = document.querySelector('meta[name="description"]');
    if (meta) meta.setAttribute("content", this.t("site.description"));
    document.querySelectorAll("[data-i18n]").forEach(el => {
      el.textContent = this.t(el.dataset.i18n);
    });
    document.querySelectorAll("[data-i18n-title]").forEach(el => {
      el.title = this.t(el.dataset.i18nTitle);
    });
    const brand = document.querySelector(".brand");
    if (brand) {
      const sym = brand.innerHTML.match(/^([^a-zA-ZА-Яа-я]*)/);
      brand.innerHTML = `${sym ? sym[1] : ""} ${this.t("site.brand")}`;
    }
  };

  // t(key, params): dictionary lookup with {name} substitution; the key
  // itself is the last-resort fallback.
  I18n.t = function (key, params) {
    let s = this.dict[key];
    if (s == null) return key;
    if (params) {
      for (const k of Object.keys(params))
        s = s.split(`{${k}}`).join(String(params[k]));
    }
    return s;
  };

  // locale tag for date formatting
  I18n.locale = function () {
    return this.lang === "ru" ? "ru-RU" : this.lang === "zh" ? "zh-CN" : "en-US";
  };

  // Server messages: exact Russian text from the SQL functions mapped to
  // a translation key, plus regexes for the few templated ones.
  const SERVER_EXACT = {
    "Требуется вход": "srv.loginRequired",
    "Аккаунт заблокирован": "srv.banned",
    "Неверный формат хода": "srv.badMoveFormat",
    "Нелегальный ход": "srv.illegalMove",
    "Партия не найдена": "srv.gameNotFound",
    "Партия не активна": "srv.gameNotActive",
    "Вы не участник партии": "srv.notParticipant",
    "Сейчас не ваш ход": "srv.notYourTurn",
    "Нельзя заявить флаг на свой ход": "srv.flagOwnTurn",
    "Соперник отсутствует слишком недолго (нужно 5 минут)": "srv.abandon5",
    "Соперник отсутствует слишком недолго (нужно 3 минуты)": "srv.abandon3",
    "Нет активного предложения ничьей": "srv.noDrawOffer",
    "Сообщение должно быть от 1 до 500 символов": "srv.msgLen500",
    "Сообщение должно быть от 1 до 2000 символов": "srv.msgLen2000",
    "Слишком быстро — подождите секунду": "srv.tooFast",
    "Нет вашего хода для отката": "srv.takebackNoMove",
    "Ещё не сделано ни одного хода": "srv.noMovesYet",
    "Соперник уже просит откат — ответьте на его запрос": "srv.oppTakebackPending",
    "Нет активного запроса на откат": "srv.noTakeback",
    "Нельзя принять свой запрос — ждите соперника": "srv.takebackOwn",
    "Нечего откатывать": "srv.nothingToTakeback",
    "Чат доступен только участникам партии": "srv.gameChatMembers",
    "Чат клуба доступен только участникам клуба": "srv.clubChatMembers",
    "Ник уже занят": "srv.nickTaken",
    "Ник: 2-20 символов, латиница, цифры, _ и -": "srv.nickInvalid",
    "Игрок заблокирован": "srv.playerBanned",
    "Игрок не найден": "srv.playerNotFound",
    "Игрок не указан": "srv.playerMissing",
    "Аккаунт не найден": "srv.accountNotFound",
    "Нельзя вызвать самого себя": "srv.challengeSelf",
    "Вызов невозможен: один из игроков заблокировал другого": "srv.challengeBlocked",
    "Неверный контроль времени": "srv.badTimeControl",
    "Неверная добавка": "srv.badIncrement",
    "Неверный цвет": "srv.badColor",
    "К этой партии уже нельзя присоединиться": "srv.cannotJoin",
    "Партия уже полная": "srv.gameFull",
    "Этот вызов адресный — принять может только приглашённый": "srv.inviteOnly",
    "Нельзя написать самому себе": "srv.dmSelf",
    "Получатель не найден": "srv.recipientNotFound",
    "Отправка невозможна: один из игроков заблокировал другого": "srv.dmBlocked",
    "Нельзя заблокировать самого себя": "srv.blockSelf",
    "Недостаточно прав: действие только для создателя или админа": "srv.modOnly",
    "Минуты: от 1 до 10080 (7 суток)": "srv.minutesInvalid",
    "Сообщение не указано": "srv.msgMissing",
    "Неизвестный тип сообщения": "srv.unknownMsgType",
    "Сообщение не найдено (возможно, уже удалено)": "srv.msgNotFound",
    "Недостаточно прав: клуб может удалить только создатель сайта": "srv.clubCreatorOnly",
    "Клуб не найден (возможно, уже удалён)": "srv.clubNotFound",
    "Недостаточно прав: тему может удалить только создатель сайта": "srv.threadCreatorOnly",
    "Тема не найдена (возможно, уже удалена)": "srv.threadNotFound",
    "Недостаточно прав: пост может удалить только создатель сайта": "srv.postCreatorOnly",
    "Пост не найден (возможно, уже удалён)": "srv.postNotFound",
    "Нельзя замутить самого себя": "srv.muteSelf",
    "Нельзя забанить самого себя": "srv.banSelf",
    "Свой аккаунт нельзя удалить через модерацию": "srv.delSelf",
    "Аккаунт админа может удалить только создатель сайта": "srv.delAdminCreator",
    "Аккаунт создателя сайта удалить нельзя": "srv.delCreator",
    "Статус админа может менять только создатель сайта": "srv.roleAdminCreator",
    "Статус создателя сайта изменить нельзя": "srv.roleCreator",
    "Нельзя менять свой собственный статус": "srv.roleSelf",
    "Отменить партию можно, только пока оба игрока не сделали по одному ходу": "srv.abortTooLate",
    // Supabase Auth messages (English source)
    "Invalid login credentials": "srv.badCredentials",
    "User already registered": "srv.alreadyRegistered",
    "Email not confirmed": "srv.emailNotConfirmed",
    "Password should be at least 6 characters": "srv.passwordShort",
    "Email rate limit exceeded": "srv.emailRateLimit",
    "For security purposes, you can only request this once every 60 seconds": "srv.rateLimit60"
  };

  const SERVER_PATTERNS = [
    [/^Партия повреждена/, "srv.corruptGame"],
    [/^Вы в муте/, "srv.muted"],
    [/^Создателя сайта .* нельзя$/, "srv.creatorProtected"],
    [/админа может только создатель сайта$/, "srv.adminOnlyCreator"]
  ];

  // s(msg): translate a server message; unknown text passes through.
  I18n.s = function (msg) {
    if (msg == null) return "";
    const key = SERVER_EXACT[msg];
    if (key) return this.t(key);
    for (const [re, k] of SERVER_PATTERNS) {
      if (re.test(msg)) return this.t(k);
    }
    return msg;
  };

  window.I18n = I18n;
})();
