/**
 * settings.js — Persistente Server-Settings.
 *
 * Merge-Reihenfolge (niedrig → hoch):
 *   1. Hardcoded Defaults
 *   2. .env (MS_EMAIL, MS_PASSWORD, USER_PK, ...)
 *   3. settings.json (vom User via Web-UI editiert)
 *
 * Sicherheits-Allowlists:
 *   ALLOWED_UI_KEYS             — darf von /api/settings PATCH immer geändert werden
 *   ALLOWED_UI_CREDENTIAL_KEYS  — zusätzliche Keys wenn ALLOW_UI_CREDENTIALS=true
 *   URL-/Port-Keys              — env-only, PATCH wird ignoriert
 *
 * API:
 *   load()               → merged settings object
 *   save(patch)          → merged settings object (schreibt settings.json)
 *   subscribe(listener)  → unsubscribe fn; listener(new, old)
 *   getDefaults()        → hardcoded defaults
 *   filterUiPatch(body, allowCredentials) → gefilterter Patch für PATCH-Route
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DATA_DIR = path.join(process.cwd(), 'data');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const ENV_FILE = path.join(process.cwd(), '.env');

// ---------- Defaults ----------
const DEFAULTS = Object.freeze({
  msEmail: '',
  msPassword: '',
  userPk: '',
  baseUrl: 'https://wiss.tocco.ch',
  notenUrl: 'https://wiss.tocco.ch/extranet/Meine-Bildung/Noten-f%C3%BCr-Studierende',
  stundenplanUrl: 'https://wiss.tocco.ch/extranet/Meine-Bildung/Stundenplan-f%C3%BCr-Studierende',
  // Scheduler
  scheduleMode: 'interval',           // 'interval' | 'weekly'
  scheduleDays: [1, 2, 3, 4, 5],      // beide Modi: 0=So .. 6=Sa
  // Interval-Mode
  intervalMinutes: 60,
  intervalTimeFrom: '08:00',          // Zeitfenster Start (HH:MM)
  intervalTimeTo: '20:00',            // Zeitfenster Ende   (HH:MM)
  // Weekly-Mode
  scheduleTimes: ['08:00', '16:00'],
  autoRun: false,
  headless: true,
  slowMo: 0,
  port: 3000,
  telegramEnabled: false,
  telegramToken: '',
  telegramAllowedUserId: null
});

// ---------- Allowlists ----------
// Keys, die das Web-UI IMMER per PATCH /api/settings setzen darf.
const ALLOWED_UI_KEYS = Object.freeze([
  'autoRun',
  'intervalMinutes',
  'intervalTimeFrom',
  'intervalTimeTo',
  'scheduleMode',
  'scheduleDays',
  'scheduleTimes',
  'headless',
  'slowMo',
  'telegramEnabled',
  'telegramAllowedUserId'
]);

// Zusätzliche Keys wenn ALLOW_UI_CREDENTIALS=true.
const ALLOWED_UI_CREDENTIAL_KEYS = Object.freeze([
  'msEmail',
  'msPassword',
  'telegramToken',
  'userPk'
]);

// URL- und Port-Keys sind env-only und werden aus PATCH silent gedroppt.
const ENV_ONLY_KEYS = Object.freeze([
  'baseUrl',
  'notenUrl',
  'stundenplanUrl',
  'port'
]);

// Optionaler Logger-Hook (von server.js injiziert) für Warnungen.
let _logger = null;
function setLogger(logger) {
  if (logger && typeof logger.log === 'function') {
    _logger = logger;
  }
}

function warn(msg) {
  if (_logger) {
    try { _logger.log(msg, 'warn'); } catch (_) { /* ignore */ }
  }
}

// ---------- .env Loader ----------
function loadEnv() {
  // Mergen: process.env überschreibt optionale .env-Datei, damit Docker-ENV
  // immer gewinnt, aber Lokal-Dev weiter funktioniert.
  const out = {};
  if (fs.existsSync(ENV_FILE)) {
    try {
      fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/).forEach(line => {
        const t = line.trim();
        if (!t || t.startsWith('#')) return;
        const m = t.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/i);
        if (!m) return;
        let v = m[2];
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
          v = v.slice(1, -1);
        }
        out[m[1]] = v;
      });
    } catch (_) {
      // .env nicht lesbar → ignorieren, Defaults greifen
    }
  }
  // process.env überschreibt (Docker-freundlich)
  const ENV_KEYS = [
    'MS_EMAIL','MS_PASSWORD','USER_PK','TOCCO_BASE','NOTEN_URL','STUNDENPLAN_URL',
    'HEADLESS','SLOW_MO','INTERVAL_MINUTES','AUTO_RUN','PORT',
    'TELEGRAM_TOKEN','TELEGRAM_ALLOWED_USER_ID','TELEGRAM_ENABLED'
  ];
  for (const k of ENV_KEYS) {
    if (process.env[k] != null && process.env[k] !== '') {
      out[k] = process.env[k];
    }
  }
  return out;
}

