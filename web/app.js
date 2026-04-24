/* ============================================================
   Tocco Mate - vanilla JS UI
   ============================================================ */

'use strict';

// ---------- tiny DOM helpers ----------
const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const h  = (tag, attrs = {}, ...children) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else if (v === false || v == null) { /* skip */ }
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
};

// ---------- app state ----------
const STORAGE_ACTIVE_TAB = 'tocco.activeTab';
const STORAGE_TOKEN      = 'tocco.authToken';

// ---------- auth token helpers ----------
function getToken()   { try { return localStorage.getItem(STORAGE_TOKEN) || ''; } catch (_) { return ''; } }
function setToken(v)  { try { localStorage.setItem(STORAGE_TOKEN, v); } catch (_) {} }
function clearToken() { try { localStorage.removeItem(STORAGE_TOKEN); } catch (_) {} }

function authHeaders() {
  const t = getToken();
  return t ? { Authorization: 'Bearer ' + t } : {};
}

const state = {
  status: null,
  noten: null,
  stundenplan: null,
  settings: null,
  notenFilter: 'all',
  notenSearch: '',
  notenSort: { key: 'fach_name', dir: 'asc' },
  scraping: false,
  logSeen: 0,
};

// ---------- API layer ----------
const api = {
  get:   (url)       => fetch(url, { credentials: 'same-origin', headers: authHeaders() }).then(assertOk),
  patch: (url, body) => fetch(url, {
    method: 'PATCH', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body),
  }).then(assertOk),
  post:  (url, body) => fetch(url, {
    method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: body ? JSON.stringify(body) : undefined,
  }).then(assertOk),
};

const UNAUTHORIZED = Symbol('Unauthorized');

async function assertOk(res) {
  if (res.status === 401) {
    try { if (sse) sse.close(); } catch (_) {}
    showLogin('Token ungültig - bitte neu anmelden');
    const err = new Error('Unauthorized');
    err.silent = true;
    err.code = UNAUTHORIZED;
    throw err;
  }
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const t = await res.text();
      if (t) msg += ` - ${t.slice(0, 240)}`;
    } catch (_) {}
    throw new Error(msg);
  }
  const ct = res.headers.get('content-type') || '';
  return ct.includes('application/json') ? res.json() : res.text();
}

// ---------- formatting helpers ----------
const WEEKDAYS_DE = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];
const MONTHS_DE   = ['Januar','Februar','März','April','Mai','Juni','Juli','August','September','Oktober','November','Dezember'];

function fmtDateHeading(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  return `${WEEKDAYS_DE[d.getDay()]}, ${d.getDate()}. ${MONTHS_DE[d.getMonth()]} ${d.getFullYear()}`;
}

function fmtDateDdMmYyyy(iso) {
  // "2026-04-24" → "24.04.2026"
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '');
  return m ? `${m[3]}.${m[2]}.${m[1]}` : (iso || '');
}

function extractModulNummer(r) {
  // Letztes Segment des kuerzel_code nach "-"
  // "UIFZ-2524-020-S1-106"      → "106"
  // "UIFZ-2524-020-S2-ENG-N3"   → "ENG-N3"   (Sprachniveau → mit Fach-Präfix)
  // "UIFZ-2524-020-S1-MAT"      → "MAT"
  if (!r.kuerzel_code) return null;
  const parts = String(r.kuerzel_code).split('-');
  if (!parts.length) return null;
  const last = parts[parts.length - 1];
  if (/^N\d+$/i.test(last) && parts.length >= 2) {
    return parts[parts.length - 2] + '-' + last;
  }
  return last;
}

function fmtRelative(tsIso) {
  if (!tsIso) return '-';
  const t = new Date(tsIso).getTime();
  if (isNaN(t)) return '-';
  const diff = Date.now() - t;
  const s = Math.floor(diff / 1000);
  if (s < 0) {
    const abs = Math.abs(s);
    if (abs < 60)    return `in ${abs} s`;
    if (abs < 3600)  return `in ${Math.floor(abs/60)} Min.`;
    if (abs < 86400) return `in ${Math.floor(abs/3600)} Std.`;
    return `in ${Math.floor(abs/86400)} Tg.`;
  }
  if (s < 30)     return 'gerade eben';
  if (s < 60)     return `vor ${s} s`;
  if (s < 3600)   return `vor ${Math.floor(s/60)} Min.`;
  if (s < 86400)  return `vor ${Math.floor(s/3600)} Std.`;
  return `vor ${Math.floor(s/86400)} Tg.`;
}

function fmtTime(t) {
  if (!t) return '';
  const m = /^(\d{1,2}):(\d{2})/.exec(t);
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : t;
}

function fmtGrade(note) {
  if (note == null || note === '') return '-';
  const n = Number(note);
  if (!isFinite(n)) return String(note);
  return n.toFixed(2);
}

