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

  const API = (document.currentScript && document.currentScript.dataset.api) || "https://book.averywhitted.com";
  const AVERY_TZ = "America/New_York";
  const CONTACT = "info@averywhitted.com";
  const STEPS = ["Session", "Time", "Details"];
  const COMMON_TZ = [
    "America/New_York", "America/Chicago", "America/Denver", "America/Phoenix", "America/Los_Angeles",
    "America/Anchorage", "Pacific/Honolulu", "America/Toronto", "America/Vancouver", "Europe/London",
    "Europe/Paris", "Europe/Berlin", "Australia/Sydney",
  ];

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

  /* ── API ── */
  let servicesPromise;
  function loadServices() {
    servicesPromise ||= fetch(`${API}/api/services`)
      .then((r) => { if (!r.ok) throw new Error(); return r.json(); })
      .then((list) => list.filter((s) => s.kind !== "bundle").sort((a, b) => a.durationMinutes - b.durationMinutes))
      .catch((e) => { servicesPromise = null; throw e; });
    return servicesPromise;
  }
  const slotCache = new Map();
  async function loadSlots(serviceId, from) {
    const key = `${serviceId}|${from}`;
    const hit = slotCache.get(key);
    if (hit && Date.now() - hit.at < 60000) return hit.data;
    const r = await fetch(`${API}/api/availability?service=${encodeURIComponent(serviceId)}&from=${from}&days=7`);
    if (!r.ok) throw new Error(String(r.status));
    const data = await r.json();
    slotCache.set(key, { at: Date.now(), data });
    return data;
  }

  /* ── Widget ── */
  function createWidget(root, { inModal = false, onClose } = {}) {
    const today = dateKey(Date.now(), AVERY_TZ);
    const state = {
      step: 0,
      services: null,
      servicesError: false,
      service: null,
      tz: detectTz(),
      weekStart: today,
      week: null,          // { loading, error, data }
      day: null,
      slot: null,          // UTC ms
      form: {},
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
      <div class="bk-body" aria-live="polite"></div>
      <div class="bk-foot"></div>`;
    const $title = root.querySelector(".bk-title");
    const $steps = root.querySelector(".bk-steps");
    const $body = root.querySelector(".bk-body");
    const $foot = root.querySelector(".bk-foot");

    /* Rendering */
    function render() {
      $title.textContent = [inModal ? "Book a session" : "Choose a session", "Pick a time", "Your details"][state.step];
      $steps.innerHTML = STEPS.map((name, i) => {
        const current = i === state.step ? ' aria-current="step"' : "";
        const done = i < state.step ? " is-done" : "";
        const inner = `<span class="bk-step-n">${i + 1}</span><span class="bk-step-label">${name}</span>`;
        return `<li>${i < state.step
          ? `<button type="button" class="bk-step${done}" data-action="goto" data-step="${i}">${inner}</button>`
          : `<span class="bk-step${done}"${current}>${inner}</span>`}</li>`;
      }).join("");
      $body.innerHTML = [renderServices, renderTimes, renderDetails][state.step]();
      $foot.innerHTML = renderFoot();
      if (state.step === 1) {
        const picked = $body.querySelector('.bk-day[aria-pressed="true"]');
        if (picked) picked.scrollIntoView({ block: "nearest", inline: "nearest" });
      }
    }

    function summary(withTime) {
      const s = state.service;
      const title = s.kind === "intro" ? esc(s.name) : "Private Coaching";
      const when = withTime && state.slot
        ? `<span class="bk-sep">&middot;</span><span>${esc(fmt(state.tz, { weekday: "short", month: "short", day: "numeric" }).format(state.slot))}, ${esc(fmt(state.tz, { hour: "numeric", minute: "2-digit" }).format(state.slot))} ${esc(tzName(state.tz, state.slot, "short"))}</span>`
        : "";
      return `<div class="bk-summary"><strong>${title}</strong><span class="bk-sep">&middot;</span><span>${lengthLabel(s.durationMinutes)}</span><span class="bk-sep">&middot;</span><span>Zoom</span>${when}<span class="bk-price">${s.priceCents ? money(s.priceCents) : "Free"}</span></div>`;
    }

    function renderServices() {
      if (state.servicesError) {
        return `<div class="bk-empty is-error">Sessions couldn't load. Check your connection and try again.<button type="button" class="bk-btn" data-action="retry-services">Try again</button></div>`;
      }
      if (!state.services) return `<div class="bk-skel">${'<div class="bk-skel-row" style="height:88px"></div>'.repeat(4)}</div>`;
      return `<ul class="bk-svcs">${state.services.map((s) => `
        <li><button type="button" class="bk-svc${s.kind === "intro" ? " is-intro" : ""}" data-action="service" data-id="${esc(s.id)}" aria-pressed="${state.service && state.service.id === s.id}">
          <span class="bk-svc-num" aria-hidden="true">${s.durationMinutes}<small>MIN</small></span>
          <span>
            <span class="bk-svc-name">${s.kind === "intro" ? esc(s.name) : esc(sessionTitle(s.durationMinutes))}</span>
            <span class="bk-svc-blurb">${esc(s.blurb || "")}</span>
          </span>
          <span class="bk-svc-price${s.priceCents ? "" : " is-free"}">${s.priceCents ? money(s.priceCents) : "Free"}</span>
        </button></li>`).join("")}</ul>`;
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
          <span class="bk-day-count">${n ? `${n} open` : "none"}</span>
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
            <p class="bk-label">${esc(keyToLabel(state.day, { weekday: "long", month: "long", day: "numeric" }))}</p>
            <p class="bk-label">${esc(tzShort)}</p>
          </div>
          <div class="bk-slots">${daySlots.map((ms) => `
            <button type="button" class="bk-slot" data-action="slot" data-start="${ms}" aria-pressed="${ms === state.slot}">${esc(fmt(state.tz, { hour: "numeric", minute: "2-digit" }).format(ms))}</button>`).join("")}
          </div>`;
      }

      const notes = [];
      if (state.tz !== AVERY_TZ) notes.push(`Avery is based in New York. Times are shown in your time zone (${esc(tzName(state.tz))}).`);
      if (w.data.notice) notes.push(esc(w.data.notice));

      return summary(false) + toolbar + `<div class="bk-days${days.length > 7 ? " is-8" : ""}" role="group" aria-label="Days">${dayButtons}</div>` + slotsHtml
        + notes.map((n) => `<p class="bk-callout">${n}</p>`).join("");
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
      const policy = intro
        ? "I understand I can reschedule or cancel up to 24 hours before our call."
        : "I understand I can reschedule or cancel up to 24 hours before my session. Refunds for cancellations are issued by Avery and can take a few business days to appear.";
      return summary(true) + `
        <form class="bk-form" id="bk-form" novalidate>
          <div class="bk-field"><label for="bk-name">Name</label>
            <input class="bk-input" id="bk-name" name="name" autocomplete="name" required maxlength="120" value="${v("name")}"></div>
          <div class="bk-field"><label for="bk-email">Email</label>
            <input class="bk-input" id="bk-email" name="email" type="email" autocomplete="email" required maxlength="200" value="${v("email")}"></div>
          <div class="bk-field"><label for="bk-pronouns">Pronouns <span class="bk-opt">(optional)</span></label>
            <input class="bk-input" id="bk-pronouns" name="pronouns" maxlength="40" placeholder="she/her, they/them..." value="${v("pronouns")}"></div>
          ${intro ? "" : `<div class="bk-field"><label for="bk-link">Link to materials <span class="bk-opt">(optional)</span></label>
            <input class="bk-input" id="bk-link" name="link" type="url" inputmode="url" maxlength="500" placeholder="https://" value="${v("link")}"></div>`}
          <div class="bk-field is-wide"><label for="bk-goal">${intro ? "What would you like to talk about?" : "Main goal for the session"}</label>
            <textarea class="bk-input" id="bk-goal" name="goal" required maxlength="2000">${v("goal")}</textarea></div>
          ${intro ? "" : `<div class="bk-field is-wide"><label for="bk-material">Material to work on first</label>
            <textarea class="bk-input" id="bk-material" name="material" required maxlength="2000" placeholder="Sides, a monologue, a self-tape... &quot;Not sure yet&quot; is fine.">${v("material")}</textarea></div>`}
          <div class="bk-field is-wide"><label for="bk-notes">Anything else I should know? <span class="bk-opt">(optional)</span></label>
            <textarea class="bk-input" id="bk-notes" name="notes" maxlength="2000">${v("notes")}</textarea></div>
          <label class="bk-check"><input type="checkbox" name="policy" required${f.policy ? " checked" : ""}><span>${policy}</span></label>
          ${state.message ? `<p class="bk-msg is-${state.message.kind}" role="${state.message.kind === "error" ? "alert" : "status"}">${state.message.text}</p>` : ""}
        </form>`;
    }

    function renderFoot() {
      const inPerson = `Sessions are on Zoom. Want to meet in person? <a href="mailto:${CONTACT}">Reach out</a> before booking.`;
      if (state.step === 0) return `<p class="bk-note">${inPerson}</p>`;
      const back = `<button type="button" class="bk-btn ghost" data-action="back">&larr; Back</button>`;
      if (state.step === 1) {
        return `${back}<button type="button" class="bk-btn primary" data-action="to-details"${state.slot ? "" : " disabled"}>Continue &rarr;</button>`;
      }
      const label = state.service.kind === "intro" ? "Book intro call" : `Continue to payment &middot; ${money(state.service.priceCents)}`;
      return `${back}<button type="submit" form="bk-form" class="bk-btn primary"${state.submitting ? " disabled" : ""}>${state.submitting ? '<span class="bk-spin" aria-hidden="true"></span>One moment' : label}</button>`;
    }

    /* Navigation */
    function go(step) {
      state.step = step;
      state.message = null;
      render();
      $body.scrollTop = 0;
      $title.focus({ preventScroll: true });
    }

    async function loadWeek() {
      const token = ++loadToken;
      state.week = { loading: true };
      render();
      try {
        const data = await loadSlots(state.service.id, state.weekStart);
        if (token !== loadToken) return;
        state.week = { data };
        const byDay = groupByDay(data.slots);
        const days = dayList(byDay);
        if (!state.day || !(byDay.get(state.day) || []).length) state.day = days.find((k) => (byDay.get(k) || []).length) || days[0];
        if (state.slot && !data.slots.some((iso) => Date.parse(iso) === state.slot)) state.slot = null;
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
      }
      if (advance) { go(1); loadWeek(); }
      return true;
    }

    function saveForm() {
      const form = root.querySelector("#bk-form");
      if (!form) return;
      for (const el of form.elements) {
        if (!el.name) continue;
        state.form[el.name] = el.type === "checkbox" ? el.checked : el.value;
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
        const bad = fresh.querySelector(":invalid");
        if (bad) bad.focus();
        return;
      }
      state.submitting = true;
      state.message = null;
      render();
      const f = state.form;
      try {
        const r = await fetch(`${API}/api/bookings`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            serviceId: state.service.id,
            start: new Date(state.slot).toISOString(),
            timeZone: state.tz,
            intake: {
              name: f.name, email: f.email, pronouns: f.pronouns || "", goal: f.goal,
              material: f.material || "", link: f.link || "", notes: f.notes || "", policyAccepted: !!f.policy,
            },
          }),
        });
        const data = await r.json().catch(() => ({}));
        if (r.ok && data.checkoutUrl) { window.location.href = data.checkoutUrl; return; }
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
      else if (a === "back") { if (state.step === 2) saveForm(); go(state.step - 1); }
      else if (a === "prev-week") { state.weekStart = addDays(state.weekStart, -7); if (state.weekStart < today) state.weekStart = today; state.day = null; loadWeek(); }
      else if (a === "next-week") { state.weekStart = addDays(state.weekStart, 7); state.day = null; loadWeek(); }
      else if (a === "retry-week") loadWeek();
      else if (a === "retry-services") init();
      else if (a === "day") { state.day = t.dataset.date; render(); }
      else if (a === "slot") { state.slot = +t.dataset.start; render(); }
      else if (a === "to-details") { if (state.slot) go(2); }
    });
    root.addEventListener("change", (e) => {
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
    root.addEventListener("input", () => { if (state.step === 2) saveForm(); });
    root.addEventListener("submit", (e) => { e.preventDefault(); if (!state.submitting) submit(e.target); });

    async function init() {
      state.servicesError = false;
      render();
      try {
        state.services = await loadServices();
      } catch {
        state.servicesError = true;
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
      focus() { $title.focus({ preventScroll: true }); },
      close: onClose,
    };
  }

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
    // Click on the dim backdrop closes it.
    dialog.addEventListener("click", (e) => { if (e.target === dialog) dialog.close(); });
    dialog.addEventListener("close", () => document.documentElement.classList.remove("bk-lock"));
    modal = { dialog, widget };
    return modal;
  }

  function openModal(serviceId) {
    const { dialog, widget } = getModal();
    if (!dialog.open) {
      document.documentElement.classList.add("bk-lock");
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

  const inlineHost = document.querySelector("[data-booking-inline]");
  let inlineWidget = null;
  if (inlineHost) {
    inlineHost.classList.add("bk", "bk-inline");
    inlineWidget = createWidget(inlineHost);
    const pre = new URLSearchParams(location.search).get("service");
    if (pre) inlineWidget.start(pre);
  }

  document.addEventListener("click", (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const trigger = e.target.closest('[data-book], a[href="/book/"], a[href^="/book/?"], a[href="https://averywhitted.com/book/"], a[href^="https://averywhitted.com/book/?"]');
    if (!trigger || trigger.closest(".bk")) return;
    if (typeof HTMLDialogElement !== "function") return; // very old browser: follow the link to /book/
    e.preventDefault();
    const service = serviceFrom(trigger);
    if (inlineWidget) {
      inlineHost.scrollIntoView({ behavior: "smooth", block: "start" });
      inlineWidget.start(service);
    } else {
      openModal(service);
    }
  });
})();
