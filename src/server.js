/**
 * server.js — Express HTTP-Server + Scheduler für Tocco WISS Scraper.
 *
 * Start:
 *   npm run serve
 *
 * Endpoints siehe README / Inline-Kommentare unten.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');

// ---------- .env → process.env (vor allen weiteren requires) ----------
// Lädt .env-Werte in process.env, ohne bereits gesetzte ENV-Vars zu überschreiben
// (Docker's env_file + shell-env haben Vorrang).
(function loadDotenvIntoProcess() {
  const envPath = path.join(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return;
  try {
    const content = fs.readFileSync(envPath, 'utf8');
    for (const line of content.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const m = t.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/i);
      if (!m) continue;
      let v = m[2];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      if (process.env[m[1]] == null || process.env[m[1]] === '') {
        process.env[m[1]] = v;
      }
    }
  } catch (_) { /* .env nicht lesbar → ignorieren */ }
})();

const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const settings = require('./settings');
const logger = require('./logger');
const scraper = require('./scraper');
const db = require('./db');
const bot = require('./bot');

// web-push ist optional — wenn das Paket fehlt (z.B. nach git-clone ohne npm install)
// laufen Endpoints / Scrape-Block ohne Push weiter und loggen einen Hinweis.
let push = null;
try {
  push = require('./push');
  push.init();
  logger.log('🔔 Web-Push initialisiert (VAPID public ' + push.getPublicKey().slice(0, 12) + '…)');
} catch (e) {
  push = null;
  logger.log('⚠️  Web-Push deaktiviert: ' + (e && e.message ? e.message : 'unbekannt'), 'warn');
}

// settings.js darf über Logger warnen (UI-Patch-Drops, etc.)
if (typeof settings.setLogger === 'function') {
  settings.setLogger(logger);
}

// =============================================================
// Paths
// =============================================================

const DATA_DIR = path.join(process.cwd(), 'data');
const API_TOKEN_FILE = path.join(DATA_DIR, '.api-token');
const MIN_TOKEN_LENGTH = 16;

// =============================================================
// API Token (auto-generate + persist)
// =============================================================

function banner(lines) {
  const sep = '='.repeat(60);
  logger.log(sep, 'info');
  for (const l of lines) logger.log('  ' + l, 'info');
  logger.log(sep, 'info');
}

function ensureApiToken() {
  const envToken = typeof process.env.API_TOKEN === 'string' ? process.env.API_TOKEN.trim() : '';
  if (envToken) {
    if (envToken.length < MIN_TOKEN_LENGTH) {
      logger.log(
        `❌ API_TOKEN ist zu kurz (< ${MIN_TOKEN_LENGTH} Zeichen). Server wird beendet.`,
        'error'
      );
      process.exit(1);
    }
    return { token: envToken, generated: false };
  }

  // Versuche persisted token zu lesen
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (_) { /* ignore */ }

  // Direkt lesen (vermeidet TOCTOU zwischen existsSync und readFileSync)
  try {
    const persisted = fs.readFileSync(API_TOKEN_FILE, 'utf8').trim();
    if (persisted && persisted.length >= MIN_TOKEN_LENGTH) {
      return { token: persisted, generated: false };
    }
  } catch (err) {
    if (err && err.code !== 'ENOENT') { /* read error — neu generieren */ }
  }

  // Neuen Token generieren
  const newToken = crypto.randomBytes(32).toString('hex');
  try {
    fs.writeFileSync(API_TOKEN_FILE, newToken, { encoding: 'utf8', mode: 0o600 });
    try { fs.chmodSync(API_TOKEN_FILE, 0o600); } catch (_) { /* Windows compat */ }
  } catch (e) {
    logger.log(
      '⚠️  Konnte data/.api-token nicht schreiben: ' + (e && e.message ? e.message : e),
      'warn'
    );
  }

  banner([
    'AUTO-GENERATED API_TOKEN (store it!):',
    '',
    '  ' + newToken,
    '',
    'persisted to data/.api-token (mode 0600)',
    'Override by setting API_TOKEN env var.'
  ]);

  return { token: newToken, generated: true };
}

const { token: API_TOKEN, generated: API_TOKEN_GENERATED } = ensureApiToken();
const API_TOKEN_BUFFER = Buffer.from(API_TOKEN, 'utf8');

function tokensMatch(provided) {
  if (typeof provided !== 'string' || !provided) return false;
  const providedBuf = Buffer.from(provided, 'utf8');
  if (providedBuf.length !== API_TOKEN_BUFFER.length) return false;
  try {
    return crypto.timingSafeEqual(providedBuf, API_TOKEN_BUFFER);
  } catch (_) {
    return false;
  }
}

// =============================================================
// Env-Flags
// =============================================================

function parseBoolEnv(v, def = false) {
  if (v == null) return def;
  const s = String(v).trim().toLowerCase();
  if (s === 'true' || s === '1' || s === 'yes') return true;
  if (s === 'false' || s === '0' || s === 'no') return false;
  return def;
}

const ALLOW_UI_CREDENTIALS = parseBoolEnv(process.env.ALLOW_UI_CREDENTIALS, false);

// =============================================================
// State
// =============================================================

const state = {
  running: false,
  lastRun: null,           // ISO string
  nextRun: null,           // ISO string
  lastError: null,         // string | null
  lastStats: null,         // letzter scraper-Result (summary)
  timer: null,             // scheduled setTimeout handle (regulärer Scrape)
  weeklyTimer: null,       // setTimeout handle für wöchentlichen Detail-Refresh
  lastManualAt: 0,         // Timestamp (ms) des letzten manuellen scrape-Triggers (Cooldown)
  lastWeeklyDetailAt: null,// ISO string — letzter wöchentlicher Voll-Refresh
  currentPhase: null,      // 'starting'|'browser'|'login'|'noten'|'stundenplan'|'saving'|null
  phaseStartedAt: null     // ISO timestamp — wann die aktuelle Phase begann
};

const sseClients = new Set();
const SSE_MAX_CLIENTS = 20;
const MANUAL_SCRAPE_COOLDOWN_MS = 60 * 1000;

// Wöchentlicher Detail-Refresh: jeden Samstag 03:00 Uhr.
// Hintergrund-Check ob neue ZP/LB hinzugekommen sind, ohne dass sich die
// Modulnote geändert hätte (Edge-Case ZP=5.5 + LB=5.5 → Schnitt bleibt 5.5).
const WEEKLY_DETAIL_DAY = 6;       // 0=So, 1=Mo, ..., 6=Sa
const WEEKLY_DETAIL_HOUR = 3;      // 03:00
const WEEKLY_DETAIL_FILE = path.join(DATA_DIR, '.weekly-detail-at');

function loadWeeklyDetailState() {
  try {
    const v = fs.readFileSync(WEEKLY_DETAIL_FILE, 'utf8').trim();
    if (v) state.lastWeeklyDetailAt = v;
  } catch (_) { /* not yet written */ }
}

