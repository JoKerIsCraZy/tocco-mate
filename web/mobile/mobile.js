/* ============================================================
   Tocco Mate — Mobile / PWA front-end
   Single-file SPA: Hash-Router + 4 Views (Noten / Stundenplan /
   Settings / Modul-Detail). Same API + same token storage as the
   Dashboard, so a token entered there works here too.
   ============================================================ */

'use strict';

const STORAGE_TOKEN = 'tocco.authToken';
const API_BASE = ''; // same origin — no extra server config needed.

const $  = (sel, root) => (root || document).querySelector(sel);
const main = $('#main');
const titleEl = $('#appbarTitle');
const backBtn = $('#backBtn');
const refreshBtn = $('#refreshBtn');
const appbarLogo = $('#appbarLogo');
const bottomNav = $('#bottomNav');
const loginOverlay = $('#loginOverlay');
const loginForm = $('#loginForm');
const loginToken = $('#loginToken');
const loginStatus = $('#loginStatus');
const toastEl = $('#toast');

function getToken()   { try { return localStorage.getItem(STORAGE_TOKEN) || ''; } catch (_) { return ''; } }
function setToken(v)  { try { localStorage.setItem(STORAGE_TOKEN, v); } catch (_) {} }
function clearToken() { try { localStorage.removeItem(STORAGE_TOKEN); } catch (_) {} }

function showLogin(msg) {
  loginStatus.textContent = msg || '';
  loginOverlay.hidden = false;
  setTimeout(() => loginToken.focus(), 50);
}
function hideLogin() {
  loginOverlay.hidden = true;
  loginStatus.textContent = '';
  loginToken.value = '';
}

let toastTimer;
function toast(msg, type) {
  toastEl.textContent = msg;
  toastEl.className = 'm-toast' + (type === 'err' ? ' m-toast--err' : '');
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, 3500);
}

/* ============================================================
   Tiny API client
   ============================================================ */
async function apiFetch(path, opts) {
  const token = getToken();
  if (!token) { showLogin(); throw new Error('no-token'); }
  const headers = Object.assign({}, (opts && opts.headers) || {}, {
    'Authorization': 'Bearer ' + token,
    'Accept': 'application/json'
  });
  if (opts && opts.body && typeof opts.body !== 'string') {
    headers['Content-Type'] = 'application/json';
    opts = Object.assign({}, opts, { body: JSON.stringify(opts.body) });
  }
  const res = await fetch(API_BASE + path, Object.assign({}, opts || {}, { headers }));
  if (res.status === 401) {
    clearToken();
    showLogin('Token ungültig — bitte neu eingeben');
    const e = new Error('Unauthorized'); e.silent = true; throw e;
  }
  if (res.status === 429) {
    let msg = 'Zu viele Anfragen — kurz warten';
    try { const j = await res.json(); if (j && j.error) msg = j.error; } catch (_) {}
    toast(msg, 'err');
    throw new Error(msg);
  }
  if (!res.ok) {
    let msg = 'Fehler ' + res.status;
    try { const j = await res.json(); if (j && j.error) msg = j.error; } catch (_) {}
    throw new Error(msg);
  }
  if (res.status === 204) return null;
  return res.json();
}

/* ============================================================
   View renderers
   ============================================================ */
function gradeClass(n) {
  if (n == null) return 'm-grade--none';
  if (n >= 5.0) return 'm-grade--excellent';
  if (n >= 4.0) return 'm-grade--good';
  return 'm-grade--fail';
}
function fmtGrade(n) {
  if (n == null) return '–';
  return n.toFixed(1);
}
function modulNummerOf(kuerzel_code) {
  if (!kuerzel_code) return null;
  const parts = kuerzel_code.split('-');
  if (!parts.length) return null;
  const last = parts[parts.length - 1];
  if (isNaN(parseInt(last, 10)) && parts.length >= 2) {
    const prev = parts[parts.length - 2];
    if (!/^S\d+$/.test(prev)) return prev + '-' + last;
  }
  return last;
}
function buildTitle(kuerzel_code, fach_name) {
  const num = modulNummerOf(kuerzel_code);
  return num ? num + ' — ' + (fach_name || 'Modul') : (fach_name || 'Modul');
}

function loadingShell() {
  main.innerHTML = '<div class="m-loading"><div class="m-spinner"></div>Lade…</div>';
}
function errorShell(msg) {
  const div = document.createElement('div');
  div.className = 'm-error';
  div.textContent = msg;
  main.replaceChildren(div);
}

