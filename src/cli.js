#!/usr/bin/env node
/**
 * Tocco WISS CLI mit automatischem MS-SSO-Login.
 *
 * Setup (einmalig):
 *   cd tocco-mate
 *   npm install
 *   npx playwright install chromium
 *   cp .env.example .env        # Windows: copy .env.example .env
 *   (MS_EMAIL + MS_PASSWORD in .env eintragen)
 *
 * Start:
 *   npm start                   # oder: node cli.js
 *
 * Was es tut:
 *   1. Liest .env
 *   2. Delegiert Login + Scraping an scraper.js (reusable Modul)
 *   3. Rendert hübsch im Terminal
 *   4. Speichert Daten in SQLite (data/tocco.db)
 */

const fs = require('node:fs');
const path = require('node:path');
const db = require('./db');
const scraper = require('./scraper');

// ---------- .env Loader ----------
function loadEnv() {
  const p = path.join(process.cwd(), '.env');
  if (!fs.existsSync(p)) return {};
  const out = {};
  fs.readFileSync(p, 'utf8').split(/\r?\n/).forEach(line => {
    const t = line.trim();
    if (!t || t.startsWith('#')) return;
    const m = t.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/i);
    if (!m) return;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  });
  return out;
}

// ---------- Rendering ----------
function pad(s, n) {
  s = String(s == null ? '' : s);
  return s.length >= n ? s.slice(0, n - 1) + '…' : s + ' '.repeat(n - s.length);
}

function renderNoten(entries) {
  console.log('\n📚 NOTEN  (' + entries.length + ')');
  console.log('─'.repeat(100));
  if (!entries.length) { console.log('  (keine gefunden)'); return; }
  console.log('  ' + pad('Fach', 60) + ' ' + pad('Typ', 12) + ' ' + 'Note');
  console.log('  ' + '─'.repeat(60) + ' ' + '─'.repeat(12) + ' ' + '─'.repeat(6));
  entries.forEach(e => {
    // Fach-Name aus Prefix rausziehen falls möglich
    const cleanFach = (e.fach || '').replace(/^[A-Z]{2}-[A-Z]{2}-[A-Z0-9-]+\s/, '');
    console.log('  ' + pad(cleanFach || e.fach, 60) + ' ' + pad(e.typ, 12) + ' ' + e.note);
  });
}

function renderStundenplan(entries) {
  console.log('\n📅 STUNDENPLAN  (' + entries.length + ')');
  console.log('─'.repeat(100));
  if (!entries.length) { console.log('  (keine gefunden)'); return; }
  console.log('  ' + pad('Datum', 10) + ' ' + pad('Zeit', 15) + ' ' + pad('Raum', 22) + ' ' + pad('Dozent', 22) + ' ' + 'Veranstaltung');
  console.log('  ' + '─'.repeat(10) + ' ' + '─'.repeat(15) + ' ' + '─'.repeat(22) + ' ' + '─'.repeat(22) + ' ' + '─'.repeat(30));
  entries.forEach(e => {
    console.log('  ' + pad(e.datum, 10) + ' ' + pad(e.zeit, 15) + ' ' + pad(e.raum, 22) + ' ' + pad(e.dozent, 22) + ' ' + (e.veranstaltung || ''));
  });
}

// ---------- Log-Callback ----------
// Mappt scraper-Log-Events auf stdout. 'progress' überschreibt die aktuelle Zeile
// (wie zuvor bei "Daten werden übertragen..."), andere Level schreiben normale Zeilen.
let progressActive = false;
function onLog(message, level) {
  if (level === 'progress') {
    process.stdout.write('\r' + message + '     ');
    progressActive = true;
    return;
  }
  if (progressActive) {
    process.stdout.write('\r' + ' '.repeat(80) + '\r');
    progressActive = false;
  }
  if (level === 'error') {
    console.error(message);
  } else {
    console.log(message);
  }
}

// ---------- Main ----------
async function main() {
  const env = { ...loadEnv(), ...process.env };
  const baseUrl = env.TOCCO_BASE || 'https://wiss.tocco.ch';
  const userPk = env.USER_PK || '';
  const headless = env.HEADLESS !== 'false';
  const slowMo = parseInt(env.SLOW_MO || '0', 10);

  const dataDir = path.join(process.cwd(), 'data');
  fs.mkdirSync(dataDir, { recursive: true });

  const config = {
    msEmail: env.MS_EMAIL,
    msPassword: env.MS_PASSWORD,
    userPk,
    notenUrl: env.NOTEN_URL || 'https://wiss.tocco.ch/extranet/Meine-Bildung/Noten-f%C3%BCr-Studierende',
    stundenplanUrl: env.STUNDENPLAN_URL || 'https://wiss.tocco.ch/extranet/Meine-Bildung/Stundenplan-f%C3%BCr-Studierende',
    baseUrl,
    headless,
    slowMo,
    storageFile: path.join(dataDir, 'storage.json'),
    cwd: dataDir
  };

  console.log('🎓 Tocco WISS CLI  ·  User-PK=' + userPk);

  const result = await scraper.runScrape(config, onLog);
  const { noten, stundenplan, rawText, fetchedAt } = result;

  renderNoten(noten);
  renderStundenplan(stundenplan);

  // SQLite
  const database = db.open(path.join(dataDir, 'tocco.db'));
  try {
    const nStats = db.saveNoten(database, noten);
    const sStats = db.saveStundenplan(database, stundenplan);
    const pruned = db.pruneVergangen(database);
    console.log('\n🗄️  DB → data/tocco.db');
    console.log('    Noten:        ' + nStats.inserted + ' neu, ' + nStats.updated + ' aktualisiert, ' + nStats.changed + ' Note geändert');
    console.log('    Stundenplan:  ' + sStats.inserted + ' neu, ' + sStats.updated + ' aktualisiert' + (pruned ? ', ' + pruned + ' vergangen entfernt' : ''));
  } finally {
    database.close();
  }
}

main().catch(e => {
  console.error('❌ Fehler: ' + (e && e.message ? e.message : e));
  if (e && e.stack && process.env.DEBUG) console.error(e.stack);
  process.exit(1);
});