function persistWeeklyDetailState() {
  try {
    fs.writeFileSync(WEEKLY_DETAIL_FILE, state.lastWeeklyDetailAt || '', { encoding: 'utf8', mode: 0o600 });
  } catch (e) {
    logger.log('⚠️  Konnte ' + WEEKLY_DETAIL_FILE + ' nicht schreiben: ' + (e && e.message ? e.message : e), 'warn');
  }
}

// =============================================================
// Helpers
// =============================================================

function maskSettings(s) {
  const hasPw = typeof s.msPassword === 'string' && s.msPassword.length > 0;
  const hasTg = typeof s.telegramToken === 'string' && s.telegramToken.length > 0;

  const out = {
    // Scheduler/UI-Felder
    autoRun: s.autoRun,
    intervalMinutes: s.intervalMinutes,
    intervalTimeFrom: s.intervalTimeFrom,
    intervalTimeTo: s.intervalTimeTo,
    scheduleMode: s.scheduleMode,
    scheduleDays: s.scheduleDays,
    scheduleTimes: s.scheduleTimes,
    headless: s.headless,
    slowMo: s.slowMo,
    port: s.port,
    telegramEnabled: s.telegramEnabled,
    telegramAllowedUserId: s.telegramAllowedUserId,
    // URL-Felder readonly anzeigen, aber als gelockt markieren (env-only)
    baseUrl: s.baseUrl,
    notenUrl: s.notenUrl,
    stundenplanUrl: s.stundenplanUrl,
    urlsLocked: true,
    // Secret-Indikatoren
    emailSet: Boolean(s.msEmail),
    passwordSet: hasPw,
    telegramTokenSet: hasTg,
    // Flag für Frontend
    allowUiCredentials: ALLOW_UI_CREDENTIALS
  };

  // Nur wenn ALLOW_UI_CREDENTIALS=true: echte Werte mit senden,
  // damit das Formular sie anzeigen/editieren kann (ist hinter Auth).
  if (ALLOW_UI_CREDENTIALS) {
    out.msEmail = s.msEmail || '';
    out.userPk = s.userPk || '';
  }

  return out;
}

function buildScraperConfig(s) {
  return {
    msEmail: s.msEmail,
    msPassword: s.msPassword,
    baseUrl: s.baseUrl,
    notenUrl: s.notenUrl,
    stundenplanUrl: s.stundenplanUrl,
    headless: s.headless,
    slowMo: s.slowMo,
    storageFile: path.join(DATA_DIR, 'storage.json'),
    cwd: DATA_DIR
  };
}