function gradeClass(note) {
  const n = Number(note);
  if (!isFinite(n) || note == null || note === '') return 'g-none';
  if (n >= 5.5) return 'g-excellent';
  if (n >= 4.5) return 'g-good';
  if (n >= 4)   return 'g-ok';
  return 'g-fail';
}

// ---------- tabs ----------
function setActiveTab(name, opts) {
  const persist = opts ? opts.persist !== false : true;
  const valid = ['noten', 'stundenplan', 'einstellungen'];
  if (!valid.includes(name)) name = 'noten';
  $$('.tab').forEach(btn => btn.setAttribute('aria-selected', btn.dataset.tab === name ? 'true' : 'false'));
  $$('.panel').forEach(p => { p.hidden = p.id !== `panel-${name}`; });
  if (persist) try { localStorage.setItem(STORAGE_ACTIVE_TAB, name); } catch (_) {}
}

function initTabs() {
  $$('.tab').forEach(btn => btn.addEventListener('click', () => setActiveTab(btn.dataset.tab)));
  let saved = 'noten';
  try { saved = localStorage.getItem(STORAGE_ACTIVE_TAB) || 'noten'; } catch (_) {}
  setActiveTab(saved, { persist: false });
}

// ---------- status pill ----------
const PHASE_ORDER = ['browser', 'login', 'noten', 'stundenplan', 'saving'];
const PHASE_LABELS = {
  starting:    'Initialisiere…',
  browser:     'Browser starten…',
  login:       'Anmelden…',
  noten:       'Noten laden…',
  stundenplan: 'Stundenplan laden…',
  saving:      'Speichern…'
};
const PHASE_PILL_LABELS = {
  starting:    'startet…',
  browser:     'Browser…',
  login:       'Login…',
  noten:       'Noten…',
  stundenplan: 'Stundenplan…',
  saving:      'Speichern…'
};

let progressTimerHandle = null;

function renderStatus(status) {
  state.status = status;
  const pill = $('#statusPill');
  const label = pill.querySelector('.pill__label');
  const lastRun = $('#lastRunLabel');
  const btn = $('#scrapeBtn');

  pill.classList.remove('pill--idle', 'pill--running', 'pill--error');

  if (status && status.running) {
    pill.classList.add('pill--running');
    label.textContent = PHASE_PILL_LABELS[status.currentPhase] || 'läuft…';
    btn.classList.add('is-loading');
    btn.disabled = true;
    state.scraping = true;
    showProgress(status);
  } else if (status && status.lastError) {
    pill.classList.add('pill--error');
    label.textContent = 'Fehler';
    btn.classList.remove('is-loading');
    btn.disabled = false;
    state.scraping = false;
    hideProgress();
  } else {
    pill.classList.add('pill--idle');
    label.textContent = 'bereit';
    btn.classList.remove('is-loading');
    btn.disabled = false;
    state.scraping = false;
    hideProgress();
  }

  if (status && status.lastRun) {
    lastRun.textContent = `Letzter Lauf ${fmtRelative(status.lastRun)}`;
    lastRun.title = new Date(status.lastRun).toLocaleString('de-CH');
  } else {
    lastRun.textContent = 'noch kein Lauf';
    lastRun.title = '';
  }
}

function showProgress(status) {
  const bar = $('#progressBar');
  if (!bar) return;
  bar.hidden = false;

  const phase = status.currentPhase || 'starting';
  const caption = $('#progressPhaseLabel');
  if (caption) caption.textContent = PHASE_LABELS[phase] || 'Läuft…';

  // Schritte markieren
  const activeIndex = PHASE_ORDER.indexOf(phase);
  const steps = document.querySelectorAll('.progress__step');
  steps.forEach((step, i) => {
    step.classList.remove('is-active', 'is-done');
    if (activeIndex < 0) return;
    if (i < activeIndex) step.classList.add('is-done');
    else if (i === activeIndex) step.classList.add('is-active');
  });

  // Fortschritts-Bar
  const fill = $('#progressFill');
  if (fill) {
    const total = PHASE_ORDER.length;
    // activeIndex = -1 (starting) → 5%, sonst (idx+0.5) / total
    const pct = activeIndex < 0
      ? 5
      : Math.min(100, Math.round(((activeIndex + 0.5) / total) * 100));
    fill.style.width = pct + '%';
  }

  // Timer startet (oder läuft weiter)
  if (!progressTimerHandle && status.phaseStartedAt) {
    startProgressTimer(status.phaseStartedAt);
  } else if (status.phaseStartedAt) {
    updateProgressTimer(status.phaseStartedAt);
  }
}

function hideProgress() {
  const bar = $('#progressBar');
  if (bar) bar.hidden = true;
  if (progressTimerHandle) {
    clearInterval(progressTimerHandle);
    progressTimerHandle = null;
  }
  const timer = $('#progressTimer');
  if (timer) timer.textContent = '0:00';
  const fill = $('#progressFill');
  if (fill) fill.style.width = '0%';
}

