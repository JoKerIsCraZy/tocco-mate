/**
 * SQLite-Schicht für Tocco Mate — nutzt Nodes eingebautes node:sqlite (Node 22.5+).
 * Keine npm-Dependency, keine Build-Tools nötig.
 */

const path = require('node:path');
const fs = require('node:fs');
let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (e) {
  console.error('❌ node:sqlite nicht verfügbar. Node 22.5+ nötig.');
  console.error('   Führe das Script mit "npm start" aus (nutzt --experimental-sqlite).');
  console.error('   Oder direkt: node --experimental-sqlite cli.js');
  throw e;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS noten (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  kuerzel_id    TEXT NOT NULL UNIQUE,
  fach_code     TEXT,
  fach_name     TEXT,
  kuerzel_full  TEXT,
  kuerzel_code  TEXT,
  semester      TEXT,
  typ           TEXT,
  note          REAL,
  note_raw      TEXT,
  detail_id     TEXT,
  fetched_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_noten_fetched   ON noten(fetched_at);
CREATE INDEX IF NOT EXISTS idx_noten_semester  ON noten(semester);
-- idx_noten_detail wird nach der ALTER-Migration angelegt (siehe open()),
-- sonst schlägt CREATE INDEX auf bestehenden DBs fehl, in denen die
-- Spalte noch nicht existiert.

CREATE TABLE IF NOT EXISTS noten_history (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  kuerzel_id    TEXT NOT NULL,
  fach_name     TEXT,
  note          REAL,
  note_raw      TEXT,
  recorded_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_hist_kuerzel ON noten_history(kuerzel_id, recorded_at);

-- Prüfungen pro Modul (LB / ZP / OTHER) — Detail-Scrape Result.
-- Ein Modul kann 0..n LB UND 0..n ZP haben, deshalb pruefung_typ als Spalte
-- statt zwei separate Tabellen.
CREATE TABLE IF NOT EXISTS noten_pruefungen (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  kuerzel_id    TEXT NOT NULL,
  pruefung_typ  TEXT NOT NULL,
  pruefung_nr   INTEGER NOT NULL,
  bezeichnung   TEXT,
  gewicht       TEXT,
  gewicht_pct   REAL,
  bewertung     REAL,
  bewertung_raw TEXT,
  fetched_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(kuerzel_id, pruefung_typ, pruefung_nr)
);

CREATE INDEX IF NOT EXISTS idx_pruef_kuerzel ON noten_pruefungen(kuerzel_id);

CREATE TABLE IF NOT EXISTS stundenplan (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  datum_iso     TEXT NOT NULL,
  zeit_von      TEXT,
  zeit_bis      TEXT,
  raum          TEXT,
  dozent        TEXT,
  klasse        TEXT,
  veranstaltung TEXT,
  fetched_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(datum_iso, zeit_von, veranstaltung, klasse)
);

CREATE INDEX IF NOT EXISTS idx_sp_datum   ON stundenplan(datum_iso);
CREATE INDEX IF NOT EXISTS idx_sp_dozent  ON stundenplan(dozent);
CREATE INDEX IF NOT EXISTS idx_sp_klasse  ON stundenplan(klasse);
`;

// SQLite kann ALTER TABLE ADD COLUMN nicht "IF NOT EXISTS" — daher prüfen
// wir vor dem ALTER, ob die Spalte schon existiert. Macht den Aufruf idempotent
// (Re-Open einer bereits migrierten DB ist no-op).
function ensureColumn(db, table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (cols.some(c => c.name === column)) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  return true;
}

function open(filename) {
  const dataDir = path.join(process.cwd(), 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const dbPath = filename || path.join(dataDir, 'tocco.db');
  const d = new DatabaseSync(dbPath);
  const run = (sql) => d.exec(sql);
  run('PRAGMA journal_mode = WAL');
  run('PRAGMA foreign_keys = ON');
  run(SCHEMA);

  // Migrations für bestehende DBs (CREATE TABLE IF NOT EXISTS triggert kein ALTER).
  ensureColumn(d, 'noten', 'detail_id', 'detail_id TEXT');
  // detail_scraped_at: Cooldown für Detail-Scrape-Versuche — verhindert dass
  // Module mit 0 Prüfungen (parse-fail oder leere Tocco-Seite) bei jedem
  // Cycle erneut gescrapt werden.
  ensureColumn(d, 'noten', 'detail_scraped_at', 'detail_scraped_at DATETIME');
  // Index NACH der Migration anlegen — sonst schlägt das auf alten DBs fehl,
  // in denen detail_id noch nicht existiert.
  d.exec('CREATE INDEX IF NOT EXISTS idx_noten_detail ON noten(detail_id)');

  // Daten-Migration: re-klassifiziert OTHER-Einträge die mit "LB"/"ZP" beginnen.
  // Frühere classifyPruefung-Version war zu strikt — Bezeichnungen wie "LB"
  // (ohne Zahl) oder "LB Praxisarbeit" landeten in OTHER. Ist idempotent
  // (zweiter Lauf findet nichts mehr).
  reclassifyOtherPruefungen(d);

  return d;
}

function parseFach(fach) {
  const m = (fach || '').match(/^([A-Z0-9-]+)\s+(.+)$/);
  if (!m) return { code: '', name: fach || '' };
  return { code: m[1], name: m[2] };
}

function parseKuerzel(kuerzel) {
  const parts = (kuerzel || '').split(/\s*\/\s*/);
  const id = parts[0] || '';
  const code = parts[1] || '';
  const sem = code.match(/-S(\d+)-/);
  return {
    id,
    code,
    label: parts.slice(2).join(' / '),
    semester: sem ? 'S' + sem[1] : null
  };
}

function parseNote(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const clean = raw.trim().replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(clean)) return null;
  return parseFloat(clean);
}

function parseDatum(ddmmyy) {
  const m = (ddmmyy || '').match(/^(\d{2})\.(\d{2})\.(\d{2,4})$/);
  if (!m) return ddmmyy || '';
  const year = m[3].length === 2 ? '20' + m[3] : m[3];
  return year + '-' + m[2] + '-' + m[1];
}

function parseZeit(zeit) {
  const m = (zeit || '').match(/(\d{2}:\d{2})\s*[–-]\s*(\d{2}:\d{2})/);
  if (!m) return { von: '', bis: '' };
  return { von: m[1], bis: m[2] };
}

const UPSERT_NOTEN_SQL = `
INSERT INTO noten
  (kuerzel_id, fach_code, fach_name, kuerzel_full, kuerzel_code, semester, typ, note, note_raw, fetched_at)
VALUES
  (:kuerzel_id, :fach_code, :fach_name, :kuerzel_full, :kuerzel_code, :semester, :typ, :note, :note_raw, CURRENT_TIMESTAMP)
ON CONFLICT(kuerzel_id) DO UPDATE SET
  fach_code    = :fach_code,
  fach_name    = :fach_name,
  kuerzel_full = :kuerzel_full,
  kuerzel_code = :kuerzel_code,
  semester     = :semester,
  typ          = :typ,
  note         = :note,
  note_raw     = :note_raw,
  fetched_at   = CURRENT_TIMESTAMP
`;

const UPSERT_SP_SQL = `
INSERT INTO stundenplan
  (datum_iso, zeit_von, zeit_bis, raum, dozent, klasse, veranstaltung, fetched_at)
VALUES
  (:datum_iso, :zeit_von, :zeit_bis, :raum, :dozent, :klasse, :veranstaltung, CURRENT_TIMESTAMP)
ON CONFLICT(datum_iso, zeit_von, veranstaltung, klasse) DO UPDATE SET
  zeit_bis   = :zeit_bis,
  raum       = :raum,
  dozent     = :dozent,
  fetched_at = CURRENT_TIMESTAMP
`;

function saveNoten(db, entries) {
  const upsert = db.prepare(UPSERT_NOTEN_SQL);
  const getPrev = db.prepare('SELECT note, note_raw FROM noten WHERE kuerzel_id = ?');
  const insertHist = db.prepare(
    'INSERT INTO noten_history (kuerzel_id, fach_name, note, note_raw) VALUES (?, ?, ?, ?)'
  );

  // gradeChanges listet nur Änderungen am Note-Wert selbst (relevant für Push-Notifications).
  // "new" = Eintrag erstmalig mit Note; "changed" = Note-Wert hat sich verändert.
  const stats = { inserted: 0, updated: 0, changed: 0, gradeChanges: [] };

  db.exec('BEGIN');
  try {
    for (const e of entries) {
      const fach = parseFach(e.fach);
      const kuerzel = parseKuerzel(e.kuerzel);
      if (!kuerzel.id) continue;

      const note = parseNote(e.note);
      const row = {
        kuerzel_id: kuerzel.id,
        fach_code: fach.code,
        fach_name: fach.name,
        kuerzel_full: e.kuerzel || '',
        kuerzel_code: kuerzel.code,
        semester: kuerzel.semester,
        typ: e.typ || '',
        note,
        note_raw: e.note || ''
      };

      const prev = getPrev.get(kuerzel.id);
      upsert.run(row);

      if (!prev) {
        stats.inserted++;
        if (note != null) {
          stats.gradeChanges.push({
            type: 'new',
            kuerzel_id: kuerzel.id,
            kuerzel_code: kuerzel.code,
            fach_name: fach.name,
            semester: kuerzel.semester,
            prev_note: null,
            new_note: note
          });
        }
        insertHist.run(kuerzel.id, fach.name, note, row.note_raw);
      } else {
        stats.updated++;
        const noteChanged = prev.note !== note;
        const rawChanged = prev.note_raw !== row.note_raw;
        if (noteChanged) {
          stats.gradeChanges.push({
            type: prev.note == null ? 'new' : 'changed',
            kuerzel_id: kuerzel.id,
            kuerzel_code: kuerzel.code,
            fach_name: fach.name,
            semester: kuerzel.semester,
            prev_note: prev.note,
            new_note: note
          });
        }
        if (noteChanged || rawChanged) {
          stats.changed++;
          insertHist.run(kuerzel.id, fach.name, note, row.note_raw);
        }
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return stats;
}

function saveStundenplan(db, entries) {
  const upsert = db.prepare(UPSERT_SP_SQL);
  const getPrev = db.prepare(
    'SELECT raum, dozent FROM stundenplan WHERE datum_iso=? AND zeit_von=? AND veranstaltung=? AND klasse=?'
  );

  const stats = { inserted: 0, updated: 0, roomChanges: [] };

  db.exec('BEGIN');
  try {
    for (const e of entries) {
      const zeit = parseZeit(e.zeit);
      const row = {
        datum_iso: parseDatum(e.datum),
        zeit_von: zeit.von,
        zeit_bis: zeit.bis,
        raum: e.raum || '',
        dozent: e.dozent || '',
        klasse: e.klasse || '',
        veranstaltung: e.veranstaltung || ''
      };
      if (!row.datum_iso) continue;

      const prev = getPrev.get(row.datum_iso, row.zeit_von, row.veranstaltung, row.klasse);
      upsert.run(row);

      if (prev) {
        stats.updated++;
        // Raum-Änderung detektieren
        const prevRaum = (prev.raum || '').trim();
        const newRaum = row.raum.trim();
        if (prevRaum && newRaum && prevRaum !== newRaum) {
          const prevOnline = /online/i.test(prevRaum);
          const newOnline = /online/i.test(newRaum);
          stats.roomChanges.push({
            datum_iso: row.datum_iso,
            zeit_von: row.zeit_von,
            zeit_bis: row.zeit_bis,
            veranstaltung: row.veranstaltung,
            dozent: row.dozent,
            prev_raum: prevRaum,
            new_raum: newRaum,
            wentOnline: newOnline && !prevOnline,
            wentOffline: prevOnline && !newOnline
          });
        }
      } else {
        stats.inserted++;
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return stats;
}

// Komplett-Reset: alle Stundenplan-Einträge löschen. Wird vom UI-Button
// "Stundenplan zurücksetzen" genutzt — z.B. nach Klassen-Wechsel, kaputten
// Daten o.ä. Beim nächsten Scrape werden die aktuellen Einträge frisch geladen.
function clearStundenplan(db) {
  const result = db.prepare('DELETE FROM stundenplan').run();
  return result.changes || 0;
}

function pruneVergangen(db) {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);        // YYYY-MM-DD
  const nowTime = now.toTimeString().slice(0, 5);      // HH:MM (Lokale Zeit)

  const stmt = db.prepare(`
    DELETE FROM stundenplan
    WHERE datum_iso < :today
       OR (datum_iso = :today AND zeit_bis != '' AND zeit_bis < :nowTime)
  `);
  const result = stmt.run({ today, nowTime });
  return result.changes || 0;
}

function getNoten(db, filters = {}) {
  const where = [];
  const params = {};

  if (filters.semester) {
    where.push('semester = :semester');
    params.semester = filters.semester;
  }
  if (filters.hasNote === true) {
    where.push('note IS NOT NULL');
  } else if (filters.hasNote === false) {
    where.push('note IS NULL');
  }

  let orderBy = 'fach_name ASC';
  if (filters.sortBy === 'note') {
    // Noten mit NULL zuletzt, dann aufsteigend
    orderBy = 'CASE WHEN note IS NULL THEN 1 ELSE 0 END ASC, note ASC, fach_name ASC';
  } else if (filters.sortBy === 'fetched') {
    orderBy = 'fetched_at DESC';
  } else if (filters.sortBy === 'fach') {
    orderBy = 'fach_name ASC';
  }

  const sql = `
    SELECT id, kuerzel_id, fach_code, fach_name, kuerzel_full, kuerzel_code,
           semester, typ, note, note_raw, fetched_at
    FROM noten
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY ${orderBy}
  `;

  const stmt = db.prepare(sql);
  return stmt.all(params) || [];
}

function getStundenplan(db, filters = {}) {
  const today = new Date().toISOString().slice(0, 10);
  const from = filters.from || today;

  const where = ['datum_iso >= :from'];
  const params = { from };

  if (filters.to) {
    where.push('datum_iso <= :to');
    params.to = filters.to;
  }

  let limitClause = '';
  if (typeof filters.limit === 'number' && filters.limit > 0) {
    limitClause = 'LIMIT :limit';
    params.limit = filters.limit;
  }

  const sql = `
    SELECT id, datum_iso, zeit_von, zeit_bis, raum, dozent, klasse, veranstaltung, fetched_at
    FROM stundenplan
    WHERE ${where.join(' AND ')}
    ORDER BY datum_iso ASC, zeit_von ASC
    ${limitClause}
  `;

  const stmt = db.prepare(sql);
  return stmt.all(params) || [];
}

function getHistory(db, kuerzelId) {
  if (!kuerzelId) return [];
  const stmt = db.prepare(`
    SELECT id, kuerzel_id, fach_name, note, note_raw, recorded_at
    FROM noten_history
    WHERE kuerzel_id = ?
    ORDER BY recorded_at DESC
  `);
  return stmt.all(kuerzelId) || [];
}

function round1(n) {
  if (n == null || Number.isNaN(n)) return null;
  return Math.round(n * 10) / 10;
}

function getStats(db) {
  const today = new Date().toISOString().slice(0, 10);

  const notenCountRow = db.prepare('SELECT COUNT(*) AS c FROM noten').get();
  const notenWithGradeRow = db
    .prepare('SELECT COUNT(*) AS c FROM noten WHERE note IS NOT NULL')
    .get();
  const avgRow = db.prepare('SELECT AVG(note) AS a FROM noten WHERE note IS NOT NULL').get();

  const bySemRows = db
    .prepare(`
      SELECT semester, AVG(note) AS a
      FROM noten
      WHERE note IS NOT NULL AND semester IS NOT NULL AND semester != ''
      GROUP BY semester
    `)
    .all();

  const avgBySemester = {};
  for (const row of bySemRows || []) {
    if (row.a == null) continue;
    avgBySemester[row.semester] = round1(row.a);
  }

  const upcomingRow = db
    .prepare('SELECT COUNT(*) AS c FROM stundenplan WHERE datum_iso >= ?')
    .get(today);

  const lastNotenRow = db.prepare('SELECT MAX(fetched_at) AS m FROM noten').get();
  const lastSpRow = db.prepare('SELECT MAX(fetched_at) AS m FROM stundenplan').get();

  const nextEventRow = db
    .prepare(`
      SELECT datum_iso, zeit_von, veranstaltung, raum
      FROM stundenplan
      WHERE datum_iso >= ?
      ORDER BY datum_iso ASC, zeit_von ASC
      LIMIT 1
    `)
    .get(today);

  const changedRecentRow = db
    .prepare(`
      SELECT COUNT(*) AS c
      FROM noten_history
      WHERE recorded_at >= datetime('now', '-7 days')
    `)
    .get();

  return {
    notenCount: notenCountRow?.c || 0,
    notenWithGradeCount: notenWithGradeRow?.c || 0,
    avgNote: round1(avgRow?.a),
    avgBySemester,
    stundenplanUpcoming: upcomingRow?.c || 0,
    lastFetchedNoten: lastNotenRow?.m || null,
    lastFetchedStundenplan: lastSpRow?.m || null,
    nextEvent: nextEventRow || null,
    changedRecent: changedRecentRow?.c || 0
  };
}

// =============================================================
// Modul-Detail-Noten (Prüfungen)
// =============================================================

// Schreibt die detail_id (Tocco-PK aus DWR) auf bestehende Modul-Zeilen.
// Aufruf nach saveNoten — kuerzelToDetail = { '<kuerzel_id>': '<detail_id>' }.
function updateDetailIds(db, kuerzelToDetail) {
  if (!kuerzelToDetail || typeof kuerzelToDetail !== 'object') return 0;
  const stmt = db.prepare(
    'UPDATE noten SET detail_id = ? WHERE kuerzel_id = ? AND (detail_id IS NULL OR detail_id != ?)'
  );
  let changed = 0;
  for (const [kuerzelId, detailId] of Object.entries(kuerzelToDetail)) {
    if (!kuerzelId || detailId == null) continue;
    const did = String(detailId);
    const result = stmt.run(did, String(kuerzelId), did);
    changed += result.changes || 0;
  }
  return changed;
}

// Bezeichnung wie "LB 1", "ZP 2" → { typ: 'LB'|'ZP'|'OTHER', nr: <int> }
// Tolerant gegen Bezeichnungen ohne / mit beschreibendem Zusatz:
//   "LB 1"            → LB, 1
//   "LB1"             → LB, 1
//   "LB Praxisarbeit" → LB, fallbackNr  (Bezeichnung ohne Zahl, Nr aus Spalte 1)
//   "LB - Vortrag"    → LB, fallbackNr
//   "LB"              → LB, fallbackNr
//   "Mündliche"       → OTHER, fallbackNr
//   "LBA"             → OTHER, fallbackNr  (Wortgrenze fehlt nach LB/ZP)
function classifyPruefung(bezeichnung, fallbackNr) {
  const trimmed = String(bezeichnung || '').trim();
  const m = trimmed.match(/^(LB|ZP)(?:\s*(\d+))?\b/i);
  const fbN = parseInt(fallbackNr, 10);
  const fbNr = Number.isFinite(fbN) ? fbN : 0;
  if (m) {
    const nr = m[2] ? parseInt(m[2], 10) : fbNr;
    return { typ: m[1].toUpperCase(), nr };
  }
  return { typ: 'OTHER', nr: fbNr };
}

function parseGewichtPct(raw) {
  if (raw == null) return null;
  const m = String(raw).match(/(\d+(?:[.,]\d+)?)/);
  if (!m) return null;
  const v = parseFloat(m[1].replace(',', '.'));
  return Number.isFinite(v) ? v : null;
}

const UPSERT_PRUEF_SQL = `
INSERT INTO noten_pruefungen
  (kuerzel_id, pruefung_typ, pruefung_nr, bezeichnung, gewicht, gewicht_pct, bewertung, bewertung_raw, fetched_at)
VALUES
  (:kuerzel_id, :pruefung_typ, :pruefung_nr, :bezeichnung, :gewicht, :gewicht_pct, :bewertung, :bewertung_raw, CURRENT_TIMESTAMP)
ON CONFLICT(kuerzel_id, pruefung_typ, pruefung_nr) DO UPDATE SET
  bezeichnung   = :bezeichnung,
  gewicht       = :gewicht,
  gewicht_pct   = :gewicht_pct,
  bewertung     = :bewertung,
  bewertung_raw = :bewertung_raw,
  fetched_at    = CURRENT_TIMESTAMP
`;

// Persistiert die Prüfungs-Liste für ein Modul. Empty array = no-op (lässt
// bestehende Daten unangetastet — Schutz gegen fehlgeschlagene Detail-Scrapes
// die fälschlich 0 Treffer liefern). Sonst: Upsert pro Eintrag + DELETE der
// nicht mehr vorhandenen (Tocco hat eine Prüfung entfernt).
//
// Returns: { inserted, updated, deleted, addedEntries }
//   addedEntries = Array der NEU eingefügten Einträge (nicht Updates) — wird
//   vom wöchentlichen Detail-Refresh genutzt um Push-Diffs zu erzeugen.
function savePruefungen(db, kuerzelId, entries) {
  if (!kuerzelId) return { inserted: 0, updated: 0, deleted: 0, addedEntries: [] };
  if (!Array.isArray(entries) || !entries.length) {
    return { inserted: 0, updated: 0, deleted: 0, addedEntries: [] };
  }

  const upsert = db.prepare(UPSERT_PRUEF_SQL);
  const getExisting = db.prepare(
    'SELECT pruefung_typ, pruefung_nr FROM noten_pruefungen WHERE kuerzel_id = ?'
  );
  const del = db.prepare(
    'DELETE FROM noten_pruefungen WHERE kuerzel_id = ? AND pruefung_typ = ? AND pruefung_nr = ?'
  );

  const stats = { inserted: 0, updated: 0, deleted: 0, addedEntries: [] };

  db.exec('BEGIN');
  try {
    const seen = new Set();
    const before = (getExisting.all(String(kuerzelId)) || [])
      .map(r => `${r.pruefung_typ}#${r.pruefung_nr}`);

    for (const e of entries) {
      const cls = classifyPruefung(e.bezeichnung, e.pruefung_nr);
      const key = `${cls.typ}#${cls.nr}`;
      if (seen.has(key)) continue; // doppelte aus dem Parser ignorieren
      seen.add(key);

      const bewertung = (e.bewertung == null || e.bewertung === '') ? null
        : (typeof e.bewertung === 'number' ? e.bewertung : parseNote(String(e.bewertung)));

      const row = {
        kuerzel_id:    String(kuerzelId),
        pruefung_typ:  cls.typ,
        pruefung_nr:   cls.nr,
        bezeichnung:   e.bezeichnung || null,
        gewicht:       e.gewicht || null,
        gewicht_pct:   parseGewichtPct(e.gewicht),
        bewertung:     bewertung,
        bewertung_raw: e.bewertung_raw != null ? String(e.bewertung_raw) : (e.bewertung != null ? String(e.bewertung) : null)
      };

      const existed = before.includes(key);
      upsert.run(row);
      if (existed) {
        stats.updated++;
      } else {
        stats.inserted++;
        stats.addedEntries.push({
          pruefung_typ: cls.typ,
          pruefung_nr:  cls.nr,
          bezeichnung:  row.bezeichnung,
          gewicht:      row.gewicht,
          gewicht_pct:  row.gewicht_pct,
          bewertung:    row.bewertung
        });
      }
    }

    // Entries die früher da waren aber nicht mehr → löschen
    for (const k of before) {
      if (seen.has(k)) continue;
      const [typ, nr] = k.split('#');
      del.run(String(kuerzelId), typ, parseInt(nr, 10));
      stats.deleted++;
    }

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return stats;
}

// Liefert ALLE benoteten Module mit detail_id — ignoriert Cooldown UND
// "haben pruefungen" Filter. Wird vom wöchentlichen Detail-Refresh genutzt,
// um auch Module mit bereits vorhandenen Prüfungen erneut zu prüfen
// (Edge-Case: ZP=5.5 + LB=5.5 → Modulnote unverändert, aber LB ist neu).
function getKuerzelnWithDetailId(db) {
  const rows = db.prepare(`
    SELECT kuerzel_id, detail_id, fach_name, semester, kuerzel_code
    FROM noten
    WHERE note IS NOT NULL
      AND detail_id IS NOT NULL
      AND detail_id != ''
    ORDER BY kuerzel_id
  `).all() || [];
  return rows;
}

// Einmalige (idempotente) Migration: existierende OTHER-Einträge deren
// Bezeichnung mit "LB" oder "ZP" beginnt werden re-klassifiziert. Wird beim
// open() aufgerufen — beim zweiten Mal findet die Query nichts mehr.
//
// Bei UNIQUE-Konflikt (es gibt bereits einen Eintrag mit dem korrekten
// pruefung_typ + pruefung_nr) wird der OTHER-Duplikat gelöscht.
function reclassifyOtherPruefungen(db) {
  const rows = db.prepare(
    "SELECT id, kuerzel_id, pruefung_nr, bezeichnung " +
    "FROM noten_pruefungen " +
    "WHERE pruefung_typ = 'OTHER' " +
    "  AND (bezeichnung LIKE 'LB%' OR bezeichnung LIKE 'ZP%' " +
    "       OR bezeichnung LIKE 'lb%' OR bezeichnung LIKE 'zp%')"
  ).all() || [];
  if (!rows.length) return { updated: 0, removed: 0 };

  const upd = db.prepare(
    'UPDATE noten_pruefungen SET pruefung_typ = ?, pruefung_nr = ? WHERE id = ?'
  );
  const del = db.prepare('DELETE FROM noten_pruefungen WHERE id = ?');

  let updated = 0, removed = 0;
  for (const r of rows) {
    const cls = classifyPruefung(r.bezeichnung, r.pruefung_nr);
    if (cls.typ === 'OTHER') continue;
    try {
      upd.run(cls.typ, cls.nr, r.id);
      updated++;
    } catch (_) {
      // UNIQUE-Konflikt: korrekter Eintrag existiert bereits — Duplikat löschen.
      try { del.run(r.id); removed++; } catch (_e) { /* ignore */ }
    }
  }
  return { updated, removed };
}

function getPruefungen(db, kuerzelId) {
  if (!kuerzelId) return [];
  const stmt = db.prepare(`
    SELECT id, kuerzel_id, pruefung_typ, pruefung_nr, bezeichnung,
           gewicht, gewicht_pct, bewertung, bewertung_raw, fetched_at
    FROM noten_pruefungen
    WHERE kuerzel_id = ?
    ORDER BY
      CASE pruefung_typ WHEN 'ZP' THEN 0 WHEN 'LB' THEN 1 ELSE 2 END ASC,
      pruefung_nr ASC
  `);
  return stmt.all(String(kuerzelId)) || [];
}

// Cooldown für Backfill-Versuche bei leeren Detail-Pages: 12h. Bei kürzerem
// Cooldown würden Module ohne Prüfungen jeden Cycle erneut gescrapt werden
// (Playwright-Page-Load = teuer). Bei längerem würden neue Prüfungen zu spät
// nachgezogen.
const DETAIL_BACKFILL_COOLDOWN_MS = 12 * 60 * 60 * 1000;

// Liefert Module die einen Detail-Scrape brauchen:
//  - haben eine Note (note IS NOT NULL)
//  - haben eine detail_id (sonst können wir nicht navigieren)
//  - haben noch KEINE Einträge in noten_pruefungen (Backfill)
//  - wurden noch nie ODER vor > Cooldown gescrapt (verhindert Endlos-Retry
//    bei Modulen, deren Detail-Page wirklich leer ist)
// Ergänzt durch explizite Liste von kuerzelIds (z.B. aus gradeChanges) — diese
// werden IMMER mit aufgenommen (Cooldown ignoriert), weil eine geänderte Note
// auch potentiell neue/aktualisierte Prüfungen bedeutet.
function getKuerzelnNeedingDetailScrape(db, additionalKuerzelIds = []) {
  const rows = db.prepare(`
    SELECT n.kuerzel_id, n.detail_id
    FROM noten n
    WHERE n.note IS NOT NULL
      AND n.detail_id IS NOT NULL
      AND n.detail_id != ''
      AND (n.detail_scraped_at IS NULL
           OR n.detail_scraped_at < datetime('now', ?))
      AND NOT EXISTS (
        SELECT 1 FROM noten_pruefungen p WHERE p.kuerzel_id = n.kuerzel_id
      )
  `).all('-' + Math.round(DETAIL_BACKFILL_COOLDOWN_MS / 1000) + ' seconds') || [];

  const map = new Map();
  for (const r of rows) map.set(r.kuerzel_id, r.detail_id);

  // Zusätzliche kuerzelIds (aus gradeChanges) — Cooldown ignoriert,
  // weil sich die Note geändert hat → potentiell neue/aktualisierte Prüfungen.
  if (Array.isArray(additionalKuerzelIds) && additionalKuerzelIds.length) {
    const lookupOne = db.prepare(
      "SELECT detail_id FROM noten WHERE kuerzel_id = ? AND detail_id IS NOT NULL AND detail_id != ''"
    );
    for (const kid of additionalKuerzelIds) {
      if (!kid || map.has(kid)) continue;
      const row = lookupOne.get(String(kid));
      if (row && row.detail_id) map.set(String(kid), row.detail_id);
    }
  }

  return [...map.entries()].map(([kuerzel_id, detail_id]) => ({ kuerzel_id, detail_id }));
}

// Markiert ein Modul als "Detail-Scrape versucht" (egal ob erfolgreich oder leer).
// MUSS nach jedem scrapeDetail-Aufruf gerufen werden, damit die Cooldown-Logik
// in getKuerzelnNeedingDetailScrape greift.
function markDetailScraped(db, kuerzelId) {
  if (!kuerzelId) return;
  db.prepare('UPDATE noten SET detail_scraped_at = CURRENT_TIMESTAMP WHERE kuerzel_id = ?')
    .run(String(kuerzelId));
}

// Gezielter Lookup einer Modul-Zeile — wird vom /api/noten/:id/pruefungen
// Endpoint genutzt, damit der Server-Layer keine eigene SQL-Statements führt.
function getNotenRow(db, kuerzelId) {
  if (!kuerzelId) return null;
  const stmt = db.prepare(
    'SELECT id, kuerzel_id, fach_code, fach_name, kuerzel_full, kuerzel_code, ' +
    '       semester, typ, note, note_raw, detail_id, detail_scraped_at, fetched_at ' +
    'FROM noten WHERE kuerzel_id = ?'
  );
  return stmt.get(String(kuerzelId)) || null;
}

module.exports = {
  open,
  saveNoten,
  saveStundenplan,
  pruneVergangen,
  clearStundenplan,
  getNoten,
  getStundenplan,
  getHistory,
  getStats,
  // Modul-Detail-Noten
  updateDetailIds,
  savePruefungen,
  getPruefungen,
  getKuerzelnNeedingDetailScrape,
  getKuerzelnWithDetailId,
  markDetailScraped,
  getNotenRow,
  classifyPruefung,
  parseGewichtPct
};