/* --- View: Noten --- */
let notenState = { query: '', sort: 'fach', onlyWithGrade: false };
async function renderNoten() {
  titleEl.textContent = 'Noten';
  loadingShell();
  try {
    const data = await apiFetch('/api/noten');
    drawNoten(data);
  } catch (e) {
    if (e.silent) return;
    errorShell(e.message || 'Fehler beim Laden der Noten');
  }
}
function drawNoten(data) {
  main.replaceChildren();

  if (data && data.avg != null) {
    const hero = document.createElement('div');
    hero.className = 'm-hero';
    const left = document.createElement('div');
    const lab = document.createElement('div'); lab.className = 'm-hero__label'; lab.textContent = 'Durchschnitt';
    const val = document.createElement('div'); val.className = 'm-hero__value'; val.textContent = data.avg.toFixed(2);
    left.append(lab, val);
    const right = document.createElement('div'); right.className = 'm-hero__meta';
    right.innerHTML = '<strong>' + (data.count || 0) + '</strong><br>Module';
    hero.append(left, right);
    main.append(hero);
  }
  if (data && data.bySemester) {
    const semHero = document.createElement('div');
    semHero.className = 'm-card';
    semHero.style.justifyContent = 'space-around';
    Object.entries(data.bySemester).forEach(function (entry) {
      const sem = entry[0];
      const avg = entry[1];
      const col = document.createElement('div');
      col.style.textAlign = 'center';
      col.innerHTML = '<div class="m-card__sub">Ø ' + sem + '</div>'
        + '<div class="m-card__grade ' + gradeClass(avg) + '" style="font-size:22px;">'
        + (avg != null ? avg.toFixed(2) : '—') + '</div>';
      semHero.append(col);
    });
    if (semHero.children.length) main.append(semHero);
  }

  const filter = document.createElement('div');
  filter.className = 'm-filter';
  filter.innerHTML =
    '<div class="m-search">' +
      '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>' +
      '<input id="notenSearch" type="search" placeholder="Modul-Nr. oder Name suchen" autocomplete="off" spellcheck="false" />' +
    '</div>' +
    '<div class="m-chips" role="tablist">' +
      '<button type="button" class="m-chip" data-sort="fach">A–Z</button>' +
      '<button type="button" class="m-chip" data-sort="low">Tiefste</button>' +
      '<button type="button" class="m-chip" data-sort="high">Höchste</button>' +
      '<button type="button" class="m-chip" data-only="1">Nur benotete</button>' +
    '</div>';
  main.append(filter);

  const list = document.createElement('div');
  list.className = 'm-list';
  list.id = 'notenList';
  main.append(list);

  const search = filter.querySelector('#notenSearch');
  search.value = notenState.query;
  search.addEventListener('input', () => {
    notenState.query = search.value;
    drawNotenList(data && data.rows ? data.rows : []);
  });
  filter.querySelectorAll('.m-chip[data-sort]').forEach((btn) => {
    btn.addEventListener('click', () => {
      notenState.sort = btn.dataset.sort;
      updateChipActive(filter);
      drawNotenList(data && data.rows ? data.rows : []);
    });
  });
  const onlyChip = filter.querySelector('.m-chip[data-only]');
  onlyChip.addEventListener('click', () => {
    notenState.onlyWithGrade = !notenState.onlyWithGrade;
    updateChipActive(filter);
    drawNotenList(data && data.rows ? data.rows : []);
  });
  updateChipActive(filter);
  drawNotenList(data && data.rows ? data.rows : []);
}
function updateChipActive(root) {
  root.querySelectorAll('.m-chip[data-sort]').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.sort === notenState.sort));
  });
  const oc = root.querySelector('.m-chip[data-only]');
  oc.setAttribute('aria-pressed', String(notenState.onlyWithGrade));
}
function drawNotenList(rows) {
  const list = $('#notenList');
  if (!list) return;
  list.replaceChildren();
  const q = notenState.query.trim().toLowerCase();
  let filtered = rows.slice();
  if (notenState.onlyWithGrade) filtered = filtered.filter(r => r.note != null);
  if (q) {
    filtered = filtered.filter((r) => {
      const hay = [r.fach_name, r.kuerzel_code, r.kuerzel_full, r.fach_code,
        modulNummerOf(r.kuerzel_code)].filter(Boolean).join(' ').toLowerCase();
      return hay.indexOf(q) !== -1;
    });
  }
  if (notenState.sort === 'fach') {
    filtered.sort((a, b) => (a.fach_name || '').localeCompare(b.fach_name || ''));
  } else if (notenState.sort === 'low') {
    filtered.sort((a, b) => {
      if (a.note == null && b.note == null) return 0;
      if (a.note == null) return 1;
      if (b.note == null) return -1;
      return a.note - b.note;
    });
  } else if (notenState.sort === 'high') {
    filtered.sort((a, b) => {
      if (a.note == null && b.note == null) return 0;
      if (a.note == null) return 1;
      if (b.note == null) return -1;
      return b.note - a.note;
    });
  }
  if (!filtered.length) {
    const e = document.createElement('div');
    e.className = 'm-empty';
    e.textContent = 'Keine Treffer für die aktuellen Filter.';
    list.append(e);
    return;
  }
  filtered.forEach((row) => list.append(noteCard(row)));
}
function noteCard(row) {
  const card = document.createElement('a');
  card.className = 'm-card is-clickable';
  card.href = '#/modul/' + encodeURIComponent(row.kuerzel_id) + '?code=' + encodeURIComponent(row.kuerzel_code || '');

  const main_ = document.createElement('div');
  main_.className = 'm-card__main';
  const title = document.createElement('div');
  title.className = 'm-card__title';
  title.textContent = buildTitle(row.kuerzel_code, row.fach_name);
  const sub = document.createElement('div');
  sub.className = 'm-card__sub';
  sub.textContent = [row.semester, row.typ].filter(Boolean).join(' · ') || '—';
  main_.append(title, sub);

  const grade = document.createElement('div');
  grade.className = 'm-card__grade ' + gradeClass(row.note);
  grade.textContent = fmtGrade(row.note);

  card.append(main_, grade);
  return card;
}

/* --- View: Stundenplan --- */
async function renderStundenplan() {
  titleEl.textContent = 'Stundenplan';
  loadingShell();
  try {
    const data = await apiFetch('/api/stundenplan');
    drawStundenplan(data);
  } catch (e) {
    if (e.silent) return;
    errorShell(e.message || 'Fehler beim Laden des Stundenplans');
  }
}
function drawStundenplan(data) {
  main.replaceChildren();
  const rows = (data && data.rows) || [];
  if (!rows.length) {
    main.innerHTML = '<div class="m-empty">Keine Stundenplan-Einträge.</div>';
    return;
  }
  const groups = new Map();
  rows.forEach((r) => {
    if (!groups.has(r.datum_iso)) groups.set(r.datum_iso, []);
    groups.get(r.datum_iso).push(r);
  });
  const sortedKeys = Array.from(groups.keys()).sort();
  sortedKeys.forEach((datum) => {
    const h = document.createElement('div');
    h.className = 'm-day-h';
    h.textContent = formatDay(datum);
    main.append(h);
    const list = document.createElement('div');
    list.className = 'm-list';
    groups.get(datum).forEach((entry) => list.append(planCard(entry)));
    main.append(list);
  });
}
function formatDay(iso) {
  try {
    const d = new Date(iso + 'T00:00:00');
    const opts = { weekday: 'long', day: 'numeric', month: 'short' };
    return d.toLocaleDateString('de-DE', opts);
  } catch (_) {
    return iso;
  }
}
function planCard(entry) {
  const card = document.createElement('div');
  card.className = 'm-card';
  card.style.padding = '0';

  const inner = document.createElement('div');
  inner.className = 'm-plan';
  inner.innerHTML =
    '<div class="m-plan__time">' +
      '<div class="m-plan__from"></div>' +
      '<div class="m-plan__to"></div>' +
    '</div>' +
    '<div class="m-plan__divider"></div>' +
    '<div class="m-plan__main">' +
      '<div class="m-plan__name"></div>' +
      '<div class="m-plan__sub"></div>' +
    '</div>';
  inner.querySelector('.m-plan__from').textContent = entry.zeit_von || '';
  inner.querySelector('.m-plan__to').textContent   = entry.zeit_bis || '';
  inner.querySelector('.m-plan__name').textContent = entry.veranstaltung || '';
  inner.querySelector('.m-plan__sub').textContent  = [entry.raum, entry.dozent].filter(Boolean).join(' · ');
  card.append(inner);
  return card;
}