function startProgressTimer(isoStart) {
  updateProgressTimer(isoStart);
  progressTimerHandle = setInterval(() => {
    const current = state.status && state.status.phaseStartedAt;
    if (current) updateProgressTimer(current);
  }, 1000);
}

function updateProgressTimer(isoStart) {
  const el = $('#progressTimer');
  if (!el) return;
  const ms = Date.now() - new Date(isoStart).getTime();
  if (!isFinite(ms) || ms < 0) { el.textContent = '0:00'; return; }
  const s = Math.floor(ms / 1000);
  const mm = Math.floor(s / 60);
  const ss = s % 60;
  el.textContent = `${mm}:${String(ss).padStart(2, '0')}`;
}

// ---------- Noten tab ----------
function renderAverages(noten) {
  const grid = $('#avgGrid');
  grid.innerHTML = '';
  if (!noten) return;

  const total = noten.count != null ? noten.count : (noten.rows ? noten.rows.length : 0);
  const graded = (noten.rows || []).filter(r => r.note != null && r.note !== '').length;
  const avg = noten.avg;
  const s1 = noten.bySemester ? noten.bySemester.S1 : null;
  const s2 = noten.bySemester ? noten.bySemester.S2 : null;

  grid.append(
    buildAvgCard({
      label: 'Ø aller Noten',
      value: avg,
      meta: `${graded} von ${total} Modulen benotet`,
      hero: true,
      badge: 'Gesamt',
    }),
    buildAvgCard({ label: 'Semester 1', value: s1, meta: countFor(noten, 'S1'), badge: 'S1' }),
    buildAvgCard({ label: 'Semester 2', value: s2, meta: countFor(noten, 'S2'), badge: 'S2' }),
  );
}

function countFor(noten, sem) {
  const rows = (noten.rows || []).filter(r => r.semester === sem);
  const graded = rows.filter(r => r.note != null && r.note !== '').length;
  return `${graded} von ${rows.length} Modulen`;
}

function buildAvgCard(opts) {
  const { label, value, meta, hero, badge } = opts;
  const hasValue = value != null && isFinite(Number(value));
  const cls = hasValue ? gradeClass(value) : 'g-none';
  return h('div', { class: `avg-card ${hero ? 'avg-card--hero' : ''} ${cls}` },
    h('div', { class: 'avg-card__badge' }, badge || ''),
    h('div', { class: 'avg-card__label' }, label),
    h('div', { class: `avg-card__value ${hasValue ? '' : 'avg-card__value--empty'}` }, hasValue ? Number(value).toFixed(2) : '-'),
    h('div', { class: 'avg-card__meta' }, meta || ''),
  );
}

function renderNotenTable() {
  const tbody = $('#notenBody');
  const sub = $('#notenSubtitle');
  const data = state.noten;

  if (!data) {
    tbody.innerHTML = '';
    tbody.append(h('tr', {}, h('td', { colspan: 4, class: 'tbl__empty' }, 'Lade Daten...')));
    return;
  }

  const rows = filterAndSort(data.rows || []);
  const total = data.count != null ? data.count : (data.rows ? data.rows.length : 0);
  sub.textContent = `${rows.length} angezeigt - insgesamt ${total}`;

  tbody.innerHTML = '';
  if (!rows.length) {
    tbody.append(h('tr', {}, h('td', { colspan: 4, class: 'tbl__empty' }, 'Keine Einträge.')));
    return;
  }

  const frag = document.createDocumentFragment();
  for (const r of rows) {
    const mod = extractModulNummer(r);
    const name = r.fach_name || r.fach_code || r.kuerzel_full || '-';
    const nameChildren = mod
      ? [h('span', { class: 'modul-badge' }, mod), ' ', name]
      : [name];

    const tr = h('tr', {
      dataset: { id: r.kuerzel_id || r.id },
      onclick: () => openHistory(r),
    },
      h('td', {},
        h('div', { class: 'fach-cell' },
          h('div', { class: 'fach-cell__name' }, ...nameChildren),
        )
      ),
      h('td', {}, r.semester ? h('span', { class: `sem-badge sem-badge--${String(r.semester).toLowerCase()}` }, r.semester) : h('span', { class: 'fach-cell__code' }, '-')),
      h('td', {}, r.typ ? h('span', { class: 'typ-badge' }, r.typ) : h('span', { class: 'fach-cell__code' }, '-')),
      h('td', { class: 'tbl__right' },
        h('span', { class: `note-cell ${gradeClass(r.note)}` }, fmtGrade(r.note)),
      ),
    );
    frag.append(tr);
  }
  tbody.append(frag);
  updateSortIndicators();
}

