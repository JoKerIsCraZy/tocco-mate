/**
 * SQLite-Schicht für Tocco-CLI — nutzt Nodes eingebautes node:sqlite (Node 22.5+).
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
  fetched_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_noten_fetched   ON noten(fetched_at);
CREATE INDEX IF NOT EXISTS idx_noten_semester  ON noten(semester);

CREATE TABLE IF NOT EXISTS noten_history (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  kuerzel_id    TEXT NOT NULL,
  fach_name     TEXT,
  note          REAL,
  note_raw      TEXT,
  recorded_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_hist_kuerzel ON noten_history(kuerzel_id, recorded_at);

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

function open(filename) {
  const dataDir = path.join(process.cwd(), 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const dbPath = filename || path.join(dataDir, 'tocco.db');
  const d = new DatabaseSync(dbPath);
  const run = (sql) => d.exec(sql);
  run('PRAGMA journal_mode = WAL');
  run('PRAGMA foreign_keys = ON');
  run(SCHEMA);
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

function round2(n) {
  if (n == null || Number.isNaN(n)) return null;
  return Math.round(n * 100) / 100;
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

module.exports = {
  open,
  saveNoten,
  saveStundenplan,
  pruneVergangen,
  getNoten,
  getStundenplan,
  getHistory,
  getStats
};