// ---------- Env → Settings-Shape ----------
function envToSettings(env) {
  const s = {};
  if (env.MS_EMAIL) s.msEmail = env.MS_EMAIL;
  if (env.MS_PASSWORD) s.msPassword = env.MS_PASSWORD;
  if (env.USER_PK) s.userPk = env.USER_PK;
  if (env.TOCCO_BASE) s.baseUrl = env.TOCCO_BASE;
  if (env.NOTEN_URL) s.notenUrl = env.NOTEN_URL;
  if (env.STUNDENPLAN_URL) s.stundenplanUrl = env.STUNDENPLAN_URL;
  if (env.HEADLESS != null) s.headless = env.HEADLESS !== 'false';
  if (env.SLOW_MO != null) {
    const n = parseInt(env.SLOW_MO, 10);
    if (!Number.isNaN(n)) s.slowMo = n;
  }
  if (env.INTERVAL_MINUTES != null) {
    const n = parseInt(env.INTERVAL_MINUTES, 10);
    if (!Number.isNaN(n) && n > 0) s.intervalMinutes = n;
  }
  if (env.AUTO_RUN != null) s.autoRun = env.AUTO_RUN === 'true';
  if (env.PORT != null) {
    const n = parseInt(env.PORT, 10);
    if (!Number.isNaN(n) && n > 0) s.port = n;
  }
  if (env.TELEGRAM_TOKEN) s.telegramToken = env.TELEGRAM_TOKEN;
  if (env.TELEGRAM_ALLOWED_USER_ID != null) {
    const n = parseInt(env.TELEGRAM_ALLOWED_USER_ID, 10);
    if (!Number.isNaN(n)) s.telegramAllowedUserId = n;
  }
  if (env.TELEGRAM_ENABLED != null) s.telegramEnabled = env.TELEGRAM_ENABLED === 'true';
  return s;
}

// ---------- settings.json Loader ----------
function readSettingsFile() {
  if (!fs.existsSync(SETTINGS_FILE)) return {};
  try {
    const raw = fs.readFileSync(SETTINGS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
  } catch (_) {
    return {};
  }
}

function writeSettingsFile(obj) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(obj, null, 2), { encoding: 'utf8', mode: 0o600 });
  // chmod explizit, falls die Datei bereits existierte (writeFileSync "mode" gilt
  // nur bei Neuanlage). Auf Windows ignoriert der OS den Modus weitgehend,
  // daher try/catch.
  try { fs.chmodSync(SETTINGS_FILE, 0o600); } catch (_) { /* Windows compat */ }
}

// ---------- Coercion ----------
// Bringt Werte aus .env/JSON in die erwarteten Typen (Schutz vor "true"/"false" Strings etc.)
// ENTFERNT Keys, die nicht in DEFAULTS definiert sind (strip unknown / proto pollution).
function coerce(patch) {
  // Start mit null-Prototyp damit __proto__/constructor-Tricks nicht greifen.
  const out = Object.create(null);
  if (!patch || typeof patch !== 'object') return out;

  // Nur bekannte Keys übernehmen.
  const knownKeys = new Set(Object.keys(DEFAULTS));
  for (const k of Object.keys(patch)) {
    if (knownKeys.has(k)) out[k] = patch[k];
  }

  if ('intervalMinutes' in out) {
    const n = Number(out.intervalMinutes);
    out.intervalMinutes = (Number.isFinite(n) && n > 0) ? Math.floor(n) : DEFAULTS.intervalMinutes;
  }
  if ('slowMo' in out) {
    const n = Number(out.slowMo);
    out.slowMo = (Number.isFinite(n) && n >= 0) ? Math.floor(n) : 0;
  }
  if ('port' in out) {
    const n = Number(out.port);
    out.port = (Number.isFinite(n) && n > 0) ? Math.floor(n) : DEFAULTS.port;
  }
  if ('autoRun' in out) out.autoRun = Boolean(out.autoRun);
  if ('headless' in out) out.headless = Boolean(out.headless);
  if ('telegramEnabled' in out) out.telegramEnabled = Boolean(out.telegramEnabled);
  if ('scheduleMode' in out) {
    out.scheduleMode = (out.scheduleMode === 'weekly') ? 'weekly' : 'interval';
  }
  if ('scheduleDays' in out) {
    if (!Array.isArray(out.scheduleDays)) out.scheduleDays = [];
    out.scheduleDays = out.scheduleDays
      .map(n => Number(n))
      .filter(n => Number.isInteger(n) && n >= 0 && n <= 6);
    out.scheduleDays = [...new Set(out.scheduleDays)].sort((a, b) => a - b);
  }
  if ('scheduleTimes' in out) {
    if (!Array.isArray(out.scheduleTimes)) out.scheduleTimes = [];
    out.scheduleTimes = out.scheduleTimes
      .map(t => String(t || '').trim())
      .filter(t => /^\d{1,2}:\d{2}$/.test(t))
      .map(t => {
        const [h, m] = t.split(':').map(n => parseInt(n, 10));
        if (h < 0 || h > 23 || m < 0 || m > 59) return null;
        return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
      })
      .filter(Boolean);
    out.scheduleTimes = [...new Set(out.scheduleTimes)].sort();
  }
  for (const k of ['intervalTimeFrom', 'intervalTimeTo']) {
    if (k in out) {
      const v = String(out[k] || '').trim();
      if (/^\d{1,2}:\d{2}$/.test(v)) {
        const [h, m] = v.split(':').map(n => parseInt(n, 10));
        if (h >= 0 && h <= 23 && m >= 0 && m <= 59) {
          out[k] = String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
        } else {
          out[k] = DEFAULTS[k];
        }
      } else {
        out[k] = DEFAULTS[k];
      }
    }
  }
  if ('telegramAllowedUserId' in out) {
    if (out.telegramAllowedUserId == null || out.telegramAllowedUserId === '') {
      out.telegramAllowedUserId = null;
    } else {
      const n = Number(out.telegramAllowedUserId);
      out.telegramAllowedUserId = (Number.isFinite(n) && n > 0) ? Math.floor(n) : null;
    }
  }
  for (const k of ['msEmail', 'msPassword', 'userPk', 'baseUrl', 'notenUrl', 'stundenplanUrl', 'telegramToken']) {
    if (k in out && out[k] != null) out[k] = String(out[k]);
  }
  return out;
}