/* --- View: Modul-Detail --- */
async function renderModul(kuerzelId, kuerzelCodeHint) {
  titleEl.textContent = 'Modul';
  loadingShell();
  try {
    const data = await apiFetch('/api/noten/' + encodeURIComponent(kuerzelId) + '/pruefungen');
    titleEl.textContent = buildTitle(data.kuerzelCode || kuerzelCodeHint, data.fachName);
    drawModul(data);
  } catch (e) {
    if (e.silent) return;
    errorShell(e.message || 'Fehler beim Laden des Moduls');
  }
}
function computeWeighted(rows) {
  const scored = rows.filter(r => r.bewertung != null);
  if (!scored.length) return null;
  let totalW = 0, totalGrade = 0;
  scored.forEach((r) => {
    const w = (r.gewicht_pct != null) ? r.gewicht_pct : 1.0;
    totalW += w;
    totalGrade += w * r.bewertung;
  });
  if (totalW <= 0) return null;
  return totalGrade / totalW;
}
function drawModul(data) {
  main.replaceChildren();
  const rows = (data && data.rows) || [];
  const computed = computeWeighted(rows);

  const stats = document.createElement('div');
  stats.className = 'm-stats-card';
  stats.innerHTML =
    '<div class="m-stat"><div class="m-stat__value ' + gradeClass(data.modulNote) + '">' +
      (data.modulNote != null ? data.modulNote.toFixed(1) : '—') +
    '</div><div class="m-stat__label">Modulnote</div></div>' +
    '<div class="m-stat"><div class="m-stat__value ' + gradeClass(computed) + '">' +
      (computed != null ? computed.toFixed(2) : '—') +
    '</div><div class="m-stat__label">Berechnet</div></div>';
  main.append(stats);

  if (!rows.length) {
    const empty = document.createElement('div');
    empty.className = 'm-empty';
    empty.textContent = 'Für dieses Modul sind noch keine ZP/LB-Noten erfasst.';
    main.append(empty);
    return;
  }

  const groups = [
    { label: 'Zwischenprüfungen', filter: r => r.pruefung_typ === 'ZP' },
    { label: 'Lernbeurteilungen',  filter: r => r.pruefung_typ === 'LB' },
    { label: 'Weitere',            filter: r => r.pruefung_typ !== 'ZP' && r.pruefung_typ !== 'LB' }
  ];
  groups.forEach((g) => {
    const items = rows.filter(g.filter);
    if (!items.length) return;
    const h = document.createElement('div');
    h.className = 'm-section-h';
    h.innerHTML = '<span>' + g.label + '</span><span class="m-section-h__count">' + items.length + '</span>';
    main.append(h);
    const list = document.createElement('div');
    list.className = 'm-list';
    items.forEach((p) => list.append(pruefungCard(p)));
    main.append(list);
  });
}
function pruefungCard(p) {
  const card = document.createElement('div');
  card.className = 'm-card';
  const inner = document.createElement('div');
  inner.className = 'm-pruefung';
  inner.style.flex = '1';

  const tag = document.createElement('div');
  tag.className = 'm-pruefung__tag';
  tag.textContent = (p.pruefung_typ || '') + (p.pruefung_nr != null ? p.pruefung_nr : '');

  const main_ = document.createElement('div');
  main_.style.flex = '1';
  main_.style.minWidth = '0';
  if (p.bezeichnung) {
    const t = document.createElement('div');
    t.className = 'm-card__title';
    t.style.fontSize = '14px';
    t.textContent = p.bezeichnung;
    main_.append(t);
  }
  const w = (p.gewicht != null) ? p.gewicht
            : (p.gewicht_pct != null ? p.gewicht_pct.toFixed(0) + '%' : null);
  if (w) {
    const s = document.createElement('div');
    s.className = 'm-card__sub';
    s.textContent = 'Gewicht: ' + w;
    main_.append(s);
  }

  const grade = document.createElement('div');
  grade.className = 'm-card__grade ' + gradeClass(p.bewertung);
  grade.textContent = (p.bewertung != null) ? p.bewertung.toFixed(1)
                    : (p.bewertung_raw || '—');

  inner.append(tag, main_, grade);
  card.append(inner);
  return card;
}

/* --- View: Settings --- */
async function renderSettings() {
  titleEl.textContent = 'Einstellungen';
  loadingShell();
  try {
    const s = await apiFetch('/api/settings');
    drawSettings(s);
  } catch (e) {
    if (e.silent) return;
    errorShell(e.message || 'Fehler beim Laden der Einstellungen');
  }
}
// Local working copy of the schedule arrays (mutated by chips / time list).
let settingsState = null;

function drawSettings(s) {
  main.replaceChildren();
  settingsState = {
    scheduleMode: (s && s.scheduleMode === 'weekly') ? 'weekly' : 'interval',
    scheduleDays: Array.isArray(s && s.scheduleDays) ? s.scheduleDays.slice() : [1, 2, 3, 4, 5],
    scheduleTimes: Array.isArray(s && s.scheduleTimes) ? s.scheduleTimes.slice() : ['08:00']
  };

  const form = document.createElement('form');
  form.className = 'm-form';
  form.id = 'settingsForm';

  // Scrape-Card ganz oben — separat von den Fieldsets damit sie immer
  // sofort sichtbar ist und die Settings-Form drumherum animiert.
  const scrapeWrap = document.createElement('div');
  scrapeWrap.id = 'scrapeCard';
  renderScrapeCard(scrapeWrap);
  form.append(scrapeWrap);

  form.append(
    fsetAnmeldung(s),
    fsetAutomatik(s),
    fsetBrowser(s),
    fsetPush(),
    fsetTelegram(s),
    fsetUrls(s),
    fsetToken()
  );

  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.className = 'm-btn m-btn--primary m-btn--block';
  submit.textContent = 'Speichern';
  form.append(submit);

  const back = document.createElement('a');
  back.href = '/';
  back.className = 'm-btn m-btn--block';
  back.style.marginTop = '8px';
  back.textContent = '← Zurück zum Dashboard';
  form.append(back);

  // Save handler
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const payload = collectSettingsPayload(form);
    submit.disabled = true;
    try {
      await apiFetch('/api/settings', { method: 'PATCH', body: payload });
      toast('Gespeichert');
    } catch (e) {
      if (!e.silent) toast(e.message || 'Speichern fehlgeschlagen', 'err');
    } finally {
      submit.disabled = false;
    }
  });

  main.append(form);
  applyScheduleModeVisibility(form);
}

function fsetAnmeldung(s) {
  const fs = makeFieldset('Anmeldung');
  fs.append(
    field('Microsoft-E-Mail', input('msEmail', 'email', s && s.msEmail)),
    field('Passwort', input('msPassword', 'password', '', '••• (unverändert)'),
          'Leer lassen, um das gespeicherte Passwort zu behalten.'),
    field('User-PK', input('userPk', 'text', s && s.userPk),
          'Primärschlüssel des eingeloggten Tocco-Benutzers.')
  );
  return fs;
}