function filterAndSort(rows) {
  const q = state.notenSearch.trim().toLowerCase();
  let out = rows.filter(r => {
    if (state.notenFilter === 'withNote' && (r.note == null || r.note === '')) return false;
    if (state.notenFilter === 'S1' && r.semester !== 'S1') return false;
    if (state.notenFilter === 'S2' && r.semester !== 'S2') return false;
    if (q) {
      const hay = `${r.fach_name || ''} ${r.fach_code || ''} ${r.kuerzel_full || ''} ${r.kuerzel_code || ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  const { key, dir } = state.notenSort;
  const mult = dir === 'desc' ? -1 : 1;
  out.sort((a, b) => {
    let av = a[key], bv = b[key];
    if (key === 'note') { av = Number(av); bv = Number(bv); }
    if (av == null || av === '' || (typeof av === 'number' && !isFinite(av))) return 1;
    if (bv == null || bv === '' || (typeof bv === 'number' && !isFinite(bv))) return -1;
    if (typeof av === 'string') av = av.toLowerCase();
    if (typeof bv === 'string') bv = bv.toLowerCase();
    if (av < bv) return -1 * mult;
    if (av > bv) return  1 * mult;
    return 0;
  });
  return out;
}

function updateSortIndicators() {
  $$('#notenTable thead th').forEach(th => {
    th.classList.remove('is-asc', 'is-desc');
    if (th.dataset.sort === state.notenSort.key) {
      th.classList.add(state.notenSort.dir === 'asc' ? 'is-asc' : 'is-desc');
    }
  });
}

function initNotenTab() {
  $$('#notenChips .chip').forEach(chip => {
    chip.addEventListener('click', () => {
      $$('#notenChips .chip').forEach(c => c.classList.remove('chip--active'));
      chip.classList.add('chip--active');
      state.notenFilter = chip.dataset.filter;
      renderNotenTable();
    });
  });
  $('#notenSearch').addEventListener('input', e => {
    state.notenSearch = e.target.value;
    renderNotenTable();
  });
  $$('#notenTable thead th[data-sort]').forEach(th => {
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      if (state.notenSort.key === key) {
        state.notenSort.dir = state.notenSort.dir === 'asc' ? 'desc' : 'asc';
      } else {
        state.notenSort.key = key;
        state.notenSort.dir = 'asc';
      }
      renderNotenTable();
    });
  });
}

// ---------- History modal ----------
async function openHistory(row) {
  const id = row.kuerzel_id || row.id;
  if (!id) return;
  const modal = $('#historyModal');
  const title = $('#historyTitle');
  const body = $('#historyBody');

  title.textContent = row.fach_name || row.kuerzel_full || 'Notenverlauf';
  body.innerHTML = '';
  body.append(h('div', { class: 'empty' }, 'Lade Verlauf...'));
  modal.hidden = false;
  modal.setAttribute('aria-hidden', 'false');

  try {
    const data = await api.get(`/api/history/${encodeURIComponent(id)}`);
    body.innerHTML = '';
    const rows = (data && data.rows) || [];
    if (!rows.length) {
      body.append(h('div', { class: 'empty' }, 'Noch keine Historie.'));
      return;
    }
    const list = h('div', { class: 'hist-list' });
    for (const r of rows) {
      list.append(
        h('div', { class: 'hist-item' },
          h('div', {},
            h('div', { class: 'hist-date' }, r.recorded_at ? new Date(r.recorded_at).toLocaleString('de-CH') : '-'),
            r.fach_name ? h('div', { class: 'fach-cell__code' }, r.fach_name) : null,
          ),
          h('div', { class: `hist-note ${gradeClass(r.note)}` }, fmtGrade(r.note)),
        )
      );
    }
    body.append(list);
  } catch (err) {
    body.innerHTML = '';
    if (err && err.silent) {
      closeHistory();
      return;
    }
    body.append(h('div', { class: 'empty' }, `Fehler: ${err.message}`));
  }
}

function initHistoryModal() {
  const modal = $('#historyModal');
  modal.addEventListener('click', e => {
    if (e.target.hasAttribute('data-modal-close')) closeHistory();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !modal.hidden) closeHistory();
  });
}
function closeHistory() {
  const modal = $('#historyModal');
  modal.hidden = true;
  modal.setAttribute('aria-hidden', 'true');
}

// ---------- Stundenplan ----------
function renderStundenplan(plan) {
  const list = $('#scheduleList');
  const sub = $('#stundenplanSubtitle');
  list.innerHTML = '';

  if (!plan) {
    list.append(h('div', { class: 'empty' }, 'Lade Stundenplan...'));
    return;
  }

  const rows = [...(plan.rows || [])].sort((a, b) => {
    const da = `${a.datum_iso || ''}T${a.zeit_von || '00:00'}`;
    const db = `${b.datum_iso || ''}T${b.zeit_von || '00:00'}`;
    return da < db ? -1 : da > db ? 1 : 0;
  });

  sub.textContent = rows.length ? `${rows.length} Termine` : 'keine Einträge';

  if (!rows.length) {
    list.append(h('div', { class: 'empty' }, 'Keine kommenden Termine'));
    return;
  }

  const byDay = new Map();
  for (const r of rows) {
    const key = r.datum_iso || 'unbekannt';
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(r);
  }

  for (const [date, events] of byDay.entries()) {
    const group = h('section', { class: 'day-group' });
    group.append(h('div', { class: 'day-heading' },
      h('span', { class: 'day-heading__day' }, fmtDateHeading(date)),
    ));
    for (const ev of events) {
      group.append(buildEventCard(ev));
    }
    list.append(group);
  }
}

function buildEventCard(ev) {
  return h('article', { class: 'event' },
    h('div', { class: 'event__time mono' },
      h('span', {}, `${fmtTime(ev.zeit_von)} - ${fmtTime(ev.zeit_bis)}`),
      ev.klasse ? h('small', {}, ev.klasse) : null,
    ),
    h('div', { class: 'event__body' },
      h('div', { class: 'event__title' }, ev.veranstaltung || '-'),
      h('div', { class: 'event__meta' },
        ev.raum ? h('span', { class: 'event__meta-item' }, iconPin(), ev.raum) : null,
        ev.dozent ? h('span', { class: 'event__meta-item' }, iconUser(), ev.dozent) : null,
      ),
    ),
  );
}

function svgIcon(inner) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('width', '14'); s.setAttribute('height', '14');
  s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor');
  s.setAttribute('stroke-width', '2');
  s.setAttribute('stroke-linecap', 'round');
  s.setAttribute('stroke-linejoin', 'round');
  s.innerHTML = inner;
  return s;
}
function iconPin()  { return svgIcon('<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="3"/>'); }
function iconUser() { return svgIcon('<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>'); }

// ---------- Einstellungen ----------
function applyLockState(inputIds, locked, hintText) {
  for (const id of inputIds) {
    const el = document.getElementById(id);
    if (!el) continue;
    const field = el.closest('.field');
    if (locked) {
      el.setAttribute('disabled', '');
      el.classList.add('is-locked');
      if (field && !field.querySelector('.field__hint--locked')) {
        const hint = h('small', { class: 'field__hint field__hint--locked' }, hintText);
        field.append(hint);
      }
    } else {
      el.removeAttribute('disabled');
      el.classList.remove('is-locked');
      if (field) {
        const existing = field.querySelector('.field__hint--locked');
        if (existing) existing.remove();
      }
    }
  }
}

function renderSettings(s) {
  if (!s) return;
  const allowUiCreds = s.allowUiCredentials !== false;
  const urlsLocked   = !!s.urlsLocked;

  $('#msEmail').value           = s.msEmail || '';
  $('#msPassword').value        = '';
  $('#msPassword').placeholder  = s.passwordSet ? '••• (unverändert)' : 'Passwort setzen';
  $('#userPk').value            = s.userPk || '';
  $('#baseUrl').value           = s.baseUrl || '';
  $('#notenUrl').value          = s.notenUrl || '';
  $('#stundenplanUrl').value    = s.stundenplanUrl || '';

  // Respect env-only locks
  applyLockState(['msEmail', 'msPassword', 'userPk'], !allowUiCreds, 'Wert nur via .env änderbar');
  applyLockState(['telegramToken'], !allowUiCreds, 'Wert nur via .env änderbar');
  applyLockState(['baseUrl', 'notenUrl', 'stundenplanUrl'], urlsLocked, 'Wert nur via .env änderbar');
  $('#autoRun').checked         = !!s.autoRun;
  $('#headless').checked        = !!s.headless;
  $('#slowMo').value            = s.slowMo != null ? s.slowMo : 0;
  const iv = s.intervalMinutes || 60;
  $('#intervalMinutes').value   = iv;
  $('#intervalValue').textContent = iv;

  // Scheduler-Modus
  const mode = s.scheduleMode === 'weekly' ? 'weekly' : 'interval';
  for (const r of document.querySelectorAll('input[name="scheduleMode"]')) r.checked = (r.value === mode);
  applyScheduleMode(mode);

  // Wochentage (beide Modi)
  const days = Array.isArray(s.scheduleDays) ? s.scheduleDays : [];
  for (const chip of document.querySelectorAll('.day-chip')) {
    const d = Number(chip.dataset.day);
    chip.classList.toggle('is-active', days.includes(d));
  }

  // Intervall-Zeitfenster
  $('#intervalTimeFrom').value = s.intervalTimeFrom || '08:00';
  $('#intervalTimeTo').value   = s.intervalTimeTo   || '20:00';

  // Uhrzeiten (Weekly)
  renderScheduleTimes(Array.isArray(s.scheduleTimes) ? s.scheduleTimes : []);
  $('#telegramEnabled').checked         = !!s.telegramEnabled;
  $('#telegramToken').value             = '';
  $('#telegramToken').placeholder       = s.telegramTokenSet ? '••• (unverändert)' : 'Token eintragen';
  $('#telegramAllowedUserId').value     = s.telegramAllowedUserId != null ? s.telegramAllowedUserId : '';
}

function applyScheduleMode(mode) {
  for (const p of document.querySelectorAll('[data-mode-panel]')) {
    p.style.display = (p.dataset.modePanel === mode) ? '' : 'none';
  }
}

function renderScheduleTimes(times) {
  const wrap = $('#scheduleTimes');
  if (!wrap) return;
  while (wrap.firstChild) wrap.firstChild.remove();
  for (const t of times) {
    const input = document.createElement('input');
    input.type = 'time';
    input.className = 'time-input';
    input.value = t;
    const row = h('div', { class: 'time-row' },
      input,
      h('button', {
        type: 'button',
        class: 'time-remove',
        onclick: (e) => { e.preventDefault(); row.remove(); }
      }, '×')
    );
    wrap.append(row);
  }
}

function readScheduleTimes() {
  return [...document.querySelectorAll('#scheduleTimes .time-input')]
    .map(i => i.value.trim())
    .filter(v => /^\d{1,2}:\d{2}$/.test(v))
    .map(v => {
      const [hh, mm] = v.split(':');
      return hh.padStart(2, '0') + ':' + mm;
    });
}

function readScheduleDays() {
  return [...document.querySelectorAll('.day-chip.is-active')]
    .map(b => Number(b.dataset.day))
    .filter(n => !Number.isNaN(n));
}

function initSettingsForm() {
  const slider = $('#intervalMinutes');
  const valLabel = $('#intervalValue');
  slider.addEventListener('input', () => { valLabel.textContent = slider.value; });

  for (const r of document.querySelectorAll('input[name="scheduleMode"]')) {
    r.addEventListener('change', () => applyScheduleMode(r.value));
  }
  for (const chip of document.querySelectorAll('.day-chip')) {
    chip.addEventListener('click', (e) => {
      e.preventDefault();
      chip.classList.toggle('is-active');
    });
  }
  $('#addTimeBtn')?.addEventListener('click', (e) => {
    e.preventDefault();
    const existing = readScheduleTimes();
    renderScheduleTimes([...existing, '08:00']);
  });

  $('#settingsForm').addEventListener('submit', async e => {
    e.preventDefault();
    const status = $('#settingsStatus');
    status.className = 'settings__status';
    status.textContent = 'Speichere...';

    const s = state.settings || {};
    const allowUiCreds = s.allowUiCredentials !== false;
    const urlsLocked   = !!s.urlsLocked;

    const pw = $('#msPassword').value;
    const tgToken = $('#telegramToken').value;
    const tgUserId = $('#telegramAllowedUserId').value.trim();
    const modeRadio = document.querySelector('input[name="scheduleMode"]:checked');
    const payload = {
      autoRun: $('#autoRun').checked,
      headless: $('#headless').checked,
      slowMo: Number($('#slowMo').value) || 0,
      intervalMinutes: Number($('#intervalMinutes').value) || 60,
      scheduleMode: modeRadio ? modeRadio.value : 'interval',
      scheduleDays: readScheduleDays(),
      scheduleTimes: readScheduleTimes(),
      intervalTimeFrom: $('#intervalTimeFrom').value || '08:00',
      intervalTimeTo:   $('#intervalTimeTo').value   || '20:00',
      telegramEnabled: $('#telegramEnabled').checked,
      telegramAllowedUserId: tgUserId ? Number(tgUserId) : null
    };

    // Skip env-only fields based on backend lock flags
    if (allowUiCreds) {
      payload.msEmail = $('#msEmail').value.trim();
      payload.userPk  = $('#userPk').value.trim();
      if (pw)      payload.msPassword   = pw;
      if (tgToken) payload.telegramToken = tgToken;
    }
    if (!urlsLocked) {
      payload.baseUrl        = $('#baseUrl').value.trim();
      payload.notenUrl       = $('#notenUrl').value.trim();
      payload.stundenplanUrl = $('#stundenplanUrl').value.trim();
    }

    try {
      const res = await api.patch('/api/settings', payload);
      state.settings = res.settings || state.settings;
      renderSettings(state.settings);
      status.classList.add('is-success');
      status.textContent = res.rescheduled ? 'Gespeichert - Automatik neu geplant.' : 'Gespeichert.';
      toast({ title: 'Einstellungen gespeichert', msg: res.rescheduled ? 'Automatik wurde neu geplant.' : '', type: 'success' });
      setTimeout(() => { status.textContent = ''; status.className = 'settings__status'; }, 4000);
    } catch (err) {
      status.classList.add('is-error');
      status.textContent = `Fehler: ${err.message}`;
      toast({ title: 'Speichern fehlgeschlagen', msg: err.message, type: 'error' });
    }
  });
}

// ---------- Scrape button ----------
function initScrapeButton() {
  $('#scrapeBtn').addEventListener('click', async () => {
    if (state.scraping) return;
    const btn = $('#scrapeBtn');
    btn.disabled = true;
    btn.classList.add('is-loading');
    try {
      const res = await api.post('/api/scrape');
      if (res && res.triggered === false) {
        toast({ title: 'Scrape nicht gestartet', msg: res.reason || 'läuft bereits', type: 'warn' });
        btn.classList.remove('is-loading');
        btn.disabled = false;
      } else {
        toast({ title: 'Scrape gestartet', msg: 'Ergebnisse erscheinen in Kürze.', type: 'success' });
      }
    } catch (err) {
      toast({ title: 'Scrape fehlgeschlagen', msg: err.message, type: 'error' });
      btn.classList.remove('is-loading');
      btn.disabled = false;
    }
  });
}

// ---------- Log drawer ----------
const LOG_MAX = 500;

function initDrawer() {
  const drawer = $('#drawer');
  const toggle = $('#drawerToggle');
  const body   = $('#drawerBody');

  toggle.addEventListener('click', () => {
    const opening = body.hidden;
    body.hidden = !opening;
    toggle.setAttribute('aria-expanded', opening ? 'true' : 'false');
    drawer.setAttribute('aria-expanded', opening ? 'true' : 'false');
    if (opening) state.logSeen = $$('#logList .log-row').length;
    updateDrawerCount();
  });
}

function appendLog(entry) {
  const list = $('#logList');
  const level = (entry.level || 'info').toLowerCase();
  const ts = entry.ts ? new Date(entry.ts) : new Date();
  const tsStr = ts.toLocaleTimeString('de-CH', { hour12: false });

  const row = h('div', { class: `log-row lv-${level}` },
    h('span', { class: 'log-row__ts' }, tsStr),
    h('span', { class: 'log-row__lv' }, level),
    h('span', { class: 'log-row__msg' }, entry.message || ''),
  );
  list.append(row);

  while (list.children.length > LOG_MAX) list.removeChild(list.firstChild);

  const body = $('#drawerBody');
  if (!body.hidden) {
    list.scrollTop = list.scrollHeight;
    state.logSeen = list.children.length;
  }
  updateDrawerCount();
}

function updateDrawerCount() {
  const list = $('#logList');
  const total = list.children.length;
  const body = $('#drawerBody');
  const badge = $('#drawerCount');
  if (body.hidden) {
    const unseen = Math.max(0, total - state.logSeen);
    badge.textContent = unseen > 0 ? `+${unseen}` : String(total);
  } else {
    badge.textContent = String(total);
  }
}

// ---------- Toasts ----------
function toast(opts) {
  const { title, msg, type = 'info', timeout = 4500 } = opts;
  const wrap = $('#toasts');
  const el = h('div', { class: `toast toast--${type}` },
    title ? h('div', { class: 'toast__title' }, title) : null,
    msg   ? h('div', { class: 'toast__msg' }, msg) : null,
  );
  wrap.append(el);
  setTimeout(() => {
    el.style.transition = 'opacity .25s ease, transform .25s ease';
    el.style.opacity = '0';
    el.style.transform = 'translateX(8px)';
    setTimeout(() => el.remove(), 260);
  }, timeout);
}

// ---------- data fetchers ----------
async function loadNoten() {
  try {
    const data = await api.get('/api/noten');
    state.noten = data;
    renderAverages(data);
    renderNotenTable();
  } catch (err) {
    if (err && err.silent) return;
    appendLog({ level: 'error', message: `Noten laden: ${err.message}` });
  }
}
async function loadStundenplan() {
  try {
    const data = await api.get('/api/stundenplan');
    state.stundenplan = data;
    renderStundenplan(data);
  } catch (err) {
    if (err && err.silent) return;
    appendLog({ level: 'error', message: `Stundenplan laden: ${err.message}` });
  }
}
async function loadStatus() {
  try {
    const data = await api.get('/api/status');
    renderStatus(data);
  } catch (_) {
    // silent; connection likely down - SSE reconnect handles visibility
  }
}
async function loadSettings() {
  try {
    const data = await api.get('/api/settings');
    state.settings = data;
    renderSettings(data);
  } catch (err) {
    if (err && err.silent) return;
    appendLog({ level: 'error', message: `Einstellungen laden: ${err.message}` });
  }
}
async function loadInitialLogs() {
  try {
    const data = await api.get('/api/logs?limit=200');
    for (const entry of (data.logs || [])) appendLog(entry);
  } catch (_) {
    // optional endpoint
  }
}

// ---------- SSE ----------
let sse = null;
let sseReconnectDelay = 1000;
let sseEverOpened = false;

function connectSSE() {
  const token = getToken();
  if (!token) { showLogin(); return; }
  try {
    sse = new EventSource('/api/events?token=' + encodeURIComponent(token));
  } catch (err) {
    appendLog({ level: 'error', message: `SSE: ${err.message}` });
    return;
  }
  const led = document.querySelector('.drawer__led');
  sseEverOpened = false;

  sse.onopen = () => {
    sseReconnectDelay = 1000;
    sseEverOpened = true;
    if (led) led.classList.remove('is-disconnected');
  };

  sse.onerror = () => {
    if (led) led.classList.add('is-disconnected');
    const wasClosed = sse && sse.readyState === 2;
    try { sse.close(); } catch (_) {}
    sse = null;
    // If initial handshake never opened and stream closed immediately → likely 401.
    if (!sseEverOpened && wasClosed) {
      verifyTokenOrShowLogin();
      return;
    }
    setTimeout(connectSSE, sseReconnectDelay);
    sseReconnectDelay = Math.min(sseReconnectDelay * 2, 15000);
  };

  sse.onmessage = (evt) => handleSse(evt.data);
  ['status', 'log', 'scrape_done'].forEach(name => {
    sse.addEventListener(name, (evt) => handleSse(evt.data, name));
  });
}

async function verifyTokenOrShowLogin() {
  const r = await tryLogin(getToken());
  if (!r.ok) {
    showLogin('Token ungültig - bitte neu anmelden');
  } else {
    // not an auth issue; retry SSE after backoff
    setTimeout(connectSSE, sseReconnectDelay);
    sseReconnectDelay = Math.min(sseReconnectDelay * 2, 15000);
  }
}

function handleSse(raw, typeHint) {
  let payload;
  try { payload = JSON.parse(raw); } catch (_) { return; }

  const type = (payload && payload.type) || typeHint;
  const data = (payload && payload.data != null) ? payload.data : payload;

  if (type === 'status') {
    renderStatus(data);
  } else if (type === 'log') {
    appendLog(data);
  } else if (type === 'scrape_done') {
    appendLog({ level: 'info', message: 'Scrape abgeschlossen - lade Daten neu...' });
    loadNoten();
    loadStundenplan();
    loadStatus();
    toast({ title: 'Scrape fertig', msg: 'Noten & Stundenplan aktualisiert.', type: 'success' });
  }
}

// ---------- fallback polling ----------
function startStatusPolling() {
  setInterval(loadStatus, 10000);
}

// ---------- login flow ----------
function showLogin(reason) {
  const overlay = $('#loginOverlay');
  if (!overlay) return;
  overlay.hidden = false;
  const status = $('#loginStatus');
  if (reason) {
    status.textContent = reason;
    status.className = 'login-card__status is-error';
  }
  setTimeout(() => { try { $('#loginToken').focus(); } catch (_) {} }, 0);
}

function hideLogin() {
  const overlay = $('#loginOverlay');
  if (!overlay) return;
  overlay.hidden = true;
  $('#loginToken').value = '';
  $('#loginStatus').textContent = '';
  $('#loginStatus').className = 'login-card__status';
}

async function tryLogin(token) {
  if (!token) return { ok: false, error: 'Token fehlt' };
  try {
    const res = await fetch('/api/status', {
      credentials: 'same-origin',
      headers: { Authorization: 'Bearer ' + token },
    });
    if (res.status === 401) return { ok: false, error: 'Token ungültig' };
    if (!res.ok)            return { ok: false, error: 'Server-Fehler (' + res.status + ')' };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: 'Netzwerkfehler: ' + err.message };
  }
}

function initLogin() {
  const form = $('#loginForm');
  if (!form) return;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const token = $('#loginToken').value.trim();
    if (!token) return;
    const status = $('#loginStatus');
    status.textContent = 'Prüfe...';
    status.className = 'login-card__status';
    const r = await tryLogin(token);
    if (r.ok) {
      setToken(token);
      hideLogin();
      bootAuthenticated();
    } else {
      status.textContent = r.error;
      status.className = 'login-card__status is-error';
    }
  });
}

function initLogoutButton() {
  const btn = $('#logoutBtn');
  if (!btn) return;
  btn.addEventListener('click', () => {
    clearToken();
    try { if (sse) sse.close(); } catch (_) {}
    location.reload();
  });
}

// ---------- boot ----------
function bootAuthenticated() {
  Promise.all([loadStatus(), loadNoten(), loadStundenplan(), loadSettings(), loadInitialLogs()])
    .catch(() => {});
  connectSSE();
  startStatusPolling();
}

function boot() {
  initLogin();
  initTabs();
  initNotenTab();
  initHistoryModal();
  initSettingsForm();
  initScrapeButton();
  initDrawer();
  initLogoutButton();

  const token = getToken();
  if (!token) { showLogin(); return; }

  tryLogin(token).then(r => {
    if (!r.ok) { showLogin('Token ungültig - bitte neu anmelden'); return; }
    bootAuthenticated();
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