// ---------- UI-Patch Filter ----------
// Wendet Allowlist an, bevor der Patch an save() gegeben wird.
// Entfernt unerlaubte Keys still; loggt eine Warnung wenn etwas gedroppt wurde.
function filterUiPatch(body, allowCredentials) {
  const safe = Object.create(null);
  if (!body || typeof body !== 'object') return safe;

  const allowed = new Set(ALLOWED_UI_KEYS);
  if (allowCredentials) {
    for (const k of ALLOWED_UI_CREDENTIAL_KEYS) allowed.add(k);
  }

  const dropped = [];
  for (const k of Object.keys(body)) {
    // Proto-pollution Schutz
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    if (allowed.has(k)) {
      safe[k] = body[k];
    } else {
      // URL-/Port-Keys: silent drop (env-only).
      // Credential-Keys bei allowCredentials=false: warn.
      if (ENV_ONLY_KEYS.includes(k)) {
        // silent
      } else if (ALLOWED_UI_CREDENTIAL_KEYS.includes(k) && !allowCredentials) {
        dropped.push(k);
      } else {
        // Unbekannter Key → silent (coerce würde ihn ohnehin strippen).
      }
    }
  }

  if (dropped.length) {
    warn('⚠️  /api/settings: ' + dropped.length + ' credential-Key(s) gedroppt (ALLOW_UI_CREDENTIALS=false): ' + dropped.join(', '));
  }

  // Secret-Guard: leere Strings für Secrets NICHT persistieren (sonst werden
  // gesetzte Passwörter durch ein leeres Form-Feld überschrieben).
  if ('msPassword' in safe && (typeof safe.msPassword !== 'string' || safe.msPassword.length === 0)) {
    delete safe.msPassword;
  }
  if ('telegramToken' in safe && (typeof safe.telegramToken !== 'string' || safe.telegramToken.length === 0)) {
    delete safe.telegramToken;
  }

  return safe;
}

// ---------- Kern-Merge ----------
function computeMerged() {
  const env = loadEnv();
  const fromEnv = envToSettings(env);
  const fromFile = readSettingsFile();
  const merged = {
    ...DEFAULTS,
    ...coerce(fromEnv),
    ...coerce(fromFile)
  };
  return merged;
}

// ---------- Subscriber ----------
const listeners = new Set();

function emit(newSettings, oldSettings) {
  for (const l of listeners) {
    try { l(newSettings, oldSettings); }
    catch (_) { /* listener-Fehler dürfen andere Listener nicht stoppen */ }
  }
}

function subscribe(listener) {
  if (typeof listener !== 'function') return () => {};
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// ---------- Public API ----------
function load() {
  return computeMerged();
}

function save(patch) {
  const oldMerged = computeMerged();

  const fileState = readSettingsFile();
  const cleanPatch = coerce(patch || {});
  const newFileState = { ...fileState, ...cleanPatch };

  try {
    writeSettingsFile(newFileState);
  } catch (e) {
    warn('⚠️  settings.json konnte nicht geschrieben werden: ' + (e && e.message ? e.message : e));
    // Werfen wäre Rückwärts-inkompatibel; Aufrufer bekommt trotzdem merged
    // settings (aus Speicher), aber die Persistenz ist fehlgeschlagen.
  }

  const newMerged = computeMerged();
  emit(newMerged, oldMerged);
  return newMerged;
}

function getDefaults() {
  return { ...DEFAULTS };
}

module.exports = {
  load,
  save,
  subscribe,
  getDefaults,
  setLogger,
  filterUiPatch,
  ALLOWED_UI_KEYS,
  ALLOWED_UI_CREDENTIAL_KEYS,
  ENV_ONLY_KEYS
};