// Formatiert ein Date / ISO-String für menschen-lesbare Logs als
// "HH:mm dd.MM.yyyy" (lokale Zeitzone — Node honoriert TZ env var).
function formatLocalDateTime(d) {
  if (d == null) return '–';
  const date = (d instanceof Date) ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return String(d);
  const pad = n => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())} `
       + `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()}`;
}

function statusPayload() {
  const s = settings.load();
  return {
    running: state.running,
    lastRun: state.lastRun,
    nextRun: state.nextRun,
    lastError: state.lastError,
    enabled: Boolean(s.autoRun),
    intervalMinutes: s.intervalMinutes,
    serverTime: new Date().toISOString(),
    currentPhase: state.currentPhase,
    phaseStartedAt: state.phaseStartedAt
  };
}

function setPhase(phase) {
  if (state.currentPhase === phase) return;
  state.currentPhase = phase;
  state.phaseStartedAt = phase ? new Date().toISOString() : null;
  broadcastStatus();
}

function apiError(res, status, message) {
  return res.status(status).json({ error: message, status });
}

// =============================================================
// SSE Broadcasting
// =============================================================

function broadcastSse(type, data) {
  const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try { client.write(payload); }
    catch (_) { /* tote Verbindung — wird vom close-handler entfernt */ }
  }
}

function broadcastStatus() {
  broadcastSse('status', statusPayload());
}

// Logger → SSE forwarding
logger.subscribe((entry) => {
  broadcastSse('log', entry);
});

// =============================================================
// Scheduler
// =============================================================

function clearTimer() {
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  state.nextRun = null;
}

function hmToMinutes(hm) {
  const [h, m] = String(hm || '').split(':').map(n => parseInt(n, 10));
  return (isNaN(h) ? 0 : h) * 60 + (isNaN(m) ? 0 : m);
}

// Ist `date` innerhalb des erlaubten Fensters (Wochentag + Zeit)?
function isWithinInterval(date, days, fromHm, toHm) {
  if (Array.isArray(days) && days.length && !days.includes(date.getDay())) return false;
  if (!fromHm || !toHm) return true;
  const cur = date.getHours() * 60 + date.getMinutes();
  const f = hmToMinutes(fromHm);
  const t = hmToMinutes(toHm);
  if (f === t) return true;
  if (f < t) return cur >= f && cur <= t;
  // Fenster geht über Mitternacht: z.B. 22:00–06:00
  return cur >= f || cur <= t;
}

// Sucht den Start des nächsten erlaubten Fensters nach `fromDate`
function nextWindowStart(fromDate, days, fromHm) {
  const [fh, fm] = String(fromHm || '00:00').split(':').map(n => parseInt(n, 10));
  for (let d = 0; d <= 8; d++) {
    const cand = new Date(fromDate);
    cand.setDate(cand.getDate() + d);
    cand.setHours(fh, fm, 0, 0);
    const dayOk = !Array.isArray(days) || !days.length || days.includes(cand.getDay());
    if (dayOk && cand > fromDate) return cand;
  }
  return null;
}

// Berechnet den nächsten Fire-Zeitpunkt basierend auf dem gewählten Mode.
// Mode 'interval':  jetzt + N Minuten, aber nur innerhalb Tag+Zeitfenster
// Mode 'weekly':    nächster Tag-Zeit-Slot aus scheduleDays × scheduleTimes
function computeNextRun(s, fromDate = new Date()) {
  if (s.scheduleMode === 'weekly') {
    if (!Array.isArray(s.scheduleDays) || !s.scheduleDays.length) return null;
    if (!Array.isArray(s.scheduleTimes) || !s.scheduleTimes.length) return null;

    let best = null;
    for (let dayOffset = 0; dayOffset <= 7; dayOffset++) {
      const candDate = new Date(fromDate);
      candDate.setDate(candDate.getDate() + dayOffset);
      if (!s.scheduleDays.includes(candDate.getDay())) continue;

      for (const hm of s.scheduleTimes) {
        const [h, m] = hm.split(':').map(n => parseInt(n, 10));
        const cand = new Date(candDate);
        cand.setHours(h, m, 0, 0);
        if (cand > fromDate && (!best || cand < best)) best = cand;
      }
    }
    return best;
  }

  // Interval: naive + N Minuten, dann Tag/Fenster prüfen
  const ms = Math.max(1, s.intervalMinutes) * 60 * 1000;
  const naiveNext = new Date(fromDate.getTime() + ms);

  if (isWithinInterval(naiveNext, s.scheduleDays, s.intervalTimeFrom, s.intervalTimeTo)) {
    return naiveNext;
  }
  // Außerhalb → springe auf Start des nächsten erlaubten Fensters
  return nextWindowStart(naiveNext, s.scheduleDays, s.intervalTimeFrom);
}

// Berechnet den nächsten Samstag um WEEKLY_DETAIL_HOUR Uhr (lokale Zeit).
// Falls heute Samstag und es ist NACH der Uhrzeit → nächster Samstag.
function nextWeeklyDetailRun(fromDate = new Date()) {
  const target = new Date(fromDate);
  target.setHours(WEEKLY_DETAIL_HOUR, 0, 0, 0);
  let daysUntil = (WEEKLY_DETAIL_DAY - target.getDay() + 7) % 7;
  if (daysUntil === 0 && target <= fromDate) daysUntil = 7;
  target.setDate(target.getDate() + daysUntil);
  return target;
}

function clearWeeklyTimer() {
  if (state.weeklyTimer) {
    clearTimeout(state.weeklyTimer);
    state.weeklyTimer = null;
  }
}

function scheduleWeeklyDetailRefresh() {
  clearWeeklyTimer();
  const now = Date.now();

  // Catch-Up: wenn letzter Lauf > 7 Tage zurück (oder noch nie gelaufen),
  // beim nächsten möglichen Slot starten — nicht auf nächsten Samstag warten.
  // Slot = jetzt + 90s (damit Boot/UI initial fertig ist).
  let next;
  const lastMs = state.lastWeeklyDetailAt ? Date.parse(state.lastWeeklyDetailAt) : NaN;
  const overdue = !Number.isFinite(lastMs) || (now - lastMs) > 7 * 24 * 3600 * 1000;
  if (overdue) {
    next = new Date(now + 90 * 1000);
    logger.log('🗓️  Wochen-Check überfällig — triggert in 90s', 'info');
  } else {
    next = nextWeeklyDetailRun();
  }

  const ms = Math.max(1000, next.getTime() - now);
  state.weeklyTimer = setTimeout(() => {
    runScrapeCycle('weekly').catch(() => { /* state.lastError ist gesetzt */ });
  }, ms);
  // setTimeout-Delay max ~24.8 Tage (2^31 ms) — bei einer Woche immer ok.
  logger.log(`🗓️  Nächster Wochen-Detail-Refresh: ${formatLocalDateTime(next)} (in ${Math.round(ms/3600000)}h)`, 'info');
}

function scheduleNext() {
  clearTimer();
  const s = settings.load();
  if (!s.autoRun) return;

  const next = computeNextRun(s);
  if (!next) {
    logger.log('⚠️  Scheduler: kein gültiger Slot (Tage oder Uhrzeiten leer?)', 'warn');
    return;
  }
  const ms = Math.max(1000, next.getTime() - Date.now());
  state.nextRun = next.toISOString();

  state.timer = setTimeout(() => {
    runScrapeCycle('scheduled').catch(() => {});
  }, ms);

  const friendly = s.scheduleMode === 'weekly'
    ? next.toLocaleString('de-DE', { weekday: 'short' })
    : `in ${Math.round(ms/60000)} min`;
  logger.log(`⏰ Nächster Scrape: ${formatLocalDateTime(next)} (${friendly})`, 'info');
  broadcastStatus();
}

async function runScrapeCycle(reason) {
  if (state.running) {
    logger.log(`⚠️  Scrape bereits aktiv — Trigger "${reason}" ignoriert`, 'warn');
    return { triggered: false, reason: 'already_running' };
  }

  const s = settings.load();
  if (!s.msEmail || !s.msPassword) {
    const msg = 'msEmail / msPassword fehlen — scrape abgebrochen.';
    state.lastError = msg;
    logger.log('❌ ' + msg, 'error');
    broadcastStatus();
    return { triggered: false, reason: 'missing_credentials' };
  }

  state.running = true;
  state.lastError = null;
  clearTimer();
  setPhase('starting');
  logger.log(`🚀 Scrape gestartet (reason=${reason})`, 'info');

  const startTs = Date.now();
  let result = null;
  let database = null;
  let scraped = null;

  try {
    const cfg = buildScraperConfig(s);
    scraped = await scraper.runScrape(
      cfg,
      (msg, level) => logger.log(msg, level),
      (phase) => setPhase(phase)
    );
    result = scraped;

    // Persistieren
    setPhase('saving');
    database = db.open();
    const nStats = db.saveNoten(database, scraped.noten || []);

    // detail_id-Mapping aus DWR-Response in der noten-Tabelle persistieren
    let detailIdsUpdated = 0;
    if (scraped.detailIdMap && Object.keys(scraped.detailIdMap).length) {
      detailIdsUpdated = db.updateDetailIds(database, scraped.detailIdMap);
    }

    const sStats = db.saveStundenplan(database, scraped.stundenplan || []);
    const pruned = db.pruneVergangen(database);

    // Modul-Detail-Scrape: alle Module mit gradeChange (new/changed) UND
    // alle benoteten Module ohne bisherige Pruefungen-Daten (Backfill).
    const changedKuerzelIds = (nStats.gradeChanges || [])
      .map(c => c.kuerzel_id)
      .filter(Boolean);

    let detailStats = { modulesScraped: 0, totalEntries: 0, errors: 0 };
    // Modul-Liste je nach Modus:
    //   reason='weekly' → ALLE benoteten Module mit detail_id (Cooldown ignoriert)
    //   sonst           → nur Module mit gradeChange ODER ohne bisherige Prüfungen
    const isWeekly = reason === 'weekly';
    const toScrape = isWeekly
      ? db.getKuerzelnWithDetailId(database).map(r => ({ kuerzel_id: r.kuerzel_id, detail_id: r.detail_id }))
      : db.getKuerzelnNeedingDetailScrape(database, changedKuerzelIds);

    // Wochen-Diff-Sammlung: pro Modul welche Prüfungen sind NEU dazugekommen
    const weeklyReport = []; // { kuerzel_id, fach_name, semester, kuerzel_code, added: [...] }

    if (toScrape.length && typeof scraped.scrapeDetail === 'function') {
      setPhase('noten_details');
      logger.log(`📥 Detail-Scrape für ${toScrape.length} Modul(e)${isWeekly ? ' (wöchentlicher Voll-Refresh)' : ''}`, 'info');
      for (const m of toScrape) {
        try {
          const entries = await scraped.scrapeDetail(m.detail_id);
          if (entries && entries.length) {
            const ps = db.savePruefungen(database, m.kuerzel_id, entries);
            detailStats.modulesScraped++;
            detailStats.totalEntries += (ps.inserted + ps.updated);
            logger.log(`  ✓ ${m.kuerzel_id} → ${entries.length} Prüfung(en)`, 'info');
            // Beim Wochen-Refresh: NEUE Prüfungen die nicht von einem
            // gradeChange-Push abgedeckt sind → eigener Push-Eintrag
            if (isWeekly && ps.addedEntries && ps.addedEntries.length) {
              const isAlreadyCovered = changedKuerzelIds.includes(m.kuerzel_id);
              if (!isAlreadyCovered) {
                const modulRow = db.getNotenRow(database, m.kuerzel_id);
                weeklyReport.push({
                  kuerzel_id: m.kuerzel_id,
                  fach_name:  modulRow ? modulRow.fach_name : null,
                  semester:   modulRow ? modulRow.semester : null,
                  kuerzel_code: modulRow ? modulRow.kuerzel_code : null,
                  added:      ps.addedEntries
                });
              }
            }
          } else {
            logger.log(`  ⏭️  ${m.kuerzel_id} → keine Prüfungs-Daten gefunden`, 'info');
          }
        } catch (e) {
          detailStats.errors++;
          logger.log(`  ❌ Detail-Scrape ${m.kuerzel_id}: ${e.message || e}`, 'warn');
        }
        // Cooldown-Marker setzen — egal ob Erfolg, Leer oder Fehler. So
        // wird das Modul nicht bei jedem Cycle erneut versucht (siehe
        // db.getKuerzelnNeedingDetailScrape Cooldown-Logik).
        try { db.markDetailScraped(database, m.kuerzel_id); } catch (_) { /* ignore */ }
      }
    }

    if (isWeekly) {
      state.lastWeeklyDetailAt = new Date().toISOString();
      persistWeeklyDetailState();
      logger.log(`🔍 Wochen-Check fertig — ${weeklyReport.length} Modul(e) mit neuen Prüfungen`, 'info');
    }

    state.lastStats = {
      noten: nStats,
      stundenplan: sStats,
      pruned,
      detailIdsUpdated,
      detail: detailStats,
      weeklyReport: isWeekly ? weeklyReport : null,
      fetchedAt: scraped.fetchedAt,
      counts: {
        noten: (scraped.noten || []).length,
        stundenplan: (scraped.stundenplan || []).length
      }
    };
    state.lastRun = new Date().toISOString();

    const dur = ((Date.now() - startTs) / 1000).toFixed(1);
    logger.log(
      `✅ Scrape fertig in ${dur}s — Noten: ${nStats.inserted} neu / ${nStats.updated} updated / ${nStats.changed} Note geändert. Stundenplan: ${sStats.inserted} neu / ${sStats.updated} updated / ${pruned} vergangen entfernt. Details: ${detailStats.modulesScraped} Modul(e) / ${detailStats.totalEntries} Prüfung(en)${detailStats.errors ? ' / ' + detailStats.errors + ' Fehler' : ''}.`,
      'info'
    );
  } catch (err) {
    const message = (err && err.message) ? err.message : String(err);
    state.lastError = message;
    logger.log('❌ Scrape-Fehler: ' + message, 'error');
  } finally {
    if (database) {
      try { database.close(); } catch (_) { /* swallow */ }
    }
    // Browser sicher schließen (wird seit der Detail-Page-Erweiterung NICHT
    // mehr automatisch von runScrape geschlossen — Aufrufer-Verantwortung).
    if (scraped && typeof scraped.closeBrowser === 'function') {
      try { await scraped.closeBrowser(); } catch (_) { /* swallow */ }
    }
    state.running = false;
    setPhase(null);
    broadcastStatus();
    broadcastSse('scrape_done', {
      ok: !state.lastError,
      error: state.lastError,
      stats: state.lastStats,
      finishedAt: new Date().toISOString()
    });
    // Telegram push
    try {
      if (state.lastError) {
        // escapeHtml — damit Fehlermeldungen mit <, >, & den HTML-Parser nicht kaputtmachen
        bot.notify('❌ <b>Scrape-Fehler</b>\n<code>' + escapeHtml(String(state.lastError)) + '</code>');
      } else {
        const gc = state.lastStats && state.lastStats.noten && state.lastStats.noten.gradeChanges;
        if (gc && gc.length) {
          let currentStats = null;
          let pruefungenByKuerzel = null;
          try {
            const statDb = db.open();
            try {
              currentStats = db.getStats(statDb);
              // Pruefungen für betroffene Module einsammeln (best-effort)
              pruefungenByKuerzel = {};
              for (const c of gc) {
                if (!c.kuerzel_id) continue;
                pruefungenByKuerzel[c.kuerzel_id] = db.getPruefungen(statDb, c.kuerzel_id);
              }
            } finally { statDb.close(); }
          } catch (_) { /* fallback */ }
          bot.notifyGradeChanges(gc, currentStats, pruefungenByKuerzel);
        }
        const rc = state.lastStats && state.lastStats.stundenplan && state.lastStats.stundenplan.roomChanges;
        if (rc && rc.length) {
          bot.notifyRoomChanges(rc);
        }

        // Web-Push (PWA) parallel zum Telegram-Bot — best-effort.
        if (push) {
          try {
            const gcAll = state.lastStats && state.lastStats.noten && state.lastStats.noten.gradeChanges;
            if (gcAll && gcAll.length) push.notifyGradeChanges(gcAll).catch(() => {});
            if (rc && rc.length) push.notifyRoomChanges(rc).catch(() => {});
          } catch (_) { /* push ist best-effort */ }
        }
        // Wöchentlicher Detail-Refresh: Push für Module mit neuen ZP/LB
        // die NICHT bereits durch einen gradeChange-Push abgedeckt waren.
        const wr = state.lastStats && state.lastStats.weeklyReport;
        if (wr && wr.length) {
          bot.notifyWeeklyDetailReport(wr);
        }
      }
    } catch (_) { /* notify ist best-effort */ }
    scheduleNext();
    scheduleWeeklyDetailRefresh();
  }

  return { triggered: true, result };
}

// ---------- escapeHtml ----------
// Shared mit bot.js; lokal dupliziert damit server.js keinen neuen Export braucht.
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// React auf Settings-Änderungen → Scheduler neu aufziehen wenn nötig
settings.subscribe((next, prev) => {
  const relevant = (prev.autoRun !== next.autoRun)
    || (prev.intervalMinutes !== next.intervalMinutes)
    || (prev.intervalTimeFrom !== next.intervalTimeFrom)
    || (prev.intervalTimeTo !== next.intervalTimeTo)
    || (prev.scheduleMode !== next.scheduleMode)
    || (JSON.stringify(prev.scheduleDays) !== JSON.stringify(next.scheduleDays))
    || (JSON.stringify(prev.scheduleTimes) !== JSON.stringify(next.scheduleTimes));
  if (relevant) {
    logger.log(`🔧 Settings geändert — Scheduler reschedule (mode=${next.scheduleMode}, autoRun=${next.autoRun})`, 'info');
    scheduleNext();
  }
});

// =============================================================
// Express App
// =============================================================

const app = express();

// Proxy-Trust: wenn hinter Docker/nginx steht, damit rate-limit die echte IP sieht.
app.set('trust proxy', 1);

// ---------- Security Headers ----------
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      frameSrc: ["'none'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      // Helmet Default aktiviert upgrade-insecure-requests — zwingt Browser
      // alle http:// Subresources auf https: umzubiegen. Bei LAN/HTTP-Deployments
      // bricht das CSS/JS mit ERR_SSL_PROTOCOL_ERROR. Entfernen via null.
      upgradeInsecureRequests: null
    }
  },
  // HSTS deaktivieren — LAN/HTTP-Default ohne TLS würde sonst den Browser
  // auf https: zwingen (ERR_SSL_PROTOCOL_ERROR). Reverse-Proxy setzt HSTS selbst.
  strictTransportSecurity: false
}));

app.use(express.json({ limit: '32kb' }));

// ---------- Healthcheck (unauthenticated, BEFORE auth) ----------
app.get('/healthz', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// ---------- Rate Limits ----------
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,          // 15 min
  limit: 300,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  // SSE skippen — long-lived connection, jede "request" wäre fatal.
  skip: (req) => req.path === '/api/events',
  handler: (req, res) => apiError(res, 429, 'Zu viele Anfragen, bitte später erneut versuchen')
});

const scrapeLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,           // 5 min
  limit: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (req, res) => apiError(res, 429, 'Scrape-Rate überschritten')
});

// Test-Push verbraucht FCM/Mozilla/Apple-Quota — wenn das spamt riskieren wir
// Push-Service-Suspension. Plus: Subscribe wird vor jedem PWA-Install genau
// einmal gerufen, mehr als ein paar pro Minute ist bot-ähnlich.
const pushLimiter = rateLimit({
  windowMs: 60 * 1000,               // 1 min
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (req, res) => apiError(res, 429, 'Push-Rate überschritten')
});

// Validiert eine Push-Subscription. Whitelist der erlaubten Push-Service-Hosts
// verhindert SSRF — sonst könnte ein Angreifer mit gestohlenem API-Token meinen
// Server arbitrary HTTP-Requests an interne Adressen schicken lassen
// (webpush.sendNotification → POST an subscription.endpoint).
const ALLOWED_PUSH_HOST_SUFFIXES = Object.freeze([
  'fcm.googleapis.com',                  // Chrome / Brave / Edge (Android & Desktop)
  'updates.push.services.mozilla.com',   // Firefox
  '.notify.windows.com',                 // Edge Legacy / Windows
  '.web.push.apple.com',                 // Safari iOS 16.4+ / macOS
  '.push.apple.com'
]);
const B64URL_RE = /^[A-Za-z0-9_\-+/=]+$/;
function validatePushSubscription(sub) {
  if (!sub || typeof sub !== 'object') return 'subscription required';
  if (typeof sub.endpoint !== 'string' || !sub.endpoint) return 'endpoint required';
  if (sub.endpoint.length > 1024) return 'endpoint too long';
  let url;
  try { url = new URL(sub.endpoint); } catch (_) { return 'invalid endpoint URL'; }
  if (url.protocol !== 'https:') return 'endpoint must be HTTPS';
  const host = url.hostname.toLowerCase();
  const hostAllowed = ALLOWED_PUSH_HOST_SUFFIXES.some(h =>
    h.startsWith('.') ? host.endsWith(h) : host === h
  );
  if (!hostAllowed) return 'endpoint host not allowed';
  if (!sub.keys || typeof sub.keys !== 'object') return 'keys required';
  if (typeof sub.keys.p256dh !== 'string' || !sub.keys.p256dh) return 'p256dh required';
  if (sub.keys.p256dh.length > 256 || !B64URL_RE.test(sub.keys.p256dh)) return 'p256dh invalid';
  if (typeof sub.keys.auth !== 'string' || !sub.keys.auth) return 'auth required';
  if (sub.keys.auth.length > 64 || !B64URL_RE.test(sub.keys.auth)) return 'auth invalid';
  return null;
}

// ---------- Anti-Brute-Force: Auth-Failure-Limiter ----------
// Defense-in-Depth gegen Token-Brute-Force. Zwei Schichten:
//
//   1. Kurze Schicht: 10 failed Auths / 15min / IP → 15min Lockout.
//      Stoppt aktive Wörterbuch-/Brute-Force-Attacken.
//   2. Lange Schicht: 50 failed Auths / 6h / IP → 6h Lockout.
//      Fängt verteilte Slow-Brute ab (z.B. 9 Versuche alle 15min, die der
//      kurzen Schicht entgehen würden = ~860/Tag).
//
// `skipSuccessfulRequests: true` → erfolgreiche Requests (status < 400)
// zählen NICHT mit. Nur 401er (und 429er aus dem Limiter selbst) erhöhen
// den Counter — legitime Nutzung wird also nicht eingeschränkt.
//
// `/api/events` (SSE) wird übersprungen: bei 401 reconnectet der Browser
// per EventSource sofort wieder, was legitime User mit abgelaufenem Token
// in Sekunden ausperren würde.
const authFailureLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  skipSuccessfulRequests: true,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: (req) => !req.path.startsWith('/api/') || req.path === '/api/events',
  handler: (req, res) => {
    logger.log(`🚫 Auth-Brute-Force blockiert (15min): IP ${req.ip} → ${req.method} ${req.path}`, 'warn');
    return apiError(res, 429, 'Zu viele fehlgeschlagene Auth-Versuche - IP für 15 Minuten gesperrt');
  }
});

const authBruteForceLockout = rateLimit({
  windowMs: 6 * 60 * 60 * 1000,      // 6h
  limit: 50,
  skipSuccessfulRequests: true,
  standardHeaders: false,             // nur die kurze Schicht setzt RateLimit-Headers
  legacyHeaders: false,
  skip: (req) => !req.path.startsWith('/api/') || req.path === '/api/events',
  handler: (req, res) => {
    logger.log(`⛔ Auth-Lockout (6h): IP ${req.ip} hat 50+ Auth-Fehler in 6h ausgelöst`, 'error');
    return apiError(res, 429, 'IP wegen wiederholter Auth-Fehler langzeitgesperrt (6h)');
  }
});

app.use(globalLimiter);
app.use(authFailureLimiter);
app.use(authBruteForceLockout);

// ---------- Auth Middleware (protect /api/*) ----------
app.use((req, res, next) => {
  if (!req.path.startsWith('/api/')) return next();

  // Token aus Header oder Query-String
  let provided = null;
  const auth = req.get('Authorization');
  if (auth && /^Bearer\s+/i.test(auth)) {
    provided = auth.replace(/^Bearer\s+/i, '').trim();
  } else if (typeof req.query.token === 'string') {
    provided = req.query.token;
  }

  if (!tokensMatch(provided)) {
    // Sichtbarkeit für Brute-Force-Erkennung. SSE wird gloggt aber von den
    // authFailure-Limitern selbst übersprungen (siehe oben).
    const reason = provided ? 'falscher Token' : 'kein Token';
    logger.log(`🔒 Auth fehlgeschlagen: IP ${req.ip} → ${req.method} ${req.path} (${reason})`, 'warn');
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

// ---------- Status ----------
app.get('/api/status', (req, res) => {
  res.json(statusPayload());
});

// ---------- Settings ----------
app.get('/api/settings', (req, res) => {
  res.json(maskSettings(settings.load()));
});

app.patch('/api/settings', (req, res) => {
  const body = (req.body && typeof req.body === 'object') ? req.body : {};

  // Allowlist-Filter (vor save) — entfernt URLs/Port, sowie Credentials wenn ALLOW_UI_CREDENTIALS=false
  const filtered = (typeof settings.filterUiPatch === 'function')
    ? settings.filterUiPatch(body, ALLOW_UI_CREDENTIALS)
    : body;

  const before = settings.load();
  const merged = settings.save(filtered);
  const rescheduled = (before.autoRun !== merged.autoRun)
    || (before.intervalMinutes !== merged.intervalMinutes)
    || (before.intervalTimeFrom !== merged.intervalTimeFrom)
    || (before.intervalTimeTo !== merged.intervalTimeTo)
    || (before.scheduleMode !== merged.scheduleMode)
    || (JSON.stringify(before.scheduleDays) !== JSON.stringify(merged.scheduleDays))
    || (JSON.stringify(before.scheduleTimes) !== JSON.stringify(merged.scheduleTimes));

  // Bot neu-starten wenn Telegram-Config sich geändert hat
  const tgChanged = before.telegramEnabled !== merged.telegramEnabled
                 || before.telegramToken !== merged.telegramToken
                 || before.telegramAllowedUserId !== merged.telegramAllowedUserId;
  if (tgChanged) {
    try { bot.stop(); } catch (_) {}
    if (merged.telegramEnabled && merged.telegramToken && merged.telegramAllowedUserId) {
      bot.start({
        token: merged.telegramToken,
        allowedUserId: merged.telegramAllowedUserId,
        logger,
        triggerScrape: async () => {
          if (state.running) return { triggered: false, reason: 'bereits aktiv' };
          runScrapeCycle('telegram').catch(() => {});
          return { triggered: true };
        },
        getStatus: () => ({
          running: state.running,
          lastRun: state.lastRun,
          nextRun: state.nextRun,
          lastError: state.lastError,
          enabled: settings.load().autoRun,
          intervalMinutes: settings.load().intervalMinutes,
          currentPhase: state.currentPhase,
          phaseStartedAt: state.phaseStartedAt,
          lastStats: state.lastStats,
          lastWeeklyDetailAt: state.lastWeeklyDetailAt,
          nextWeeklyRun: state.weeklyTimer ? nextWeeklyDetailRun().toISOString() : null
        })
      }).catch(e => logger.log('Telegram-Bot Neustart fehlgeschlagen: ' + e.message, 'error'));
    }
  }

  res.json({
    settings: maskSettings(merged),
    rescheduled,
    botRestarted: tgChanged
  });
});

// ---------- Noten ----------
app.get('/api/noten', (req, res) => {
  const filters = {};

  if (req.query.semester != null) {
    const sem = String(req.query.semester);
    if (!/^S[0-9]{1,2}$/.test(sem)) return apiError(res, 400, 'Ungültiger semester-Parameter');
    filters.semester = sem;
  }
  if (req.query.sortBy != null) {
    const sortBy = String(req.query.sortBy);
    if (!['note', 'fetched', 'fach'].includes(sortBy)) {
      return apiError(res, 400, 'Ungültiger sortBy-Parameter');
    }
    filters.sortBy = sortBy;
  }
  if (req.query.hasNote === 'true') filters.hasNote = true;
  else if (req.query.hasNote === 'false') filters.hasNote = false;

  let database = null;
  try {
    database = db.open();
    const rows = db.getNoten(database, filters);
    const stats = db.getStats(database);
    const fetchedAt = stats.lastFetchedNoten || null;
    res.json({
      rows,
      count: rows.length,
      avg: stats.avgNote,
      bySemester: stats.avgBySemester,
      fetchedAt
    });
  } catch (e) {
    logger.log('DB error at GET /api/noten: ' + (e && e.message ? e.message : e), 'error');
    apiError(res, 500, 'Ein Datenbankfehler ist aufgetreten');
  } finally {
    if (database) try { database.close(); } catch (_) {}
  }
});

// ---------- Stundenplan: Cleanup (alle Einträge löschen) ----------
// Destruktive Aktion — wird vom UI-Button getriggert, dort gibt's eine
// Bestätigung. Token-Auth via Middleware ist bereits aktiv für /api/*.
app.post('/api/stundenplan/clear', (req, res) => {
  let database = null;
  try {
    database = db.open();
    const deleted = db.clearStundenplan(database);
    logger.log(`🧹 Stundenplan zurückgesetzt — ${deleted} Einträge gelöscht`, 'info');
    res.json({ deleted });
  } catch (e) {
    logger.log('DB error at POST /api/stundenplan/clear: ' + (e && e.message ? e.message : e), 'error');
    apiError(res, 500, 'Ein Datenbankfehler ist aufgetreten');
  } finally {
    if (database) try { database.close(); } catch (_) {}
  }
});

// ---------- Stundenplan ----------
app.get('/api/stundenplan', (req, res) => {
  const filters = {};
  const limitParam = parseInt(req.query.limit, 10);
  if (Number.isFinite(limitParam) && limitParam > 0) filters.limit = limitParam;

  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  if (req.query.from != null) {
    const f = String(req.query.from);
    if (!dateRe.test(f)) return apiError(res, 400, 'Ungültiger from-Parameter (YYYY-MM-DD erwartet)');
    filters.from = f;
  }
  if (req.query.to != null) {
    const t = String(req.query.to);
    if (!dateRe.test(t)) return apiError(res, 400, 'Ungültiger to-Parameter (YYYY-MM-DD erwartet)');
    filters.to = t;
  }

  let database = null;
  try {
    database = db.open();
    const rows = db.getStundenplan(database, filters);
    const stats = db.getStats(database);
    res.json({
      rows,
      count: rows.length,
      fetchedAt: stats.lastFetchedStundenplan || null
    });
  } catch (e) {
    logger.log('DB error at GET /api/stundenplan: ' + (e && e.message ? e.message : e), 'error');
    apiError(res, 500, 'Ein Datenbankfehler ist aufgetreten');
  } finally {
    if (database) try { database.close(); } catch (_) {}
  }
});

// ---------- History ----------
app.get('/api/history/:kuerzelId', (req, res) => {
  const id = req.params.kuerzelId;
  if (!id) return apiError(res, 400, 'kuerzelId fehlt');
  if (id.length > 128 || !/^[\w\-./:]+$/.test(id)) {
    return apiError(res, 400, 'Ungültige kuerzelId');
  }

  let database = null;
  try {
    database = db.open();
    const rows = db.getHistory(database, id);
    res.json({ rows });
  } catch (e) {
    logger.log('DB error at GET /api/history: ' + (e && e.message ? e.message : e), 'error');
    apiError(res, 500, 'Ein Datenbankfehler ist aufgetreten');
  } finally {
    if (database) try { database.close(); } catch (_) {}
  }
});

// ---------- Modul-Prüfungen (Detail-Noten LB/ZP/...) ----------
app.get('/api/noten/:kuerzelId/pruefungen', (req, res) => {
  const id = req.params.kuerzelId;
  if (!id) return apiError(res, 400, 'kuerzelId fehlt');
  if (id.length > 128 || !/^[\w\-./:]+$/.test(id)) {
    return apiError(res, 400, 'Ungültige kuerzelId');
  }

  let database = null;
  try {
    database = db.open();
    const rows = db.getPruefungen(database, id);
    // Modul-Note + detail_id für UI-Anzeige (berechneter Schnitt vs. Tocco-Schnitt)
    const modulRow = db.getNotenRow(database, id);
    res.json({
      rows,
      modulNote: modulRow ? modulRow.note : null,
      modulNoteRaw: modulRow ? modulRow.note_raw : null,
      detailId: modulRow ? modulRow.detail_id : null,
      fachName: modulRow ? modulRow.fach_name : null,
      fachCode: modulRow ? modulRow.fach_code : null,
      kuerzelCode: modulRow ? modulRow.kuerzel_code : null,
      kuerzelFull: modulRow ? modulRow.kuerzel_full : null,
      semester: modulRow ? modulRow.semester : null,
      typ: modulRow ? modulRow.typ : null
    });
  } catch (e) {
    logger.log('DB error at GET /api/noten/:id/pruefungen: ' + (e && e.message ? e.message : e), 'error');
    apiError(res, 500, 'Ein Datenbankfehler ist aufgetreten');
  } finally {
    if (database) try { database.close(); } catch (_) {}
  }
});

// ---------- Stats ----------
app.get('/api/stats', (req, res) => {
  let database = null;
  try {
    database = db.open();
    const stats = db.getStats(database);
    res.json(stats);
  } catch (e) {
    logger.log('DB error at GET /api/stats: ' + (e && e.message ? e.message : e), 'error');
    apiError(res, 500, 'Ein Datenbankfehler ist aufgetreten');
  } finally {
    if (database) try { database.close(); } catch (_) {}
  }
});

// ---------- Scrape-Trigger ----------
app.post('/api/scrape', scrapeLimiter, async (req, res) => {
  if (state.running) {
    return res.json({ triggered: false, reason: 'already_running' });
  }

  // Cooldown: 60s zwischen manuellen Triggern — auch für authorisierte User,
  // damit versehentliches Spammen nicht Login-Drosselung bei MS auslöst.
  const sinceLast = Date.now() - state.lastManualAt;
  if (state.lastManualAt && sinceLast < MANUAL_SCRAPE_COOLDOWN_MS) {
    const retryInSec = Math.ceil((MANUAL_SCRAPE_COOLDOWN_MS - sinceLast) / 1000);
    return res.status(429).json({
      triggered: false,
      reason: 'cooldown',
      retryInSec
    });
  }
  state.lastManualAt = Date.now();

  // Kick off; return immediately
  runScrapeCycle('manual').catch(() => { /* state.lastError is already set */ });
  res.json({ triggered: true });
});

// ---------- Web-Push (PWA) ----------
// VAPID public key — auch ohne Auth abrufbar wäre OK, aber wir lassen die
// globale auth-middleware drüber walten (kein Geheimnis, aber einheitlich).
app.get('/api/push/vapid-key', (req, res) => {
  if (!push) return apiError(res, 503, 'Web-Push nicht initialisiert');
  res.json({ publicKey: push.getPublicKey() });
});

app.post('/api/push/subscribe', pushLimiter, (req, res) => {
  if (!push) return apiError(res, 503, 'Web-Push nicht initialisiert');
  const sub = req.body && req.body.subscription;
  const reason = validatePushSubscription(sub);
  if (reason) {
    logger.log('⚠️  Push-Subscribe abgelehnt: ' + reason, 'warn');
    return apiError(res, 400, 'Ungültige Subscription: ' + reason);
  }
  const ua = (req.get('user-agent') || '').slice(0, 200);
  const d = db.open();
  try {
    push.addSubscription(d, sub, ua);
    const total = db.countPushSubscriptions(d);
    logger.log('🔔 Push-Subscription registriert (total ' + total + ')');
    res.json({ ok: true, total });
  } catch (e) {
    logger.log('⚠️  Push-Subscribe fehlgeschlagen: ' + (e && e.message), 'warn');
    apiError(res, 500, 'Subscription konnte nicht gespeichert werden');
  } finally {
    try { d.close(); } catch (_) {}
  }
});

app.delete('/api/push/subscribe', pushLimiter, (req, res) => {
  if (!push) return apiError(res, 503, 'Web-Push nicht initialisiert');
  const endpoint = req.body && req.body.endpoint;
  // Nur Format-Check — die Whitelist trifft nur für SUBSCRIBE zu (sonst kämen
  // Legacy-Endpoints nie wieder weg, falls die Allowlist mal enger wird).
  if (typeof endpoint !== 'string' || !endpoint || endpoint.length > 1024) {
    return apiError(res, 400, 'endpoint required');
  }
  const d = db.open();
  try {
    const removed = push.removeSubscription(d, endpoint);
    res.json({ ok: true, removed });
  } finally {
    try { d.close(); } catch (_) {}
  }
});

app.post('/api/push/test', pushLimiter, async (req, res) => {
  if (!push) return apiError(res, 503, 'Web-Push nicht initialisiert');
  try {
    const r = await push.sendToAll({
      title: 'Tocco Mate',
      body: 'Test-Benachrichtigung — alles läuft! ✓',
      url: '/mobile/',
      tag: 'test'
    });
    res.json({ ok: true, sent: r.sent, removed: r.removed });
  } catch (e) {
    apiError(res, 500, e && e.message ? e.message : 'Push-Test fehlgeschlagen');
  }
});

// ---------- Logs ----------
app.get('/api/logs', (req, res) => {
  const limit = parseInt(req.query.limit, 10);
  const logs = logger.getLogs(Number.isFinite(limit) && limit > 0 ? limit : 200);
  res.json({ logs });
});

// ---------- SSE Events ----------
app.get('/api/events', (req, res) => {
  if (sseClients.size >= SSE_MAX_CLIENTS) {
    return res.status(503).json({ error: 'Too many SSE clients' });
  }

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders?.();

  // Initialer Status-Push
  res.write(`event: status\ndata: ${JSON.stringify(statusPayload())}\n\n`);

  sseClients.add(res);

  // Keep-alive ping alle 15s
  const ping = setInterval(() => {
    try { res.write(': ping\n\n'); } catch (_) { /* ignore */ }
  }, 15000);

  req.on('close', () => {
    clearInterval(ping);
    sseClients.delete(res);
  });
});

// ---------- Static Web-UI Fallback ----------
const WEB_DIR = path.join(process.cwd(), 'web');
if (fs.existsSync(WEB_DIR)) {
  // .webmanifest MIME explizit setzen (Express/send kennt's evtl. nicht).
  // Service-Worker NIE cachen, sonst sieht der Browser SW-Updates nicht.
  app.use(express.static(WEB_DIR, {
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.webmanifest')) {
        res.setHeader('Content-Type', 'application/manifest+json; charset=utf-8');
      } else if (filePath.endsWith('sw.js')) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      }
    }
  }));
  // SPA-Fallback: alles was nicht /api/* ist → passende index.html
  // /mobile bzw. /mobile/* → web/mobile/index.html (eigene SPA mit Hash-Router)
  // alles andere → web/index.html (Dashboard)
  app.use((req, res, next) => {
    if (req.method !== 'GET') return next();
    if (req.path.startsWith('/api/')) return next();
    const isMobile = req.path === '/mobile' || req.path.startsWith('/mobile/');
    const indexPath = isMobile
      ? path.join(WEB_DIR, 'mobile', 'index.html')
      : path.join(WEB_DIR, 'index.html');
    if (fs.existsSync(indexPath)) return res.sendFile(indexPath);
    next();
  });
}

// ---------- Error Handler ----------
app.use((err, req, res, next) => {
  logger.log('❌ Unhandled: ' + (err && err.message ? err.message : err), 'error');
  if (res.headersSent) return next(err);
  apiError(res, 500, 'Interner Fehler');
});

// =============================================================
// Boot
// =============================================================

function bootBanner() {
  const s = settings.load();
  const masked = maskSettings(s);
  logger.log('─'.repeat(60), 'info');
  logger.log(`🎓 Tocco WISS Server gestartet`, 'info');
  logger.log(`   Port:           ${s.port}`, 'info');
  logger.log(`   autoRun:        ${s.autoRun}`, 'info');
  logger.log(`   intervalMin:    ${s.intervalMinutes}`, 'info');
  logger.log(`   email:          ${masked.emailSet ? 'gesetzt' : '(leer)'}`, 'info');
  logger.log(`   password:       ${masked.passwordSet ? 'gesetzt' : '(leer)'}`, 'info');
  logger.log(`   baseUrl:        ${s.baseUrl}`, 'info');
  logger.log(`   allowUiCreds:   ${ALLOW_UI_CREDENTIALS}`, 'info');
  logger.log(`   API-Token:      ${API_TOKEN_GENERATED ? 'auto-generiert (data/.api-token)' : 'env (API_TOKEN)'}`, 'info');
  logger.log(`   DB-Pfad:        ${path.join(DATA_DIR, 'tocco.db')}`, 'info');
  logger.log('─'.repeat(60), 'info');
}

const server = http.createServer(app);

const initial = settings.load();
server.listen(initial.port, '0.0.0.0', () => {
  bootBanner();
  logger.log(`🌍 Web-UI:  http://localhost:${initial.port}/`, 'info');
  logger.log(`🌍 LAN:      http://0.0.0.0:${initial.port}/  (auf allen Interfaces)`, 'info');
  if (initial.autoRun) {
    scheduleNext();
  } else {
    logger.log('ℹ️  autoRun=false → kein Auto-Scheduler. Trigger via POST /api/scrape oder Web-UI.', 'info');
  }

  // Wöchentlicher Detail-Refresh läuft IMMER, unabhängig von autoRun.
  // Findet neue ZP/LB die durch den Modulnoten-Push übersehen wurden
  // (Edge-Case ZP=5.5 + LB=5.5 → Schnitt unverändert).
  loadWeeklyDetailState();
  if (state.lastWeeklyDetailAt) {
    logger.log(`🗓️  Letzter Wochen-Check: ${formatLocalDateTime(state.lastWeeklyDetailAt)}`, 'info');
  }
  scheduleWeeklyDetailRefresh();

  // Telegram-Bot starten wenn aktiviert
  if (initial.telegramEnabled && initial.telegramToken && initial.telegramAllowedUserId) {
    bot.start({
      token: initial.telegramToken,
      allowedUserId: initial.telegramAllowedUserId,
      logger,
      triggerScrape: async () => {
        if (state.running) return { triggered: false, reason: 'bereits aktiv' };
        runScrapeCycle('telegram').catch(() => {});
        return { triggered: true };
      },
      getStatus: () => ({
        running: state.running,
        lastRun: state.lastRun,
        nextRun: state.nextRun,
        lastError: state.lastError,
        enabled: settings.load().autoRun,
        intervalMinutes: settings.load().intervalMinutes,
        currentPhase: state.currentPhase,
        phaseStartedAt: state.phaseStartedAt,
        lastStats: state.lastStats,
        lastWeeklyDetailAt: state.lastWeeklyDetailAt,
        nextWeeklyRun: (() => {
          if (!state.weeklyTimer) return null;
          // Approximation: rechne den nächsten Slot
          return nextWeeklyDetailRun().toISOString();
        })()
      })
    }).catch(e => logger.log('Telegram-Bot Start fehlgeschlagen: ' + e.message, 'error'));
  } else if (initial.telegramToken || initial.telegramAllowedUserId) {
    logger.log('ℹ️  Telegram teilweise konfiguriert — setze telegramEnabled=true, telegramToken, telegramAllowedUserId um zu aktivieren.', 'info');
  }
});

// =============================================================
// Graceful Shutdown
// =============================================================

let shuttingDown = false;

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.log(`🛑 ${signal} empfangen — fahre Server runter...`, 'warn');
  clearTimer();
  clearWeeklyTimer();
  try { bot.stop(); } catch (_) {}

  // SSE-Clients beenden
  for (const client of sseClients) {
    try { client.end(); } catch (_) {}
  }
  sseClients.clear();

  server.close(() => {
    logger.log('👋 Server geschlossen.', 'info');
    process.exit(0);
  });

  // Fallback: harter Exit nach 5s
  setTimeout(() => {
    logger.log('⏳ Forced exit nach 5s', 'warn');
    process.exit(1);
  }, 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => {
  logger.log('❌ unhandledRejection: ' + (reason && reason.message ? reason.message : reason), 'error');
});
process.on('uncaughtException', (err) => {
  logger.log('❌ uncaughtException: ' + (err && err.message ? err.message : err), 'error');
});