function fsetAutomatik(s) {
  const fs = makeFieldset('Automatik');
  fs.append(toggle('autoRun', 'Auto-Run aktivieren', s && s.autoRun));

  // Mode-switch (interval | weekly)
  const modeWrap = document.createElement('div');
  modeWrap.className = 'm-field';
  const modeLab = document.createElement('span'); modeLab.textContent = 'Modus';
  const modeSwitch = document.createElement('div');
  modeSwitch.className = 'm-modeswitch';
  ['interval', 'weekly'].forEach((mode) => {
    const lab = document.createElement('label');
    lab.className = 'm-modeswitch__opt';
    const radio = document.createElement('input');
    radio.type = 'radio'; radio.name = 'scheduleMode'; radio.value = mode;
    radio.checked = settingsState.scheduleMode === mode;
    radio.addEventListener('change', () => {
      settingsState.scheduleMode = mode;
      applyScheduleModeVisibility(document.getElementById('settingsForm'));
    });
    const span = document.createElement('span');
    span.textContent = mode === 'interval' ? '⏱ Intervall' : '📅 Wochenplan';
    lab.append(radio, span);
    modeSwitch.append(lab);
  });
  modeWrap.append(modeLab, modeSwitch);
  fs.append(modeWrap);

  // Wochentage (always visible — both modes use them)
  const daysWrap = document.createElement('div');
  daysWrap.className = 'm-field';
  const daysLab = document.createElement('span'); daysLab.textContent = 'Wochentage';
  const chips = document.createElement('div');
  chips.className = 'm-daychips';
  const dayMap = [
    [1, 'Mo'], [2, 'Di'], [3, 'Mi'], [4, 'Do'],
    [5, 'Fr'], [6, 'Sa'], [0, 'So']
  ];
  dayMap.forEach(([num, label]) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'm-daychip';
    b.dataset.day = String(num);
    b.textContent = label;
    if (settingsState.scheduleDays.includes(num)) b.setAttribute('aria-pressed', 'true');
    b.addEventListener('click', () => {
      const idx = settingsState.scheduleDays.indexOf(num);
      if (idx >= 0) settingsState.scheduleDays.splice(idx, 1);
      else settingsState.scheduleDays.push(num);
      settingsState.scheduleDays.sort((a, b) => a - b);
      b.setAttribute('aria-pressed', String(idx < 0));
    });
    chips.append(b);
  });
  daysWrap.append(daysLab, chips);
  fs.append(daysWrap);

  // ----- Interval-mode panel -----
  const ivWrap = document.createElement('div');
  ivWrap.dataset.modePanel = 'interval';
  ivWrap.className = 'm-mode-panel';

  const slField = document.createElement('div');
  slField.className = 'm-field';
  const slHead = document.createElement('span');
  const minutes = (s && Number.isFinite(s.intervalMinutes)) ? s.intervalMinutes : 60;
  slHead.innerHTML = 'Intervall: <strong id="ivLabel">' + minutes + '</strong> Min.';
  const slider = document.createElement('input');
  slider.type = 'range'; slider.name = 'intervalMinutes';
  slider.min = '5'; slider.max = '1440'; slider.step = '5';
  slider.value = String(minutes);
  slider.className = 'm-range';
  slider.addEventListener('input', () => {
    const lab = document.getElementById('ivLabel');
    if (lab) lab.textContent = slider.value;
  });
  const scale = document.createElement('div');
  scale.className = 'm-rangescale';
  scale.innerHTML = '<span>5</span><span>360</span><span>720</span><span>1440</span>';
  slField.append(slHead, slider, scale);
  ivWrap.append(slField);

  const tfWrap = document.createElement('div');
  tfWrap.className = 'm-field';
  const tfLab = document.createElement('span'); tfLab.textContent = 'Zeitfenster';
  const tfRow = document.createElement('div');
  tfRow.className = 'm-timerange';
  const tFrom = document.createElement('input');
  tFrom.type = 'time'; tFrom.name = 'intervalTimeFrom';
  tFrom.value = (s && s.intervalTimeFrom) || '08:00';
  const tBis = document.createElement('span');
  tBis.className = 'm-timerange__sep'; tBis.textContent = 'bis';
  const tTo = document.createElement('input');
  tTo.type = 'time'; tTo.name = 'intervalTimeTo';
  tTo.value = (s && s.intervalTimeTo) || '20:00';
  tfRow.append(tFrom, tBis, tTo);
  tfWrap.append(tfLab, tfRow);
  ivWrap.append(tfWrap);

  fs.append(ivWrap);

  // ----- Weekly-mode panel -----
  const wkWrap = document.createElement('div');
  wkWrap.dataset.modePanel = 'weekly';
  wkWrap.className = 'm-mode-panel';

  const tlWrap = document.createElement('div');
  tlWrap.className = 'm-field';
  const tlLab = document.createElement('span'); tlLab.textContent = 'Uhrzeiten';
  const tlList = document.createElement('div');
  tlList.id = 'scheduleTimes';
  tlList.className = 'm-timelist';
  redrawTimeList(tlList);
  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'm-btn m-btn--block';
  addBtn.style.marginTop = '8px';
  addBtn.textContent = '+ Zeit hinzufügen';
  addBtn.addEventListener('click', () => {
    settingsState.scheduleTimes.push('12:00');
    redrawTimeList(tlList);
  });
  tlWrap.append(tlLab, tlList, addBtn);
  wkWrap.append(tlWrap);

  fs.append(wkWrap);

  return fs;
}

function redrawTimeList(container) {
  container.replaceChildren();
  if (!settingsState.scheduleTimes.length) {
    const e = document.createElement('div');
    e.className = 'm-field__hint';
    e.textContent = 'Noch keine Zeit hinterlegt — füge eine hinzu.';
    container.append(e);
    return;
  }
  settingsState.scheduleTimes.forEach((t, i) => {
    const row = document.createElement('div');
    row.className = 'm-timelist__row';
    const inp = document.createElement('input');
    inp.type = 'time'; inp.value = t;
    inp.addEventListener('change', () => { settingsState.scheduleTimes[i] = inp.value; });
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'm-timelist__del';
    del.setAttribute('aria-label', 'Zeit entfernen');
    del.innerHTML = '&times;';
    del.addEventListener('click', () => {
      settingsState.scheduleTimes.splice(i, 1);
      redrawTimeList(container);
    });
    row.append(inp, del);
    container.append(row);
  });
}

function applyScheduleModeVisibility(form) {
  if (!form) return;
  form.querySelectorAll('[data-mode-panel]').forEach((el) => {
    el.style.display = (el.dataset.modePanel === settingsState.scheduleMode) ? '' : 'none';
  });
}

function fsetBrowser(s) {
  const fs = makeFieldset('Browser');
  fs.append(toggle('headless', 'Headless ausführen', s && s.headless));
  const slowMo = input('slowMo', 'number', (s && s.slowMo != null) ? s.slowMo : 0);
  slowMo.min = '0'; slowMo.max = '5000'; slowMo.step = '50';
  fs.append(field('slowMo (ms)', slowMo));
  return fs;
}

function fsetPush() {
  const fs = makeFieldset('Benachrichtigungen');

  // Diagnose-Block: Service-Worker + PWA + API-Status auf einen Blick
  const diag = document.createElement('div');
  diag.id = 'pushDiag';
  diag.className = 'm-field__hint';
  diag.style.cssText = 'font-size:12px;line-height:1.6;background:var(--bg-elev);' +
    'border:1px solid var(--border);border-radius:8px;padding:10px 12px;' +
    'font-family:var(--font-mono);white-space:pre-wrap;';
  diag.textContent = 'Lade Diagnose…';
  fs.append(diag);

  // Manueller Re-Register Button — exposed um SW-Fehler sichtbar zu machen
  const swBtn = document.createElement('button');
  swBtn.type = 'button';
  swBtn.className = 'm-btn m-btn--block';
  swBtn.textContent = 'Service-Worker (re-)registrieren';
  swBtn.addEventListener('click', async () => {
    swBtn.disabled = true;
    diag.textContent = 'Registriere…';
    const reg = await registerServiceWorker();
    if (reg) {
      try { await navigator.serviceWorker.ready; } catch (_) {}
      toast('Service-Worker registriert');
    } else {
      toast('Registrierung fehlgeschlagen — siehe Diagnose', 'err');
    }
    await refreshDiag();
    swBtn.disabled = false;
  });
  fs.append(swBtn);

  // Status-Zeile (wird dynamisch upgedatet)
  const status = document.createElement('div');
  status.id = 'pushStatus';
  status.className = 'm-field__hint';
  status.style.fontSize = '13px';
  status.style.color = 'var(--text-mute)';
  status.style.marginTop = '12px';
  status.textContent = '–';
  fs.append(status);

  // Toggle "Push aktivieren"
  const toggleWrap = document.createElement('label');
  toggleWrap.className = 'm-toggle';
  const span = document.createElement('span');
  span.className = 'm-toggle__label';
  span.textContent = 'Push aktivieren';
  const cb = document.createElement('input');
  cb.type = 'checkbox'; cb.id = 'pushToggle'; cb.hidden = true;
  const sw = document.createElement('span');
  sw.className = 'm-switch';
  toggleWrap.append(span, cb, sw);
  fs.append(toggleWrap);

  cb.addEventListener('change', async () => {
    if (cb.checked) {
      const ok = await enablePush();
      cb.checked = ok;
      refreshPushStatus();
    } else {
      await disablePush();
      refreshPushStatus();
    }
  });

  // Test-Button
  const testBtn = document.createElement('button');
  testBtn.type = 'button';
  testBtn.className = 'm-btn m-btn--block';
  testBtn.textContent = 'Test-Benachrichtigung senden';
  testBtn.addEventListener('click', async () => {
    testBtn.disabled = true;
    try {
      const r = await apiFetch('/api/push/test', { method: 'POST', body: {} });
      toast('Push gesendet (' + (r.sent || 0) + ' Geräte)');
    } catch (e) {
      if (!e.silent) toast(e.message || 'Push-Test fehlgeschlagen', 'err');
    } finally {
      testBtn.disabled = false;
    }
  });
  fs.append(testBtn);

  const hint = document.createElement('small');
  hint.className = 'm-field__hint';
  hint.innerHTML = 'Auf iOS: PWA muss zuerst über „Zum Home-Bildschirm" installiert sein, ' +
                   'sonst sind Push-Benachrichtigungen nicht möglich.';
  fs.append(hint);

  // Async-Hydrate: Permission + Subscription-State checken
  setTimeout(() => { refreshPushStatus(); refreshDiag(); }, 50);

  return fs;
}

