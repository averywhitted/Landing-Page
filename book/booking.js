/* Booking widget for averywhitted.com.
 *
 * - Any "Book" link (href="/book/..." or [data-book]) opens it in a pop-up.
 *   Add data-service="coaching-60" (or ?service=coaching-60) to preselect a session.
 * - On /book/ it renders inline in [data-booking-inline] instead.
 * - Without JavaScript, the links simply go to /book/.
 *
 * Talks to the booking API at book.averywhitted.com. Prices and open times
 * always come from the API; nothing here decides a price.
 */
(() => {
  "use strict";

  // Local testing on this Mac can point at a local copy of the API via
  // localStorage "bk-api"; everywhere else it's always the live address.
  const LOCAL = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  const API = (LOCAL && (() => { try { return localStorage.getItem("bk-api"); } catch { return null; } })())
    || (document.currentScript && document.currentScript.dataset.api) || "https://book.averywhitted.com";
  const AVERY_TZ = "America/New_York";
  const CONTACT = "info@averywhitted.com";
  const STEPS = ["Session", "Time", "Details"];
  const COMMON_TZ = [
    "America/New_York", "America/Chicago", "America/Denver", "America/Phoenix", "America/Los_Angeles",
    "America/Anchorage", "Pacific/Honolulu", "America/Toronto", "America/Vancouver", "Europe/London",
    "Europe/Paris", "Europe/Berlin", "Australia/Sydney",
  ];

  // Cloudflare Turnstile (invisible bot check). The site key is public by design.
  const TURNSTILE_SITE_KEY = "0x4AAAAAAFFiRSFTRnbCFEdF";
  let turnstileLoad = null;
  function loadTurnstile() {
    turnstileLoad ||= new Promise((resolve, reject) => {
      window.__bkTurnstileReady = () => resolve(window.turnstile);
      const s = document.createElement("script");
      s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=__bkTurnstileReady";
      s.async = true;
      s.onerror = () => { turnstileLoad = null; reject(new Error("blocked")); };
      document.head.appendChild(s);
    });
    return turnstileLoad;
  }
  // Runs the check in `container` and resolves with a one-time token.
  async function humanCheck(container) {
    const ts = await loadTurnstile();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout")), 25000);
      container.innerHTML = "";
      ts.render(container, {
        sitekey: TURNSTILE_SITE_KEY,
        appearance: "interaction-only",
        callback: (token) => { clearTimeout(timer); resolve(token); },
        // Cloudflare passes a reason code (e.g. 110200 = this address isn't on the widget's list).
        "error-callback": (code) => { clearTimeout(timer); reject(new Error(String(code || "failed"))); return true; },
      });
    });
  }

  /* ── Small helpers ── */
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
  };
  const fmtCache = new Map();
  function fmt(tz, opts) {
    const key = tz + JSON.stringify(opts);
    if (!fmtCache.has(key)) fmtCache.set(key, new Intl.DateTimeFormat("en-US", { timeZone: tz, ...opts }));
    return fmtCache.get(key);
  }
  // "YYYY-MM-DD" for an instant, in a time zone.
  function dateKey(ms, tz) {
    const p = Object.fromEntries(fmt(tz, { year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(ms).map((x) => [x.type, x.value]));
    return `${p.year}-${p.month}-${p.day}`;
  }
  function addDays(key, n) {
    const [y, m, d] = key.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
  }
  // Wall-clock time in a zone -> UTC ms (same method as the API's time.ts).
  function zonedToUtc(key, hour, tz) {
    const [y, m, d] = key.split("-").map(Number);
    const offset = (ms) => {
      const p = Object.fromEntries(fmt(tz, { hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(ms).map((x) => [x.type, x.value]));
      return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(ms / 1000) * 1000;
    };
    const guess = Date.UTC(y, m - 1, d, hour);
    return guess - offset(guess - offset(guess));
  }
  const keyToLabel = (key, opts) => fmt("UTC", opts).format(new Date(key + "T12:00:00Z"));
  const money = (cents) => (cents % 100 ? `$${(cents / 100).toFixed(2)}` : `$${cents / 100}`);
  const lengthLabel = (min) => (min === 60 ? "1 hour" : `${min} min`);
  const sessionTitle = (min) => (min === 60 ? "1 Hour Session" : `${min} Minute Session`);
  const tzName = (tz, ms = Date.now(), style = "long") => {
    const part = fmt(tz, { timeZoneName: style }).formatToParts(ms).find((p) => p.type === "timeZoneName");
    return part ? part.value : tz;
  };
  const cityOf = (tz) => tz.split("/").pop().replace(/_/g, " ");

  function detectTz() {
    const saved = store.get("bk-tz");
    if (saved && isValidTz(saved)) return saved;
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || AVERY_TZ; } catch { return AVERY_TZ; }
  }
  function isValidTz(tz) { try { fmt(tz, {}); return true; } catch { return false; } }

  // Promo code from a link like /book/?promo=SPRING20, remembered for this visit
  // and passed to checkout, where Stripe applies it.
  const PROMO_RE = /^[A-Za-z0-9_-]{2,40}$/;
  function currentPromo() {
    try {
      const fromUrl = new URLSearchParams(location.search).get("promo");
      if (fromUrl && PROMO_RE.test(fromUrl)) sessionStorage.setItem("bk-promo", fromUrl.toUpperCase());
      const saved = sessionStorage.getItem("bk-promo");
      return saved && PROMO_RE.test(saved) ? saved : null;
    } catch { return null; }
  }

  /* ── API ── */
  let servicesPromise;
  function loadServices() {
    servicesPromise ||= fetch(`${API}/api/services`)
      .then((r) => { if (!r.ok) throw new Error(); return r.json(); })
      .then((list) => list.sort((a, b) => (a.kind === "bundle") - (b.kind === "bundle") || a.durationMinutes - b.durationMinutes || (a.credits || 0) - (b.credits || 0)))
      .catch((e) => { servicesPromise = null; throw e; });
    return servicesPromise;
  }
  const slotCache = new Map();
  // Set after letting a hold go, so the next lookup skips Cloudflare's
  // one-minute cache and shows the freed time straight away.
  let fresh = "";
  // `extra` carries the manage link (b, t) when rescheduling, so the booking
  // being moved doesn't block the times next to it.
  async function loadSlots(serviceId, from, extra = "") {
    const key = `${serviceId}|${from}|${extra}`;
    const hit = slotCache.get(key);
    if (hit && Date.now() - hit.at < 60000) return hit.data;
    const r = await fetch(`${API}/api/availability?service=${encodeURIComponent(serviceId)}&from=${from}&days=7${extra}${fresh}`);
    if (!r.ok) throw new Error(String(r.status));
    const data = await r.json();
    slotCache.set(key, { at: Date.now(), data });
    return data;
  }

  /* ── Widget ── */
  // `reschedule` (manage page only): { serviceId, b, t, currentStart, timeZone, onConfirm(slot), onCancel() }
  // shows just the time step for moving an existing booking.
  function createWidget(root, { inModal = false, onClose, reschedule = null, picker = null } = {}) {
    // `picker` is a generic "just pick a time" mode (bundle page); `reschedule` is
    // the same with wording for moving an existing booking.
    if (reschedule) picker = { title: "Pick a new time", cancelLabel: "Keep current time", confirmLabel: "Confirm new time", busyLabel: "Moving", ...reschedule };
    reschedule = picker;
    const today = dateKey(Date.now(), AVERY_TZ);
    const moveExtra = reschedule && reschedule.b ? `&b=${encodeURIComponent(reschedule.b)}&t=${encodeURIComponent(reschedule.t)}` : "";
    const state = {
      step: reschedule ? 1 : 0,
      services: null,
      servicesError: false,
      service: null,
      tz: reschedule && reschedule.timeZone && isValidTz(reschedule.timeZone) && !store.get("bk-tz") ? reschedule.timeZone : detectTz(),
      weekStart: today,
      week: null,          // { loading, error, data }
      day: null,
      slot: null,          // UTC ms
      form: {},
      view: store.get("bk-view") === "list" ? "list" : "grid",
      resumeTo: null,      // slot to jump back to when restoring a saved booking
      submitting: false,
      message: null,       // { kind: "error" | "info", text }
    };
    let loadToken = 0;

    root.classList.add("bk-root");
    root.innerHTML = `
      <div class="bk-head">
        <p class="bk-eyebrow">Avery Whitted &middot; Private Coaching</p>
        <h2 class="bk-title" id="${inModal ? "bk-dialog-title" : "bk-inline-title"}" tabindex="-1"></h2>
        <ol class="bk-steps" aria-label="Booking steps"></ol>
      </div>
      <div class="bk-body"></div>
      <p class="bk-sr" aria-live="polite" aria-atomic="true"></p>
      <div class="bk-foot"></div>`;
    const $title = root.querySelector(".bk-title");
    const $steps = root.querySelector(".bk-steps");
    const $body = root.querySelector(".bk-body");
    const $foot = root.querySelector(".bk-foot");
    const $live = root.querySelector(".bk-sr");
    // Short spoken updates for screen readers ("Step 2 of 3: Pick a time").
    function announce(text) {
      $live.textContent = "";
      setTimeout(() => { $live.textContent = text; }, 50);
    }

    const isBundle = () => !!(state.service && state.service.kind === "bundle");
    const single60 = () => (state.services || []).find((s) => s.kind === "single" && s.durationMinutes === 60);

    /* Rendering */
    // The widget redraws itself on each change; put keyboard focus back on the
    // same control afterwards so keyboard users don't lose their place.
    function focusKey(el) {
      if (!el || !root.contains(el) || !el.dataset || !el.dataset.action) return null;
      const attrs = ["action", "date", "start", "id", "view", "step"].filter((k) => el.dataset[k] !== undefined);
      return attrs.map((k) => `[data-${k}="${CSS.escape(el.dataset[k])}"]`).join("");
    }

    function render() {
      const keep = focusKey(document.activeElement);
      $title.textContent = reschedule ? reschedule.title : [inModal ? "Book a session" : "Choose a session", "Pick a time", "Your details"][state.step];
      $steps.hidden = !!reschedule;
      const flow = isBundle() ? [[0, "Bundle"], [2, "Details"]] : STEPS.map((name, i) => [i, name]);
      $steps.innerHTML = flow.map(([i, name], n) => {
        const current = i === state.step ? ' aria-current="step"' : "";
        const done = i < state.step ? " is-done" : "";
        const inner = `<span class="bk-step-n">${n + 1}</span><span class="bk-step-label">${name}</span>`;
        return `<li>${i < state.step
          ? `<button type="button" class="bk-step${done}" data-action="goto" data-step="${i}">${inner}</button>`
          : `<span class="bk-step${done}"${current}>${inner}</span>`}</li>`;
      }).join("");
      try {
        $body.innerHTML = [renderServices, renderTimes, renderDetails][state.step]();
        $foot.innerHTML = renderFoot();
      } catch (err) {
        // Never leave a half-drawn step on screen that nothing can be tapped on.
        console.error(err);
        $body.innerHTML = `<div class="bk-empty is-error">Something went wrong showing this step.<button type="button" class="bk-btn" data-action="goto" data-step="0">Start again</button></div>`;
        $foot.innerHTML = "";
      }
      if (keep) {
        const again = root.querySelector(keep);
        if (again && !again.disabled) again.focus({ preventScroll: true });
      }
      if (state.step === 1) {
        const picked = $body.querySelector('.bk-day[aria-pressed="true"]');
        if (picked) picked.scrollIntoView({ block: "nearest", inline: "nearest" });
      }
    }

    function summary(withTime) {
      const s = state.service;
      if (reschedule && reschedule.summaryHtml) return reschedule.summaryHtml
        + (state.message ? `<p class="bk-msg is-${state.message.kind}" role="alert" style="margin:0 0 14px">${state.message.text}</p>` : "");
      const promo = currentPromo();
      const promoChip = promo && s.priceCents ? `<span class="bk-promo">Code ${esc(promo)} applied at checkout</span>` : "";
      if (s.kind === "bundle") {
        return `<div class="bk-summary"><strong>${esc(bundleTitle(s))}</strong><span class="bk-sep">&middot;</span><span>${s.credits} &times; ${esc(lengthLabel(s.durationMinutes))} on Zoom</span><span class="bk-sep">&middot;</span><span>use within ${s.validDays || 90} days</span>${promoChip}<span class="bk-price">${money(s.priceCents)}</span></div>`;
      }
      if (reschedule) {
        const now = reschedule.currentStart;
        return `<div class="bk-summary"><strong>Moving your ${esc(lengthLabel(s.durationMinutes))} ${s.kind === "intro" ? "intro chat" : "session"}</strong><span class="bk-sep">&middot;</span><span>Now: ${esc(fmt(state.tz, { weekday: "short", month: "short", day: "numeric" }).format(now))}, ${esc(fmt(state.tz, { hour: "numeric", minute: "2-digit" }).format(now))} ${esc(tzName(state.tz, now, "short"))}</span></div>`
          + (state.message ? `<p class="bk-msg is-${state.message.kind}" role="alert" style="margin:0 0 14px">${state.message.text}</p>` : "");
      }
      const title = s.kind === "intro" ? esc(s.name) : "Private Coaching";
      const when = withTime && state.slot
        ? `<span class="bk-sep">&middot;</span><span>${esc(fmt(state.tz, { weekday: "short", month: "short", day: "numeric" }).format(state.slot))}, ${esc(fmt(state.tz, { hour: "numeric", minute: "2-digit" }).format(state.slot))} ${esc(tzName(state.tz, state.slot, "short"))}</span>`
        : "";
      return `<div class="bk-summary"><strong>${title}</strong><span class="bk-sep">&middot;</span><span>${lengthLabel(s.durationMinutes)}</span><span class="bk-sep">&middot;</span><span>Zoom</span>${when}${promoChip}<span class="bk-price">${s.priceCents ? money(s.priceCents) : "Free"}</span></div>`;
    }

    function renderServices() {
      if (state.servicesError) {
        return `<div class="bk-empty is-error">Sessions couldn't load. Check your connection and try again.<button type="button" class="bk-btn" data-action="retry-services">Try again</button></div>`;
      }
      if (!state.services) return `<div class="bk-skel">${'<div class="bk-skel-row" style="height:88px"></div>'.repeat(4)}</div>`;
      const card = (s) => `
        <li><button type="button" class="bk-svc${s.kind === "intro" ? " is-intro" : ""}${s.kind === "bundle" ? " is-bundle" : ""}" data-action="service" data-id="${esc(s.id)}">
          <span class="bk-svc-num" aria-hidden="true">${s.kind === "bundle" ? `${s.credits}<small>SESSIONS</small>` : `${s.durationMinutes}<small>MIN</small>`}</span>
          <span>
            <span class="bk-svc-name">${s.kind === "intro" ? esc(s.name) : s.kind === "bundle" ? esc(bundleTitle(s)) : esc(sessionTitle(s.durationMinutes))}</span>
            <span class="bk-svc-blurb">${esc(s.kind === "bundle" ? bundleBlurb(s) : s.blurb || "")}</span>
          </span>
          <span class="bk-svc-price${s.priceCents ? "" : " is-free"}">${s.priceCents ? money(s.priceCents) : "Free"}</span>
        </button></li>`;
      const intros = state.services.filter((s) => s.kind === "intro");
      const singles = state.services.filter((s) => s.kind === "single");
      const bundles = state.services.filter((s) => s.kind === "bundle");
      return (intros.length ? `<ul class="bk-svcs">${intros.map(card).join("")}</ul>` : "")
        + (singles.length ? `<p class="bk-group-label">Private coaching <span>One-on-one on Zoom</span></p><ul class="bk-svcs">${singles.map(card).join("")}</ul>` : "")
        + (bundles.length ? `<p class="bk-group-label">Session bundles <span>Save when you book a few</span></p><ul class="bk-svcs">${bundles.map(card).join("")}</ul>` : "");
    }

    function bundleTitle(s) { return `${s.credits} Session Bundle`; }
    function bundleBlurb(s) {
      const base = single60();
      const each = money(Math.round(s.priceCents / s.credits / 100) * 100);
      const save = base ? base.priceCents * s.credits - s.priceCents : 0;
      return `${s.credits} one-hour sessions on Zoom, ${each} each${save > 0 ? `. Save ${money(save)}` : ""}. Book them anytime within ${s.validDays || 90} days.`;
    }

    function tzOptions() {
      let all = [];
      try { all = Intl.supportedValuesOf("timeZone"); } catch { /* older browsers: common list only */ }
      const common = [...new Set([state.tz, ...COMMON_TZ])];
      const label = (tz) => `${cityOf(tz)} (${tzName(tz, Date.now(), "short")})`;
      const opt = (tz) => `<option value="${esc(tz)}"${tz === state.tz ? " selected" : ""}>${esc(label(tz))}</option>`;
      const rest = all.filter((tz) => !common.includes(tz));
      return `<optgroup label="Common">${common.map(opt).join("")}</optgroup>${rest.length ? `<optgroup label="All time zones">${rest.map(opt).join("")}</optgroup>` : ""}`;
    }

    function renderTimes() {
      if (!state.service) {
        return state.servicesError
          ? `<div class="bk-empty is-error">Open times couldn't load. Check your connection and try again.<button type="button" class="bk-btn" data-action="retry-services">Try again</button></div>`
          : `<div class="bk-skel">${'<div class="bk-skel-row"></div>'.repeat(4)}</div>`;
      }
      const weekEnd = addDays(state.weekStart, 6);
      const rangeLabel = `${keyToLabel(state.weekStart, { month: "short", day: "numeric" })} to ${keyToLabel(weekEnd, { month: "short", day: "numeric" })}`;
      const toolbar = `
        <div class="bk-toolbar">
          <div class="bk-range">
            <button type="button" class="bk-arrow" data-action="prev-week" aria-label="Previous week"${state.weekStart <= today ? " disabled" : ""}>
              <svg width="8" height="12" viewBox="0 0 8 12" aria-hidden="true"><path d="M6.5 1 1.5 6l5 5" fill="none" stroke="currentColor" stroke-width="1.8"/></svg></button>
            <span class="bk-range-label">${esc(rangeLabel)}</span>
            <button type="button" class="bk-arrow" data-action="next-week" aria-label="Next week">
              <svg width="8" height="12" viewBox="0 0 8 12" aria-hidden="true"><path d="m1.5 1 5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.8"/></svg></button>
          </div>
          <label class="bk-tz"><span>Your time zone</span><select class="bk-tz-select" data-action="tz">${tzOptions()}</select></label>
        </div>`;

      const w = state.week;
      if (!w || w.loading) {
        return summary(false) + toolbar + `<div class="bk-days">${'<div class="bk-skel-row" style="height:66px"></div>'.repeat(7)}</div><div class="bk-skel">${'<div class="bk-skel-row"></div>'.repeat(3)}</div>`;
      }
      if (w.error) {
        return summary(false) + toolbar + `<div class="bk-empty is-error">Open times couldn't load right now. Please try again in a moment.<button type="button" class="bk-btn" data-action="retry-week">Try again</button></div>`;
      }

      const byDay = groupByDay(w.data.slots);
      const days = dayList(byDay);
      const dayButtons = days.map((k) => {
        const n = (byDay.get(k) || []).length;
        return `<button type="button" class="bk-day" data-action="day" data-date="${k}" aria-pressed="${k === state.day}"${n ? "" : " disabled"}
            aria-label="${esc(keyToLabel(k, { weekday: "long", month: "long", day: "numeric" }))}, ${n ? `${n} open time${n > 1 ? "s" : ""}` : "no open times"}">
          <span class="bk-day-dow">${esc(keyToLabel(k, { weekday: "short" }))}</span>
          <span class="bk-day-num">${esc(keyToLabel(k, { day: "numeric" }))}</span>
        </button>`;
      }).join("");

      const daySlots = state.day ? byDay.get(state.day) || [] : [];
      let slotsHtml;
      if (!w.data.slots.length) {
        slotsHtml = `<div class="bk-empty">No openings this week. Try the next one.<button type="button" class="bk-btn" data-action="next-week">Next week &rarr;</button></div>`;
      } else {
        const tzShort = tzName(state.tz, daySlots[0] || Date.now(), "short");
        slotsHtml = `
          <div class="bk-slots-head">
            <p class="bk-label">${esc(keyToLabel(state.day, { weekday: "long", month: "long", day: "numeric" }))} &middot; ${esc(tzShort)}</p>
            <div class="bk-view" role="group" aria-label="Show times as" data-view="${state.view}">
              <span class="bk-view-thumb" aria-hidden="true"></span>
              <button type="button" data-action="view" data-view="grid" aria-pressed="${state.view === "grid"}">
                <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M1 1h4v4H1zM7 1h4v4H7zM1 7h4v4H1zM7 7h4v4H7z" fill="currentColor"/></svg>Grid</button>
              <button type="button" data-action="view" data-view="list" aria-pressed="${state.view === "list"}">
                <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M1 2h10M1 6h10M1 10h10" stroke="currentColor" stroke-width="1.6"/></svg>List</button>
            </div>
          </div>
          <div class="bk-times">${renderSlotLayout(daySlots)}</div>`;
      }

      const notes = [];
      if (state.tz !== AVERY_TZ) notes.push(`Avery is based in New York. Times are shown in your time zone (${esc(tzName(state.tz))}).`);
      if (w.data.notice) notes.push(esc(w.data.notice));

      return summary(false) + toolbar + `<div class="bk-days${days.length > 7 ? " is-8" : ""}" role="group" aria-label="Days">${dayButtons}</div>` + slotsHtml
        + notes.map((n) => `<p class="bk-callout">${n}</p>`).join("");
    }

    const isCurrent = (ms) => !!reschedule && ms === reschedule.currentStart;

    function renderSlotLayout(daySlots) {
      const time = (ms) => esc(fmt(state.tz, { hour: "numeric", minute: "2-digit" }).format(ms));
      if (state.view === "grid") {
        return `<div class="bk-slots" role="group" aria-label="Times on ${esc(state.day ? keyToLabel(state.day, { weekday: "long", month: "long", day: "numeric" }) : "")}">${daySlots.map((ms) => `
          <button type="button" class="bk-slot${isCurrent(ms) ? " is-current" : ""}" data-action="slot" data-start="${ms}" aria-pressed="${ms === state.slot}"${isCurrent(ms) ? ' disabled title="Your current time"' : ""}>${time(ms)}</button>`).join("")}</div>`;
      }
      // List: bigger rows grouped by part of the day, each showing its end time.
      const groups = [["Morning", []], ["Afternoon", []], ["Evening", []]];
      for (const ms of daySlots) {
        const h = +fmt(state.tz, { hour: "numeric", hourCycle: "h23" }).format(ms);
        groups[h < 12 ? 0 : h < 17 ? 1 : 2][1].push(ms);
      }
      const len = state.service.durationMinutes * 60000;
      return `<div class="bk-list">${groups.filter(([, list]) => list.length).map(([label, list]) => `
        <div class="bk-list-group" role="group" aria-label="${label}">
          <p class="bk-list-label" aria-hidden="true">${label}</p>
          ${list.map((ms) => `
            <button type="button" class="bk-row${isCurrent(ms) ? " is-current" : ""}" data-action="slot" data-start="${ms}" aria-pressed="${ms === state.slot}"${isCurrent(ms) ? " disabled" : ""}>
              <span class="bk-row-time">${time(ms)}</span>
              <span class="bk-row-end">${isCurrent(ms) ? "your current time" : `to ${time(ms + len)}`}</span>
              <span class="bk-row-mark" aria-hidden="true"></span>
            </button>`).join("")}
        </div>`).join("")}</div>`;
    }

    function groupByDay(slots) {
      const map = new Map();
      for (const iso of slots) {
        const ms = Date.parse(iso);
        const k = dateKey(ms, state.tz);
        if (!map.has(k)) map.set(k, []);
        map.get(k).push(ms);
      }
      return map;
    }
    // The 7 days of the week as the client sees them, plus any spill-over day
    // caused by a large time difference.
    function dayList(byDay) {
      const base = [];
      for (let i = 0; i < 7; i++) base.push(dateKey(zonedToUtc(addDays(state.weekStart, i), 12, AVERY_TZ), state.tz));
      return [...new Set([...base, ...byDay.keys()])].sort();
    }

    function renderDetails() {
      const s = state.service;
      const f = state.form;
      const v = (k) => esc(f[k] || "");
      const intro = s.kind === "intro";
      const bundle = s.kind === "bundle";
      const policy = bundle
        ? `I understand my sessions need to be used within ${s.validDays || 90} days of purchase, and that each one can be rescheduled or cancelled up to 24 hours before it starts. Sessions cancelled later than that, or not used in time, can't be returned to the bundle.`
        : intro
        ? "I understand I can reschedule or cancel up to 24 hours before our call."
        : "I understand I can reschedule or cancel up to 24 hours before my session. Refunds for cancellations may take a few business days to appear.";
      return summary(true) + `
        <form class="bk-form" id="bk-form" novalidate>
          <div class="bk-field"><label for="bk-name">Name</label>
            <input class="bk-input" id="bk-name" name="name" autocomplete="name" required maxlength="120" value="${v("name")}"></div>
          <div class="bk-field"><label for="bk-email">Email</label>
            <input class="bk-input" id="bk-email" name="email" type="email" autocomplete="email" required maxlength="200" value="${v("email")}"></div>
          <div class="bk-field"><label for="bk-pronouns">Pronouns <span class="bk-opt">(optional)</span></label>
            <input class="bk-input" id="bk-pronouns" name="pronouns" maxlength="40" placeholder="she/her, they/them..." value="${v("pronouns")}"></div>
          <div class="bk-field is-wide"><label for="bk-goal">${intro ? "What would you like to talk about?" : bundle ? "What would you like to work on across these sessions?" : "Main goal for the session"}</label>
            <textarea class="bk-input" id="bk-goal" name="goal" required maxlength="2000">${v("goal")}</textarea></div>
          ${intro || bundle ? "" : `<div class="bk-field is-wide"><label for="bk-material">Material to work on</label>
            <textarea class="bk-input" id="bk-material" name="material" required maxlength="2000" placeholder="Sides, a monologue, a self-tape... &quot;Not sure yet&quot; is fine.">${v("material")}</textarea></div>`}
          ${intro ? "" : `<div class="bk-field is-wide"><label for="bk-link">Link to materials <span class="bk-opt">(optional)</span></label>
            <input class="bk-input" id="bk-link" name="link" type="url" inputmode="url" maxlength="500" placeholder="https://" value="${v("link")}"></div>`}
          <div class="bk-field is-wide"><label for="bk-notes">Anything else I should know? <span class="bk-opt">(optional)</span></label>
            <textarea class="bk-input" id="bk-notes" name="notes" maxlength="2000">${v("notes")}</textarea></div>
          ${s.kind === "single" ? `<div class="bk-field is-wide bk-repeat"><label for="bk-repeat">Repeat this session <span class="bk-opt">(optional)</span></label>
            <div class="bk-repeat-row">
              <select class="bk-input" id="bk-repeat" name="repeat">${[["", "Just this once"], ["1", "Every week"], ["2", "Every 2 weeks"], ["3", "Every 3 weeks"], ["4", "Every 4 weeks"]]
                .map(([val, label]) => `<option value="${val}"${(f.repeat || "") === val ? " selected" : ""}>${label}</option>`).join("")}</select>
              <select class="bk-input" id="bk-repeat-total" name="repeatTotal" aria-label="For how long"${f.repeat ? "" : " hidden"}>${[["", "Until I stop it"], ["4", "For 4 sessions"], ["8", "For 8 sessions"], ["12", "For 12 sessions"]]
                .map(([val, label]) => `<option value="${val}"${(f.repeatTotal || "") === val ? " selected" : ""}>${label}</option>`).join("")}</select>
            </div>
            <p class="bk-hint" id="bk-repeat-hint"${f.repeat ? "" : " hidden"}>You'll pay for this first session now. After each session, the next one is booked automatically at the same day and time, and you'll get an email with a link to pay (due 24 hours before). You can stop repeating anytime.</p>
          </div>` : ""}
          <label class="bk-check"><input type="checkbox" name="policy" required${f.policy ? " checked" : ""}><span>${policy}</span></label>
          <p class="bk-privacy">Your details are used only to schedule and prepare for your session. <a href="/policies.html#privacy" target="_blank" rel="noopener">How your information is used</a></p>
          <div class="bk-ts" id="bk-ts"></div>
          ${state.message ? `<p class="bk-msg is-${state.message.kind}" role="${state.message.kind === "error" ? "alert" : "status"}">${state.message.text}</p>` : ""}
        </form>`;
    }

    function renderFoot() {
      const inPerson = `Sessions are on Zoom. Want to meet in person? <a href="mailto:${CONTACT}">Reach out</a> before booking.`;
      if (state.step === 0) {
        return `<p class="bk-note">${inPerson}</p>${readDraft() ? '<button type="button" class="bk-btn ghost" data-action="start-over">Start over</button>' : ""}`;
      }
      if (reschedule) {
        return `<button type="button" class="bk-btn ghost" data-action="keep">${esc(reschedule.cancelLabel || "Cancel")}</button>`
          + `<button type="button" class="bk-btn primary" data-action="confirm-move"${state.slot && !state.submitting ? "" : " disabled"}>${state.submitting ? `<span class="bk-spin" aria-hidden="true"></span>${esc(reschedule.busyLabel || "One moment")}` : esc(reschedule.confirmLabel || "Confirm")}</button>`;
      }
      const back = `<button type="button" class="bk-btn ghost" data-action="back">&larr; Back</button>`;
      if (state.step === 1) {
        return `${back}<button type="button" class="bk-btn primary" data-action="to-details"${state.slot ? "" : " disabled"}>Continue &rarr;</button>`;
      }
      const label = state.service.kind === "intro" ? "Book intro chat" : `Continue to payment &middot; ${money(state.service.priceCents)}`;
      // (bundles and single sessions both go to Stripe from here)
      return `${back}<button type="submit" form="bk-form" class="bk-btn primary"${state.submitting ? " disabled" : ""}>${state.submitting ? '<span class="bk-spin" aria-hidden="true"></span>One moment' : label}</button>`;
    }

    /* Navigation */
    function go(step) {
      state.step = step;
      state.message = null;
      render();
      $body.scrollTop = 0;
      $title.focus({ preventScroll: true });
      if (!reschedule) {
        const flow = isBundle() ? [0, 2] : [0, 1, 2];
        announce(`Step ${flow.indexOf(step) + 1} of ${flow.length}: ${$title.textContent}`);
      }
    }

    async function loadWeek() {
      const token = ++loadToken;
      state.week = { loading: true };
      render();
      try {
        const data = await loadSlots(state.service.id, state.weekStart, moveExtra);
        if (token !== loadToken) return;
        state.week = { data };
        const byDay = groupByDay(data.slots);
        const days = dayList(byDay);
        if (!state.day || !(byDay.get(state.day) || []).length) state.day = days.find((k) => (byDay.get(k) || []).length) || days[0];
        if (state.slot && !data.slots.some((iso) => Date.parse(iso) === state.slot)) state.slot = null;
        const n = (byDay.get(state.day) || []).length;
        announce(data.slots.length ? `${n} time${n === 1 ? "" : "s"} available on ${keyToLabel(state.day, { weekday: "long", month: "long", day: "numeric" })}` : "No openings this week.");
        if (state.resumeTo) {
          const stillOpen = state.slot === state.resumeTo;
          state.resumeTo = null;
          state.week = { data };
          if (stillOpen) { go(2); return; }
        }
      } catch {
        if (token !== loadToken) return;
        state.week = { error: true };
      }
      render();
    }

    function selectService(id, { advance = true } = {}) {
      const s = state.services && state.services.find((x) => x.id === id);
      if (!s) return false;
      if (!state.service || state.service.id !== s.id) {
        state.service = s;
        state.slot = null;
        state.day = null;
        state.weekStart = today;
        // The times shown belong to the old session; drop them (and any
        // still loading) so the new one starts from a fresh load.
        state.week = null;
        loadToken++;
      }
      if (advance && s.kind === "bundle") { go(2); loadTurnstile().catch(() => {}); }
      else if (advance) { go(1); loadWeek(); }
      return true;
    }

    function saveForm() {
      const form = root.querySelector("#bk-form");
      if (!form) return;
      for (const el of form.elements) {
        if (!el.name) continue;
        state.form[el.name] = el.type === "checkbox" ? el.checked : el.value;
      }
      if (/^\S+@\S+\.\S+$/.test(state.form.email || "")) {
        writeDraft({ serviceId: state.service.id, slot: state.slot, tz: state.tz, form: state.form });
      }
    }

    async function submit(form) {
      saveForm();
      form.classList.add("was-validated");
      if (!form.checkValidity()) {
        state.message = { kind: "error", text: "Please fill in the highlighted fields." };
        render();
        const fresh = root.querySelector("#bk-form");
        fresh.classList.add("was-validated");
        for (const el of fresh.elements) if (el.willValidate) el.setAttribute("aria-invalid", String(!el.checkValidity()));
        const bad = fresh.querySelector(":invalid");
        if (bad) bad.focus();
        return;
      }
      state.submitting = true;
      state.message = null;
      render();
      const f = state.form;
      let turnstileToken;
      try {
        turnstileToken = await humanCheck(root.querySelector("#bk-ts"));
      } catch (err) {
        state.submitting = false;
        const code = /^\d+$/.test(err.message) ? ` (code ${err.message})` : err.message === "timeout" ? " (timed out)" : err.message === "blocked" ? " (blocked)" : "";
        state.message = { kind: "error", text: `We couldn't run a quick security check${code}. If you use an ad or script blocker, try pausing it for this page, or email <a href="mailto:${CONTACT}">${CONTACT}</a> to book.` };
        render();
        root.querySelector("#bk-form").classList.add("was-validated");
        return;
      }
      try {
        const bundle = isBundle();
        const r = await fetch(`${API}/api/${bundle ? "packages" : "bookings"}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            serviceId: state.service.id,
            start: bundle ? undefined : new Date(state.slot).toISOString(),
            timeZone: state.tz,
            promo: currentPromo() || undefined,
            turnstileToken,
            intake: {
              name: f.name, email: f.email, pronouns: f.pronouns || "", goal: f.goal,
              material: f.material || "", link: f.link || "", notes: f.notes || "", policyAccepted: !!f.policy,
            },
            repeat: !bundle && f.repeat ? { everyWeeks: Number(f.repeat), total: f.repeatTotal ? Number(f.repeatTotal) : null } : undefined,
          }),
        });
        const data = await r.json().catch(() => ({}));
        if (r.ok && data.checkoutUrl) {
          // Remember the hold, so "Start over" can let the time go straight away.
          const d = readDraft();
          if (d && data.bookingId) writeDraft({ ...d, holdId: data.bookingId });
          window.location.href = data.checkoutUrl;
          return;
        }
        if (r.ok && data.confirmationUrl) { window.location.href = data.confirmationUrl; return; }
        if (r.status === 404) {
          state.message = { kind: "info", text: "Booking isn't switched on yet. This is a preview of the new booking flow, and nothing was sent." };
        } else if (r.status === 409) {
          state.message = { kind: "error", text: "Sorry, that time was just taken. Please pick another." };
          slotCache.clear();
        } else {
          state.message = { kind: "error", text: esc(data.error || "Something went wrong. Please try again.") };
        }
      } catch {
        state.message = { kind: "error", text: "We couldn't reach the booking system. Check your connection and try again." };
      }
      state.submitting = false;
      render();
      root.querySelector("#bk-form").classList.add("was-validated");
      const msg = root.querySelector(".bk-msg");
      if (msg) msg.scrollIntoView({ block: "nearest" });
    }

    /* Events (delegated) */
    root.addEventListener("click", (e) => {
      const t = e.target.closest("[data-action]");
      if (!t || !root.contains(t) || t.tagName === "SELECT") return;
      const a = t.dataset.action;
      if (a === "service") selectService(t.dataset.id);
      else if (a === "goto") { if (state.step === 2) saveForm(); go(+t.dataset.step); if (state.step === 1 && !state.week) loadWeek(); }
      else if (a === "back") { if (state.step === 2) saveForm(); go(state.step === 2 && isBundle() ? 0 : state.step - 1); }
      else if (a === "prev-week") { state.weekStart = addDays(state.weekStart, -7); if (state.weekStart < today) state.weekStart = today; state.day = null; loadWeek(); }
      else if (a === "next-week") { state.weekStart = addDays(state.weekStart, 7); state.day = null; loadWeek(); }
      else if (a === "retry-week") loadWeek();
      else if (a === "retry-services") init();
      else if (a === "day") {
        state.day = t.dataset.date;
        render();
        const n = root.querySelectorAll(".bk-slot, .bk-row").length;
        announce(`${n} time${n === 1 ? "" : "s"} on ${keyToLabel(state.day, { weekday: "long", month: "long", day: "numeric" })}`);
      }
      else if (a === "slot") {
        state.slot = +t.dataset.start;
        render();
        announce(`Selected ${fmt(state.tz, { weekday: "long", hour: "numeric", minute: "2-digit" }).format(state.slot)}. ${reschedule ? "Confirm below." : "Continue when you're ready."}`);
      }
      else if (a === "to-details") { if (state.slot) { go(2); loadTurnstile().catch(() => {}); } }
      else if (a === "view") setView(t.dataset.view);
      else if (a === "keep" && reschedule) reschedule.onCancel();
      else if (a === "confirm-move" && reschedule && state.slot && !state.submitting) confirmMove();
      else if (a === "start-over") { releaseHold((readDraft() || {}).holdId); clearDraft(); state.form = {}; state.service = null; state.slot = null; state.week = null; render(); }
    });
    async function confirmMove() {
      state.submitting = true;
      state.message = null;
      render();
      try {
        await reschedule.onConfirm(state.slot);
      } catch (err) {
        state.submitting = false;
        state.message = { kind: "error", text: esc(err.message || "Something went wrong. Please try again.") };
        state.slot = null;
        slotCache.clear();
        loadWeek();
      }
    }

    // Switch Grid/List without re-rendering the toggle, so the thumb slides.
    function setView(view) {
      if (view !== "grid" && view !== "list") return;
      state.view = view;
      store.set("bk-view", view);
      const toggle = $body.querySelector(".bk-view");
      if (toggle) {
        toggle.dataset.view = view;
        for (const b of toggle.querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.dataset.view === view));
      }
      const wrap = $body.querySelector(".bk-times");
      const byDay = state.week && state.week.data ? groupByDay(state.week.data.slots) : new Map();
      if (wrap) wrap.innerHTML = renderSlotLayout(byDay.get(state.day) || []);
    }

    root.addEventListener("change", (e) => {
      // Repeating: show how long, and what it means, only once they choose to repeat.
      if (e.target.id === "bk-repeat") {
        const on = !!e.target.value;
        root.querySelector("#bk-repeat-total").hidden = !on;
        root.querySelector("#bk-repeat-hint").hidden = !on;
        saveForm();
      }
      if (e.target.matches(".bk-tz-select")) {
        state.tz = e.target.value;
        store.set("bk-tz", state.tz);
        state.day = null;
        if (state.week && state.week.data) {
          const byDay = groupByDay(state.week.data.slots);
          const days = dayList(byDay);
          state.day = state.slot ? dateKey(state.slot, state.tz) : days.find((k) => (byDay.get(k) || []).length) || days[0];
        }
        render();
      }
    });
    root.addEventListener("input", (e) => {
      if (e.target.getAttribute && e.target.getAttribute("aria-invalid") === "true" && e.target.checkValidity()) e.target.setAttribute("aria-invalid", "false");
      if (state.step === 2) saveForm();
    });
    root.addEventListener("submit", (e) => { e.preventDefault(); if (!state.submitting) submit(e.target); });

    async function init() {
      state.servicesError = false;
      render();
      try {
        state.services = await loadServices();
      } catch {
        state.servicesError = true;
      }
      if (reschedule && state.services) {
        state.service = state.services.find((s) => s.id === reschedule.serviceId) || null;
        // Open on the day of their current session (or the first open day after today).
        if (reschedule.currentStart) state.day = dateKey(reschedule.currentStart, state.tz);
        if (state.service) return loadWeek();
      }
      render();
    }

    let ready = init();

    return {
      // Open (or re-open) with an optional preselected session.
      async start(serviceId) {
        await ready;
        if (serviceId && state.services && state.services.find((s) => s.id === serviceId)) {
          const same = state.service && state.service.id === serviceId && state.step > 0;
          if (!same) selectService(serviceId);
        }
      },
      // Bring back a saved booking: same session, time zone, and answers.
      async resume(draft) {
        await ready;
        const s = state.services && state.services.find((x) => x.id === draft.serviceId);
        if (!s) return;
        state.service = s;
        state.form = { ...draft.form };
        if (draft.tz && isValidTz(draft.tz)) state.tz = draft.tz;
        if (s.kind === "bundle") { go(2); return; }
        const future = draft.slot && draft.slot > Date.now();
        state.slot = future ? draft.slot : null;
        state.resumeTo = state.slot;
        state.weekStart = future ? dateKey(draft.slot, AVERY_TZ) : today;
        if (state.weekStart < today) state.weekStart = today;
        state.day = future ? dateKey(draft.slot, state.tz) : null;
        go(1);
        loadWeek();
      },
      focus() { $title.focus({ preventScroll: true }); },
      close: onClose,
      // The pop-up was closed. Closed on "Your details": keep everything so
      // reopening picks up right there. Closed earlier: start over next time
      // (any answers already typed are kept for when they get back to details).
      closed() {
        if (state.step === 2) { saveForm(); return; }
        state.service = null;
        state.slot = null;
        state.day = null;
        state.week = null;
        state.weekStart = today;
        state.message = null;
        loadToken++;
        state.step = 0;
        render();
      },
    };
  }

  /* ── Saved booking ("cart") ──
     Kept only in this browser (localStorage), never sent anywhere until the
     visitor continues to payment. Expires after 7 days. */
  const DRAFT_KEY = "bk-draft";
  const DRAFT_DAYS = 7;
  function readDraft() {
    try {
      const d = JSON.parse(store.get(DRAFT_KEY) || "null");
      if (!d || !d.serviceId || !d.form || Date.now() - d.savedAt > DRAFT_DAYS * 86400000) return null;
      return d;
    } catch { return null; }
  }
  function writeDraft(d) {
    store.set(DRAFT_KEY, JSON.stringify({ ...d, savedAt: Date.now() }));
    updateCart();
  }
  // Lets go of an unpaid hold this browser made (back from Stripe, or "Start
  // over"), so the time is free again at once instead of in 30 minutes.
  function releaseHold(id) {
    if (!id || !/^[0-9a-f-]{36}$/.test(id)) return Promise.resolve();
    slotCache.clear();
    fresh = `&fresh=${Date.now()}`;
    return fetch(`${API}/api/bookings/release`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }), keepalive: true,
    }).catch(() => {});
  }
  function clearDraft() {
    try { localStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ }
    updateCart();
  }

  let cartBtn = null;
  function updateCart() {
    const draft = readDraft();
    const header = document.querySelector("header");
    if (!draft || !header) { if (cartBtn) { cartBtn.remove(); cartBtn = null; } return; }
    if (!cartBtn) {
      cartBtn = document.createElement("button");
      cartBtn.type = "button";
      cartBtn.className = "bk-cart";
      cartBtn.setAttribute("aria-label", "Finish your booking");
      cartBtn.title = "Finish your booking";
      cartBtn.innerHTML = `
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M3 4h2.2l2.1 10.2a1.5 1.5 0 0 0 1.5 1.2h8.4a1.5 1.5 0 0 0 1.5-1.2L20 8H6.2" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>
          <circle cx="9.5" cy="19.5" r="1.4" fill="currentColor"/><circle cx="17" cy="19.5" r="1.4" fill="currentColor"/>
        </svg><span class="bk-cart-badge" aria-hidden="true"></span>`;
      cartBtn.addEventListener("click", () => {
        const d = readDraft();
        if (!d) return updateCart();
        if (inlineWidget) {
          inlineHost.scrollIntoView({ behavior: "smooth", block: "start" });
          inlineWidget.resume(d);
        } else {
          openModal(null);
          getModal().widget.resume(d);
        }
      });
      header.appendChild(cartBtn); // far right of the header, after the nav
    }
  }
  window.addEventListener("storage", (e) => { if (e.key === DRAFT_KEY) updateCart(); });

  /* ── Pop-up ── */
  let modal;
  function getModal() {
    if (modal) return modal;
    const dialog = document.createElement("dialog");
    dialog.className = "bk bk-dialog";
    dialog.setAttribute("aria-labelledby", "bk-dialog-title");
    dialog.innerHTML = `<button type="button" class="bk-close" aria-label="Close booking">
        <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M1 1l12 12M13 1 1 13" stroke="currentColor" stroke-width="1.8"/></svg>
      </button><div></div>`;
    document.body.appendChild(dialog);
    const widget = createWidget(dialog.lastElementChild, { inModal: true, onClose: () => dialog.close() });
    dialog.querySelector(".bk-close").addEventListener("click", () => dialog.close());
    // A tap on the dim backdrop closes it, but only if it also started there
    // (a scroll that began inside the sheet and ended outside shouldn't).
    let downOnBackdrop = false;
    dialog.addEventListener("pointerdown", (e) => { downOnBackdrop = e.target === dialog; });
    dialog.addEventListener("click", (e) => { if (e.target === dialog && downOnBackdrop) dialog.close(); downOnBackdrop = false; });
    dialog.addEventListener("close", () => { unlockPage(); widget.closed(); });
    modal = { dialog, widget };
    return modal;
  }

  // Freeze the page behind the pop-up. On iPhones, letting it scroll moves
  // Safari's address bar, which can leave taps landing off the buttons.
  let lockedY = 0;
  function lockPage() {
    lockedY = window.scrollY;
    const b = document.body.style;
    b.position = "fixed"; b.top = `-${lockedY}px`; b.left = "0"; b.right = "0"; b.width = "100%";
    document.documentElement.classList.add("bk-lock");
  }
  function unlockPage() {
    if (!document.documentElement.classList.contains("bk-lock")) return;
    const b = document.body.style;
    b.position = b.top = b.left = b.right = b.width = "";
    document.documentElement.classList.remove("bk-lock");
    window.scrollTo({ top: lockedY, behavior: "instant" });
  }

  function openModal(serviceId) {
    const { dialog, widget } = getModal();
    if (!dialog.open) {
      lockPage();
      dialog.showModal();
      widget.focus();
    }
    widget.start(serviceId);
  }

  /* ── Wiring ── */
  function serviceFrom(el) {
    if (el.dataset.service) return el.dataset.service;
    try { return new URL(el.href, location.href).searchParams.get("service"); } catch { return null; }
  }

  // Used by /book/manage/ to show the time picker for moving a booking.
  window.AWBooking = {
    mountReschedule(el, opts) {
      el.classList.add("bk", "bk-inline");
      return createWidget(el, { reschedule: opts });
    },
    // Generic time picker: { serviceId, timeZone, title, summaryHtml, confirmLabel, cancelLabel, busyLabel, onConfirm(slot), onCancel() }
    mountPicker(el, opts) {
      el.classList.add("bk", "bk-inline");
      return createWidget(el, { picker: opts });
    },
    api: API,
  };

  const inlineHost = document.querySelector("[data-booking-inline]");
  let inlineWidget = null;
  if (inlineHost) {
    inlineHost.classList.add("bk", "bk-inline");
    inlineWidget = createWidget(inlineHost);
    const params = new URLSearchParams(location.search);
    const saved = readDraft();
    // Back from Stripe without paying: let the hold go, then pick up exactly
    // where they left off (their time is free again, so they can pick it).
    if (params.get("checkout") === "cancelled") {
      const hold = params.get("hold") || (saved && saved.holdId);
      releaseHold(hold).then(() => {
        const d = readDraft();
        if (d) { if (d.holdId) writeDraft({ ...d, holdId: undefined }); inlineWidget.resume(readDraft()); }
      });
    }
    else if (params.get("service")) inlineWidget.start(params.get("service"));
  }

  updateCart();

  document.addEventListener("click", (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const trigger = e.target.closest('[data-book], a[href="/book/"], a[href^="/book/?"], a[href="https://averywhitted.com/book/"], a[href^="https://averywhitted.com/book/?"]');
    if (!trigger || trigger.closest(".bk")) return;
    if (typeof HTMLDialogElement !== "function") return; // very old browser: follow the link to /book/
    e.preventDefault();
    const service = serviceFrom(trigger);
    try {
      const promo = trigger.dataset.promo || new URL(trigger.href, location.href).searchParams.get("promo");
      if (promo && PROMO_RE.test(promo)) sessionStorage.setItem("bk-promo", promo.toUpperCase());
    } catch { /* not a link */ }
    if (inlineWidget) {
      inlineHost.scrollIntoView({ behavior: "smooth", block: "start" });
      inlineWidget.start(service);
    } else {
      openModal(service);
    }
  });
})();
