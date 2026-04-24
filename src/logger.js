/**
 * logger.js — In-Memory Ring-Buffer + Pub/Sub-Logger.
 *
 * Buffer: Letzte 500 Entries. Entry-Form: { ts, level, message }.
 * Levels: 'info' | 'warn' | 'error' | 'progress'.
 *
 * API:
 *   log(message, level='info')    → fügt Eintrag hinzu, printed stdout, emits
 *   getLogs(limit=200)            → Array (neueste am Ende)
 *   subscribe(listener)           → returns unsubscribe fn
 *   clear()                       → leert Buffer
 */

const MAX_ENTRIES = 500;

// ---------- ANSI Farben ----------
const COLORS = {
  info:     '\x1b[36m',  // cyan
  warn:     '\x1b[33m',  // yellow
  error:    '\x1b[31m',  // red
  progress: '\x1b[90m',  // gray
  reset:    '\x1b[0m'
};

const LEVELS = new Set(['info', 'warn', 'error', 'progress']);

// ---------- State ----------
const buffer = [];           // FIFO: neueste am Ende
const listeners = new Set();

// ---------- Helpers ----------
function normalizeLevel(level) {
  return LEVELS.has(level) ? level : 'info';
}

function normalizeMessage(msg) {
  if (msg == null) return '';
  if (typeof msg === 'string') return msg;
  if (msg instanceof Error) return msg.stack || msg.message || String(msg);
  try { return JSON.stringify(msg); } catch (_) { return String(msg); }
}

function printEntry(entry) {
  const color = COLORS[entry.level] || COLORS.info;
  const time = entry.ts.slice(11, 19); // HH:MM:SS
  const tag = entry.level.toUpperCase().padEnd(8);
  // progress-Zeilen bleiben in stdout lesbar, aber gedimmt
  process.stdout.write(`${color}[${time}] ${tag}${COLORS.reset} ${entry.message}\n`);
}

function emit(entry) {
  for (const l of listeners) {
    try { l(entry); } catch (_) { /* listener-Fehler isolieren */ }
  }
}

// ---------- Public API ----------
function log(message, level = 'info') {
  const entry = {
    ts: new Date().toISOString(),
    level: normalizeLevel(level),
    message: normalizeMessage(message)
  };
  buffer.push(entry);
  if (buffer.length > MAX_ENTRIES) buffer.splice(0, buffer.length - MAX_ENTRIES);
  printEntry(entry);
  emit(entry);
  return entry;
}

function getLogs(limit = 200) {
  const n = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 200;
  if (buffer.length <= n) return buffer.slice();
  return buffer.slice(buffer.length - n);
}

function subscribe(listener) {
  if (typeof listener !== 'function') return () => {};
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function clear() {
  buffer.length = 0;
}

module.exports = { log, getLogs, subscribe, clear };