async function refreshDiag() {
  const el = document.getElementById('pushDiag');
  if (!el) return;
  const info = pushSupportInfo();
  const lines = [];
  lines.push('URL:           ' + location.origin);
  lines.push('SecureContext: ' + (window.isSecureContext ? '✓ ja' : '✗ nein (HTTPS fehlt!)'));
  lines.push('serviceWorker: ' + (info.hasSW ? '✓ vorhanden' : '✗ fehlt'));
  lines.push('PushManager:   ' + (info.hasPM ? '✓ vorhanden' : '✗ fehlt'));
  lines.push('Notification:  ' + (info.hasNotif ? '✓ vorhanden' : '✗ fehlt'));
  lines.push('isStandalone:  ' + (info.isStandalone ? '✓ PWA installiert' : '✗ Browser-Tab'));

  if (info.hasSW) {
    try {
      const reg = await navigator.serviceWorker.getRegistration('/mobile/');
      if (reg) {
        const state = (reg.active && reg.active.state)
                    || (reg.installing && reg.installing.state + ' (installing)')
                    || (reg.waiting && reg.waiting.state + ' (waiting)')
                    || 'unknown';
        lines.push('SW-Status:     ✓ aktiv (' + state + ')');
        lines.push('SW-Scope:      ' + reg.scope);
      } else {
        lines.push('SW-Status:     ✗ NICHT registriert');
      }
    } catch (e) {
      lines.push('SW-Status:     ✗ Fehler: ' + (e.message || e));
    }
  }
  if (lastSWError) {
    lines.push('');
    lines.push('Letzter SW-Fehler:');
    lines.push('  ' + lastSWError);
  }
  el.textContent = lines.join('\n');
}

function pushSupportInfo() {
  const ua = navigator.userAgent || '';
  const isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isAndroid = /Android/.test(ua);
  const isStandalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches)
                    || window.navigator.standalone === true;
  const hasSW = 'serviceWorker' in navigator;
  const hasPM = 'PushManager' in window;
  const hasNotif = 'Notification' in window;
  const fullySupported = hasSW && hasPM && hasNotif;
  return { isIOS, isAndroid, isStandalone, hasSW, hasPM, hasNotif, fullySupported };
}

function pushSupported() {
  return pushSupportInfo().fullySupported;
}

async function refreshPushStatus() {
  const status = document.getElementById('pushStatus');
  const cb = document.getElementById('pushToggle');
  if (!status || !cb) return;

  const info = pushSupportInfo();
  status.style.color = '';

  // iOS-Sonderfall: Notification + PushManager existieren NUR in der
  // installierten PWA (Home-Screen). Im Safari-Tab fehlen die APIs komplett.
  if (info.isIOS && !info.isStandalone) {
    status.style.color = 'var(--text)';
    status.innerHTML =
      '📱 <strong>iOS:</strong> Push funktioniert nur in der installierten PWA.<br>' +
      '<strong>So gehts:</strong><br>' +
      '1. Diese Seite in <strong>Safari</strong> öffnen<br>' +
      '2. Teilen-Symbol <span style="font-size:14px;">⬆︎</span> antippen<br>' +
      '3. „<em>Zum Home-Bildschirm</em>" wählen<br>' +
      '4. Tocco-Mate-Icon vom Home-Screen öffnen<br>' +
      '5. Hier zurück zu Settings → Push aktivieren';
    cb.disabled = true;
    return;
  }

  if (!info.fullySupported) {
    const missing = [
      !info.hasSW ? 'ServiceWorker' : null,
      !info.hasPM ? 'PushManager' : null,
      !info.hasNotif ? 'Notification' : null
    ].filter(Boolean).join(', ');
    status.style.color = 'var(--danger)';
    status.textContent = '⚠️ Dieser Browser unterstützt kein Web-Push (fehlt: ' + missing + ').';
    cb.disabled = true;
    return;
  }

  if (!window.isSecureContext && location.hostname !== 'localhost') {
    status.style.color = 'var(--danger)';
    status.textContent = '⚠️ Push benötigt HTTPS.';
    cb.disabled = true;
    return;
  }

  const perm = Notification.permission;
  let isSubscribed = false;
  try {
    const reg = await navigator.serviceWorker.getRegistration('/mobile/');
    if (reg) {
      const sub = await reg.pushManager.getSubscription();
      isSubscribed = !!sub;
    }
  } catch (_) {}

  cb.checked = isSubscribed && perm === 'granted';
  if (perm === 'denied') {
    status.style.color = 'var(--danger)';
    status.textContent = '🚫 Push wurde im Browser abgelehnt — bitte in den Browser-Einstellungen freigeben.';
    cb.disabled = true;
  } else if (isSubscribed) {
    status.style.color = 'var(--success)';
    status.textContent = '✅ Push aktiviert für dieses Gerät.';
    cb.disabled = false;
  } else {
    status.style.color = 'var(--text-mute)';
    status.textContent = 'Push noch nicht eingerichtet.';
    cb.disabled = false;
  }
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const out = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) out[i] = rawData.charCodeAt(i);
  return out;
}

async function enablePush() {
  if (!pushSupported()) { toast('Browser unterstützt kein Push', 'err'); return false; }

  const perm = await Notification.requestPermission();
  if (perm !== 'granted') {
    toast('Push wurde abgelehnt', 'err');
    return false;
  }

  let reg = await navigator.serviceWorker.getRegistration('/mobile/');
  if (!reg) {
    try {
      reg = await navigator.serviceWorker.register('/mobile/sw.js', { scope: '/mobile/' });
    } catch (e) {
      toast('Service-Worker-Registrierung fehlgeschlagen', 'err');
      return false;
    }
  }
  await navigator.serviceWorker.ready;

  let { publicKey } = await apiFetch('/api/push/vapid-key');
  if (!publicKey) { toast('VAPID-Key fehlt', 'err'); return false; }

  let sub;
  try {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey)
    });
  } catch (e) {
    const msg = (e && e.message) ? e.message : String(e);
    // Brave deaktiviert per Default die FCM-Anbindung — typischer Fehler:
    // "Registration failed - push service error" oder "AbortError"
    const isBrave = (navigator.brave && typeof navigator.brave.isBrave === 'function')
                 || /push service error|Registration failed/i.test(msg);
    if (isBrave) {
      const status = document.getElementById('pushStatus');
      if (status) {
        status.style.color = 'var(--danger)';
        status.innerHTML = '🚫 Push-Subscribe fehlgeschlagen.<br>' +
          '<strong>Brave-Browser:</strong> öffne <code>brave://settings/privacy</code>, ' +
          'aktiviere „<em>Google-Dienste für Push-Nachrichten verwenden</em>", ' +
          'starte Brave neu und versuche es erneut. ' +
          'Alternativ Chrome / Edge / Firefox / Safari verwenden.';
      }
      toast('Push in Brave deaktiviert — siehe Hinweis oben', 'err');
    } else {
      toast('Push-Subscribe fehlgeschlagen: ' + msg, 'err');
    }
    return false;
  }

  try {
    await apiFetch('/api/push/subscribe', { method: 'POST', body: { subscription: sub.toJSON() } });
    toast('Push aktiviert');
    return true;
  } catch (e) {
    if (!e.silent) toast(e.message || 'Server-Subscribe fehlgeschlagen', 'err');
    try { await sub.unsubscribe(); } catch (_) {}
    return false;
  }
}

async function disablePush() {
  try {
    const reg = await navigator.serviceWorker.getRegistration('/mobile/');
    if (!reg) return;
    const sub = await reg.pushManager.getSubscription();
    if (!sub) return;
    const endpoint = sub.endpoint;
    await sub.unsubscribe();
    try {
      await apiFetch('/api/push/subscribe', { method: 'DELETE', body: { endpoint } });
    } catch (_) {}
    toast('Push deaktiviert');
  } catch (e) {
    toast('Deaktivieren fehlgeschlagen', 'err');
  }
}

function fsetTelegram(s) {
  const fs = makeFieldset('Telegram-Bot');
  fs.append(toggle('telegramEnabled', 'Bot aktivieren', s && s.telegramEnabled));
  fs.append(field('Bot-Token', input('telegramToken', 'password', '', '••• (unverändert)'),
                  'Von @BotFather. Leer lassen, um den gespeicherten Token zu behalten.'));
  const uid = input('telegramAllowedUserId', 'number', s && s.telegramAllowedUserId);
  uid.min = '1';
  fs.append(field('Deine User-ID', uid, 'Hol dir die ID via @userinfobot.'));
  return fs;
}

function fsetUrls(s) {
  const fs = makeFieldset('Erweitert — URLs (env-only, read-only)');
  const baseUrl = input('baseUrl', 'url', s && s.baseUrl); baseUrl.disabled = true;
  const notenUrl = input('notenUrl', 'url', s && s.notenUrl); notenUrl.disabled = true;
  const splUrl = input('stundenplanUrl', 'url', s && s.stundenplanUrl); splUrl.disabled = true;
  fs.append(
    field('Base-URL', baseUrl),
    field('Noten-URL', notenUrl),
    field('Stundenplan-URL', splUrl)
  );
  return fs;
}

function fsetToken() {
  const fs = makeFieldset('API-Token');
  const inp = document.createElement('input');
  inp.type = 'password';
  inp.id = 'currentToken';
  inp.autocomplete = 'off';
  inp.value = getToken();
  fs.append(field('Aktueller Token (lokal)', inp,
                  'Wird nur in diesem Browser gespeichert.'));

  const saveBtn = document.createElement('button');
  saveBtn.type = 'button'; saveBtn.className = 'm-btn m-btn--block';
  saveBtn.textContent = 'Token aktualisieren';
  saveBtn.addEventListener('click', () => {
    const v = inp.value.trim();
    if (!v) { toast('Token darf nicht leer sein', 'err'); return; }
    setToken(v);
    toast('Token gespeichert');
  });

  const logoutBtn = document.createElement('button');
  logoutBtn.type = 'button'; logoutBtn.className = 'm-btn m-btn--block m-btn--danger';
  logoutBtn.textContent = 'Abmelden';
  logoutBtn.addEventListener('click', () => {
    clearToken();
    showLogin('Abgemeldet — Token erneut eingeben');
  });

  fs.append(saveBtn, logoutBtn);
  return fs;
}

function collectSettingsPayload(form) {
  const fd = new FormData(form);
  const out = {};
  // Strings (only send if non-empty / explicitly changed)
  const email = (fd.get('msEmail') || '').toString().trim();
  if (email) out.msEmail = email;
  const userPk = (fd.get('userPk') || '').toString().trim();
  if (userPk) out.userPk = userPk;
  const pw = (fd.get('msPassword') || '').toString();
  if (pw) out.msPassword = pw;

  // Toggles
  out.autoRun  = !!form.querySelector('[name="autoRun"]').checked;
  out.headless = !!form.querySelector('[name="headless"]').checked;

  // Schedule
  out.scheduleMode = settingsState.scheduleMode;
  out.scheduleDays = settingsState.scheduleDays.slice();
  out.scheduleTimes = settingsState.scheduleTimes.slice();
  const iv = parseInt(fd.get('intervalMinutes'), 10);
  if (Number.isFinite(iv) && iv > 0) out.intervalMinutes = iv;
  const tFrom = (fd.get('intervalTimeFrom') || '').toString();
  const tTo   = (fd.get('intervalTimeTo')   || '').toString();
  if (tFrom) out.intervalTimeFrom = tFrom;
  if (tTo)   out.intervalTimeTo   = tTo;

  // Browser slowMo
  const sm = parseInt(fd.get('slowMo'), 10);
  if (Number.isFinite(sm) && sm >= 0) out.slowMo = sm;

  // Telegram
  out.telegramEnabled = !!form.querySelector('[name="telegramEnabled"]').checked;
  const tToken = (fd.get('telegramToken') || '').toString();
  if (tToken) out.telegramToken = tToken;
  const tUid = parseInt(fd.get('telegramAllowedUserId'), 10);
  if (Number.isFinite(tUid) && tUid > 0) out.telegramAllowedUserId = tUid;

  return out;
}

/* ---- Settings UI helpers ---- */
function makeFieldset(legend) {
  const fs = document.createElement('fieldset');
  fs.className = 'm-fieldset';
  const lg = document.createElement('legend');
  lg.textContent = legend;
  fs.append(lg);
  return fs;
}
function field(labelText, control, hint) {
  const wrap = document.createElement('label');
  wrap.className = 'm-field';
  const lab = document.createElement('span');
  lab.textContent = labelText;
  wrap.append(lab, control);
  if (hint) {
    const h = document.createElement('small');
    h.className = 'm-field__hint';
    h.textContent = hint;
    wrap.append(h);
  }
  return wrap;
}
function input(name, type, value, placeholder) {
  const el = document.createElement('input');
  el.name = name;
  el.type = type;
  if (value != null && value !== '') el.value = String(value);
  if (placeholder) el.placeholder = placeholder;
  if (type === 'password') el.autocomplete = 'new-password';
  return el;
}
function toggle(name, labelText, checked) {
  const wrap = document.createElement('label');
  wrap.className = 'm-toggle';
  const span = document.createElement('span');
  span.className = 'm-toggle__label';
  span.textContent = labelText;
  const cb = document.createElement('input');
  cb.type = 'checkbox'; cb.name = name; cb.hidden = true;
  if (checked) cb.checked = true;
  const sw = document.createElement('span');
  sw.className = 'm-switch';
  wrap.append(span, cb, sw);
  return wrap;
}

/* ============================================================
   Hash-router
   ============================================================ */
const routes = {
  '/noten':       { title: 'Noten',         render: renderNoten,       tab: 'noten',       hasBack: false },
  '/stundenplan': { title: 'Stundenplan',   render: renderStundenplan, tab: 'stundenplan', hasBack: false },
  '/settings':    { title: 'Einstellungen', render: renderSettings,    tab: 'settings',    hasBack: false }
};

function parseHash() {
  const h = window.location.hash || '#/noten';
  const raw = h.slice(1);
  const [pathPart, queryPart] = raw.split('?');
  const params = new URLSearchParams(queryPart || '');
  return { path: pathPart || '/noten', params };
}

async function route() {
  if (!getToken()) { showLogin(); return; }
  const { path, params } = parseHash();

  // Dynamic /modul/:id route
  const modulMatch = path.match(/^\/modul\/(.+)$/);
  if (modulMatch) {
    const id = decodeURIComponent(modulMatch[1]);
    const codeHint = params.get('code') || null;
    setBackButton(true);
    setActiveTab(null);
    appbarLogo.hidden = true;
    refreshBtn.hidden = true;
    await renderModul(id, codeHint);
    return;
  }

  const r = routes[path];
  if (!r) { window.location.hash = '#/noten'; return; }

  setBackButton(false);
  setActiveTab(r.tab);
  appbarLogo.hidden = false;
  refreshBtn.hidden = false;
  await r.render();
}

function setActiveTab(tab) {
  bottomNav.querySelectorAll('.m-tab').forEach((el) => {
    if (tab && el.dataset.route === tab) el.setAttribute('aria-current', 'page');
    else el.removeAttribute('aria-current');
  });
}
function setBackButton(visible) {
  backBtn.hidden = !visible;
}

/* ============================================================
   Scrape-Card (Settings) — Status, Phase-Steps, Button, Progress.
   ============================================================ */
function renderScrapeCard(container) {
  if (!container) return;
  container.replaceChildren();

  const status = scrapeState.status || {};
  const running = !!status.running;
  const phase = status.currentPhase || (running ? 'starting' : null);
  const hasError = !running && !!status.lastError;

  const card = document.createElement('div');
  card.className = 'm-scrape';

  // Top row: pill + last-run
  const top = document.createElement('div');
  top.className = 'm-scrape__top';
  const pill = document.createElement('span');
  pill.className = 'm-scrape__pill ' +
    (running ? 'm-scrape__pill--running' :
     hasError ? 'm-scrape__pill--error' : 'm-scrape__pill--idle');
  const dot = document.createElement('span');
  dot.className = 'm-scrape__dot';
  const lab = document.createElement('span');
  lab.textContent = running
    ? (PHASE_PILL_LABELS[phase] || 'läuft…')
    : (hasError ? 'Fehler' : 'bereit');
  pill.append(dot, lab);

  const lastRun = document.createElement('div');
  lastRun.className = 'm-scrape__lastrun';
  lastRun.textContent = status.lastRun
    ? 'Letzter Lauf ' + fmtRelative(status.lastRun)
    : 'noch kein Lauf';
  if (status.lastRun) lastRun.title = new Date(status.lastRun).toLocaleString('de-CH');

  top.append(pill, lastRun);
  card.append(top);

  // Button — primary CTA
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'm-scrape__btn';
  btn.disabled = running;
  if (running) {
    const sp = document.createElement('span');
    sp.className = 'm-spinner-sm';
    btn.append(sp);
    const t = document.createElement('span');
    t.textContent = 'Scrape läuft…';
    btn.append(t);
  } else {
    const ic = document.createElement('span');
    ic.setAttribute('aria-hidden', 'true');
    ic.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polygon points="6 4 20 12 6 20 6 4"/></svg>';
    btn.append(ic);
    const t = document.createElement('span');
    t.textContent = 'Jetzt scrapen';
    btn.append(t);
  }
  btn.addEventListener('click', triggerScrape);
  card.append(btn);

  // Progress (only while running)
  if (running) {
    const steps = document.createElement('div');
    steps.className = 'm-scrape__steps';
    const activeIndex = phase ? PHASE_ORDER.indexOf(phase) : -1;
    PHASE_ORDER.forEach((p, i) => {
      const step = document.createElement('div');
      step.className = 'm-scrape__step';
      if (activeIndex >= 0) {
        if (i < activeIndex) step.classList.add('is-done');
        else if (i === activeIndex) step.classList.add('is-active');
      }
      const sd = document.createElement('div');
      sd.className = 'm-scrape__step-dot';
      const sl = document.createElement('div');
      sl.textContent = PHASE_SHORT_LABELS[i];
      step.append(sd, sl);
      steps.append(step);
    });
    card.append(steps);

    const bar = document.createElement('div');
    bar.className = 'm-scrape__bar';
    const fill = document.createElement('div');
    fill.className = 'm-scrape__bar-fill';
    const total = PHASE_ORDER.length;
    const pct = activeIndex < 0
      ? 5
      : Math.min(100, Math.round(((activeIndex + 0.5) / total) * 100));
    fill.style.width = pct + '%';
    bar.append(fill);
    card.append(bar);

    const caption = document.createElement('div');
    caption.className = 'm-scrape__caption';
    const lab2 = document.createElement('span');
    lab2.textContent = PHASE_LABELS[phase] || 'Läuft…';
    const timer = document.createElement('span');
    timer.id = 'scrapeTimer';
    timer.textContent = formatElapsed(status.phaseStartedAt);
    caption.append(lab2, timer);
    card.append(caption);
  }

  // Error banner (last run failed)
  if (hasError) {
    const err = document.createElement('div');
    err.className = 'm-scrape__error';
    err.textContent = String(status.lastError).slice(0, 200);
    card.append(err);
  }

  container.append(card);

  // Live timer when running
  if (running && status.phaseStartedAt && !scrapeTimerHandle) {
    scrapeTimerHandle = setInterval(() => {
      const t = document.getElementById('scrapeTimer');
      if (!t) return;
      const live = scrapeState.status && scrapeState.status.phaseStartedAt;
      t.textContent = formatElapsed(live || status.phaseStartedAt);
    }, 1000);
  } else if (!running && scrapeTimerHandle) {
    clearInterval(scrapeTimerHandle);
    scrapeTimerHandle = null;
  }
}

function reRenderScrapeCardIfMounted() {
  const el = document.getElementById('scrapeCard');
  if (el) renderScrapeCard(el);
}

function fmtRelative(iso) {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '–';
  const diff = Math.max(0, Date.now() - t);
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return 'gerade eben';
  const min = Math.floor(sec / 60);
  if (min < 60) return 'vor ' + min + ' Min';
  const hr = Math.floor(min / 60);
  if (hr < 24) return 'vor ' + hr + ' Std';
  const d = Math.floor(hr / 24);
  return 'vor ' + d + ' Tag' + (d > 1 ? 'en' : '');
}
function formatElapsed(iso) {
  if (!iso) return '0:00';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '0:00';
  const sec = Math.max(0, Math.floor((Date.now() - t) / 1000));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m + ':' + String(s).padStart(2, '0');
}

async function triggerScrape() {
  // Optimistisches Update — Pill schaltet sofort, der nächste Status-Event
  // (SSE oder die /api/scrape-Response) korrigiert ggf.
  scrapeState.status = Object.assign({}, scrapeState.status, {
    running: true, currentPhase: 'starting', phaseStartedAt: new Date().toISOString()
  });
  reRenderScrapeCardIfMounted();
  try {
    const r = await apiFetch('/api/scrape', { method: 'POST', body: {} });
    if (r && r.triggered === false) {
      // 200 mit reason → server hat NICHT gestartet, optimistisches Update zurückrollen
      if (r.reason === 'already_running') {
        toast('Scrape läuft bereits');
      } else if (r.reason === 'cooldown') {
        toast('Cooldown aktiv — bitte ' + (r.retryInSec || 60) + 's warten', 'err');
        scrapeState.status = Object.assign({}, scrapeState.status, { running: false });
        reRenderScrapeCardIfMounted();
      } else {
        toast('Scrape nicht gestartet (' + (r.reason || 'unbekannt') + ')', 'err');
        scrapeState.status = Object.assign({}, scrapeState.status, { running: false });
        reRenderScrapeCardIfMounted();
      }
      // Echten Status nachladen damit UI mit Server synchron ist
      fetchInitialStatus();
      return;
    }
    toast('Scrape gestartet');
  } catch (e) {
    if (e.silent) return;
    // 429 cooldown response landet hier (apiFetch wirft bei 429)
    scrapeState.status = Object.assign({}, scrapeState.status, {
      running: false
    });
    reRenderScrapeCardIfMounted();
    toast(e.message || 'Scrape-Start fehlgeschlagen', 'err');
  }
}

/* ============================================================
   SSE — Server-Sent Events für Live-Status. Pattern wie Dashboard.
   Reconnect mit exponentiellem Backoff. Token kommt via Query-String,
   weil EventSource keine Custom-Headers setzen kann.
   ============================================================ */
function connectSSE() {
  const token = getToken();
  if (!token) return;
  try {
    sse = new EventSource('/api/events?token=' + encodeURIComponent(token));
  } catch (_) {
    return;
  }
  sseEverOpened = false;

  sse.onopen = () => {
    sseReconnectDelay = 1000;
    sseEverOpened = true;
  };
  sse.onerror = () => {
    const wasClosed = sse && sse.readyState === 2;
    try { if (sse) sse.close(); } catch (_) {}
    sse = null;
    // Wenn der erste Connect schon scheitert: nicht ewig spammen
    if (!sseEverOpened && wasClosed) return;
    setTimeout(connectSSE, sseReconnectDelay);
    sseReconnectDelay = Math.min(sseReconnectDelay * 2, 15000);
  };
  sse.onmessage = (evt) => handleSseEvent(evt.data);
  ['status', 'log', 'progress'].forEach((name) => {
    sse.addEventListener(name, (evt) => handleSseEvent(evt.data, name));
  });
}

function handleSseEvent(raw, typeHint) {
  let payload;
  try { payload = JSON.parse(raw); } catch (_) { return; }
  if (typeHint === 'log') return;     // Logs interessieren uns mobile nicht
  if (typeHint === 'progress' || typeHint === 'status' || (typeHint == null && payload && (payload.running != null || payload.currentPhase != null))) {
    updateStatus(payload);
  }
}

function updateStatus(status) {
  const wasRunning = scrapeState.scraping;
  scrapeState.status = status;
  scrapeState.scraping = !!status.running;
  reRenderScrapeCardIfMounted();
  // Wenn ein Scrape gerade beendet wurde und wir die Noten/Stundenplan-View
  // gerade offen haben → einmal frisch laden.
  if (wasRunning && !status.running && !status.lastError) {
    const { path } = parseHash();
    if (path === '/noten') renderNoten();
    else if (path === '/stundenplan') renderStundenplan();
  }
}

async function fetchInitialStatus() {
  try {
    const status = await apiFetch('/api/status');
    if (status) updateStatus(status);
  } catch (_) { /* Best-effort beim Boot */ }
}

/* ============================================================
   Service-Worker registration
   ============================================================ */
// Last SW-registration error (surfaced in Settings → Diagnose).
let lastSWError = null;

/* ============================================================
   Scrape state — gespeist aus /api/status (initial) + SSE 'status'
   Events. Wird in den Settings als Card gerendert.
   ============================================================ */
const PHASE_ORDER = ['browser', 'login', 'noten', 'stundenplan', 'saving', 'noten_details'];
const PHASE_LABELS = {
  starting:      'Initialisiere…',
  browser:       'Browser starten…',
  login:         'Anmelden…',
  noten:         'Noten laden…',
  stundenplan:   'Stundenplan laden…',
  saving:        'Speichern…',
  noten_details: 'Modul-Details…'
};
const PHASE_PILL_LABELS = {
  starting:      'startet…',
  browser:       'Browser…',
  login:         'Login…',
  noten:         'Noten…',
  stundenplan:   'Stundenplan…',
  saving:        'Speichern…',
  noten_details: 'Details…'
};
const PHASE_SHORT_LABELS = ['Browser', 'Login', 'Noten', 'Plan', 'Speich.', 'Details'];

const scrapeState = {
  status: null,            // letzter Snapshot von /api/status
  scraping: false,
  lastSeenRunId: null      // damit wir nach Scrape-Ende einmal Daten reloaden
};
let scrapeTimerHandle = null;

let sse = null;
let sseReconnectDelay = 1000;
let sseEverOpened = false;

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) {
    lastSWError = 'serviceWorker API fehlt im navigator';
    return null;
  }
  try {
    // Scope = "/mobile/" — explicit so SW only intercepts /mobile/* requests.
    const reg = await navigator.serviceWorker.register('/mobile/sw.js', { scope: '/mobile/' });
    lastSWError = null;
    return reg;
  } catch (e) {
    lastSWError = (e && e.message) ? e.message : String(e);
    console.warn('SW registration failed:', e);
    return null;
  }
}

/* ============================================================
   Boot
   ============================================================ */
backBtn.addEventListener('click', () => {
  if (window.history.length > 1) window.history.back();
  else window.location.hash = '#/noten';
});
refreshBtn.addEventListener('click', route);

bottomNav.addEventListener('click', (ev) => {
  const a = ev.target.closest('.m-tab');
  if (!a) return;
  // Let the browser handle the hash change; route() runs on hashchange.
});

window.addEventListener('hashchange', route);

loginForm.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const t = loginToken.value.trim();
  if (!t) { loginStatus.textContent = 'Bitte Token eingeben.'; return; }
  setToken(t);
  // Probe with /api/settings — cheap + auth-required.
  try {
    await apiFetch('/api/settings');
    hideLogin();
    if (!window.location.hash) window.location.hash = '#/noten';
    else route();
    // Nach erfolgreichem Login: Live-Status + SSE starten
    fetchInitialStatus();
    connectSSE();
  } catch (e) {
    clearToken();
    if (!e.silent) loginStatus.textContent = e.message || 'Login fehlgeschlagen';
  }
});

(function boot() {
  registerServiceWorker();
  if (!getToken()) { showLogin(); return; }
  if (!window.location.hash) window.location.hash = '#/noten';
  else route();
  // Initial-Status + SSE für Live-Updates der Scrape-Card
  fetchInitialStatus();
  connectSSE();
})();
