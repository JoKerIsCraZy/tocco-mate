/**
 * Telegram-Bot für Tocco WISS — Menu-basierte Navigation via Inline-Buttons.
 *
 * Whitelist-basiert: nur eine definierte User-ID darf interagieren.
 * Zero Dependencies — nutzt native fetch + long-polling.
 *
 * Hauptmenü erreichbar via /start oder /menu.
 * Slash-Commands funktionieren weiterhin als Shortcuts.
 */

const db = require('./db');

const state = {
  token: null,
  allowedUserId: null,
  offset: 0,
  running: false,
  logger: null,
  triggerScrape: null,
  getStatus: null,
  lastMenuMessageId: null,  // Nur EIN Menü-Message, wird editiert statt dupliziert
  // Live-Tracking eines manuell getriggerten Scrapes — die /scrape-Message wird
  // alle 2.5s aktualisiert, bis state.running false wird.
  scrapePollTimer: null,
  scrapeMessage: null,      // { chatId, messageId } — die Message die wir editieren
  // Multi-Message-Screens (z.B. Stundenplan „Alle" mit pro-Monat-Message).
  // IDs werden hier geparkt damit beim Wechsel ins Menü alle gelöscht werden.
  multiMessageIds: []
};

// ---------- Telegram API ----------
async function tg(method, body) {
  const url = `https://api.telegram.org/bot${state.token}/${method}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {})
  });
  const json = await res.json();
  if (!json.ok) throw new Error(`Telegram ${method}: ${json.description}`);
  return json.result;
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

async function send(chatId, text, keyboard) {
  // Vorheriges Menü löschen (best-effort) — nur EIN Menü-Bot-Message bleibt sichtbar
  if (state.lastMenuMessageId && chatId === state.allowedUserId) {
    tg('deleteMessage', { chat_id: chatId, message_id: state.lastMenuMessageId }).catch(() => {});
    state.lastMenuMessageId = null;
  }

  const body = {
    chat_id: chatId,
    text: truncate(text),
    parse_mode: 'HTML',
    disable_web_page_preview: true
  };
  if (keyboard) body.reply_markup = keyboard;
  const sent = await tg('sendMessage', body);
  if (sent && sent.message_id && chatId === state.allowedUserId) {
    state.lastMenuMessageId = sent.message_id;
  }
  return sent;
}

// Push-Nachrichten: bleiben stehen, OK-Button zum Dismiss, löschen NICHT vorheriges Menü
async function sendPush(chatId, text, keyboard) {
  const pushKb = keyboard ? { inline_keyboard: [...(keyboard.inline_keyboard || [])] } : { inline_keyboard: [] };
  pushKb.inline_keyboard.push([{ text: '✓ OK', callback_data: 'dismiss' }]);

  const body = {
    chat_id: chatId,
    text: truncate(text),
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    reply_markup: pushKb
  };
  return tg('sendMessage', body);
}

// Editiert das letzte Menü-Message oder sendet ein neues, falls keins existiert/editierbar ist
async function showScreen(chatId, screen) {
  const lastId = state.lastMenuMessageId;
  if (lastId) {
    try {
      await tg('editMessageText', {
        chat_id: chatId,
        message_id: lastId,
        text: truncate(screen.text),
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...(screen.keyboard ? { reply_markup: screen.keyboard } : {})
      });
      return lastId;
    } catch (_) {
      // Edit fehlgeschlagen → message weg/alt → fallthrough zu send
      state.lastMenuMessageId = null;
    }
  }
  const sent = await send(chatId, screen.text, screen.keyboard);
  return sent ? sent.message_id : null;
}

async function editMessage(chatId, messageId, text, keyboard) {
  const body = {
    chat_id: chatId,
    message_id: messageId,
    text: truncate(text),
    parse_mode: 'HTML',
    disable_web_page_preview: true
  };
  if (keyboard) body.reply_markup = keyboard;
  try {
    return await tg('editMessageText', body);
  } catch (e) {
    // Message too old / identical content / deleted → neu senden
    return send(chatId, text, keyboard);
  }
}

// Telegram-Limit ist 4096 Bytes UTF-8 (nicht Chars!). Naives slice() bricht
// mitten in HTML-Tags ("<b>X</b>" → "<b>X</" + suffix → Parser-Crash).
// Wir cutten byte-genau, schmeißen einen unvollständigen Tag-Rest am Ende weg
// und schließen offene Tags sauber.
function truncate(text) {
  const MAX_BYTES = 4000;
  if (Buffer.byteLength(text, 'utf8') <= MAX_BYTES) return text;

  const suffix = '\n\n<i>… (gekürzt)</i>';
  const budget = MAX_BYTES - Buffer.byteLength(suffix, 'utf8');

  let cut = '';
  let bytes = 0;
  for (const ch of text) {
    const chBytes = Buffer.byteLength(ch, 'utf8');
    if (bytes + chBytes > budget) break;
    cut += ch;
    bytes += chBytes;
  }

  // Unvollständiger Tag am Ende? "<...ohne >" → wegschneiden.
  const lastOpen = cut.lastIndexOf('<');
  const lastClose = cut.lastIndexOf('>');
  if (lastOpen > lastClose) cut = cut.slice(0, lastOpen);

  // Telegram-erlaubtes HTML: b, i, u, s, code, pre, a — wir tracken nur die,
  // die wir tatsächlich nutzen (b, i, code, s, u). Stack-basiert.
  const openStack = [];
  const tagRe = /<(\/)?([a-z]+)\b[^>]*>/gi;
  let m;
  while ((m = tagRe.exec(cut)) !== null) {
    const isClose = !!m[1];
    const name = m[2].toLowerCase();
    if (!['b', 'i', 'u', 's', 'code', 'pre', 'a'].includes(name)) continue;
    if (isClose) {
      const idx = openStack.lastIndexOf(name);
      if (idx >= 0) openStack.splice(idx, 1);
    } else {
      openStack.push(name);
    }
  }
  let closing = '';
  for (let i = openStack.length - 1; i >= 0; i--) closing += '</' + openStack[i] + '>';

  return cut + closing + suffix;
}

// ---------- Date Helpers ----------
const DAYS = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];
const MONTHS = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];

function isoToday(offset = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
}

function dayLabel(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  return DAYS[date.getDay()] + ', ' + d + '. ' + MONTHS[m - 1];
}

function nextWeekRange() {
  const now = new Date();
  const day = now.getDay();
  const daysUntilMon = day === 0 ? 1 : (8 - day);
  const mon = new Date(now);
  mon.setDate(now.getDate() + daysUntilMon);
  const sun = new Date(mon);
  sun.setDate(mon.getDate() + 6);
  return { from: mon.toISOString().slice(0, 10), to: sun.toISOString().slice(0, 10) };
}

// Formats an ISO timestamp into "dd.MM.yyyy HH:mm:ss" using the local timezone.
// Node honors the TZ env var — set TZ=Europe/Zurich (etc) to control output.
function formatDateTime(iso) {
  if (!iso) return '–';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const pad = n => String(n).padStart(2, '0');
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} `
       + `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// ---------- Keyboards ----------
function mainMenu() {
  return {
    inline_keyboard: [
      [
        { text: '📚 Noten', callback_data: 'noten' },
        { text: '🎯 Durchschnitt', callback_data: 'durchschnitt' }
      ],
      [
        { text: '☀️ Heute', callback_data: 'heute' },
        { text: '🌅 Morgen', callback_data: 'morgen' }
      ],
      [
        { text: '📆 Nächste Woche', callback_data: 'woche' },
        { text: '📋 Stundenplan', callback_data: 'stundenplan' }
      ],
      [
        { text: '🔄 Scrape', callback_data: 'scrape' },
        { text: '📟 Status', callback_data: 'status' }
      ]
    ]
  };
}

function notenNav() {
  return {
    inline_keyboard: [
      [
        { text: '🎯 Durchschnitt', callback_data: 'durchschnitt' },
        { text: '🔄 Aktualisieren', callback_data: 'noten' }
      ],
      [{ text: '⬅️ Menü', callback_data: 'menu' }]
    ]
  };
}

function durchschnittNav() {
  return {
    inline_keyboard: [
      [
        { text: '📚 Alle Noten', callback_data: 'noten' },
        { text: '🔄 Aktualisieren', callback_data: 'durchschnitt' }
      ],
      [{ text: '⬅️ Menü', callback_data: 'menu' }]
    ]
  };
}

function stundenplanNav(current) {
  const all = [
    { text: '☀️ Heute', data: 'heute' },
    { text: '🌅 Morgen', data: 'morgen' },
    { text: '📆 Woche', data: 'woche' },
    { text: '📋 Monat', data: 'stundenplan' },
    { text: '📚 Alle', data: 'stundenplan_alle' }
  ];
  const others = all.filter(x => x.data !== current).map(x => ({ text: x.text, callback_data: x.data }));
  // In 2 Zeilen aufteilen damit's auf Mobile nicht zu eng wird
  const row1 = others.slice(0, Math.ceil(others.length / 2));
  const row2 = others.slice(Math.ceil(others.length / 2));
  const rows = [row1];
  if (row2.length) rows.push(row2);
  rows.push([
    { text: '🔄 Aktualisieren', callback_data: current },
    { text: '⬅️ Menü', callback_data: 'menu' }
  ]);
  return { inline_keyboard: rows };
}

function simpleNav() {
  return {
    inline_keyboard: [
      [{ text: '⬅️ Menü', callback_data: 'menu' }]
    ]
  };
}

// ---------- Screens ----------
function formatNoteColor(note) {
  if (note == null) return '⬜';
  if (note >= 5.5) return '🟩';
  if (note >= 4.5) return '🟦';
  if (note >= 4.0) return '🟨';
  return '🟥';
}

async function screenMenu() {
  const database = db.open();
  let stats;
  try { stats = db.getStats(database); } finally { database.close(); }

  let text = '🎓 <b>Tocco WISS</b>\n\n';
  text += '📊 <b>' + stats.notenCount + '</b> Noten · <b>' + stats.notenWithGradeCount + '</b> benotet\n';
  if (stats.avgNote != null) text += '🎯 Ø: <b>' + stats.avgNote + '</b>\n';
  text += '📆 <b>' + stats.stundenplanUpcoming + '</b> kommende Events\n\n';
  text += '<i>Wähle eine Option:</i>';
  return { text, keyboard: mainMenu() };
}

function formatNote(n) {
  if (n == null) return '  —';
  return n.toFixed(1); // einheitlich: 6.0, 5.5, 4.5
}

// Modul-Nummer aus kuerzel_code extrahieren — wie im Web-UI.
// "UIFZ-2524-020-S1-106"    → "106"
// "UIFZ-2524-020-S2-ENG-N3" → "ENG-N3"
function extractModulNummer(r) {
  if (!r || !r.kuerzel_code) return null;
  const parts = String(r.kuerzel_code).split('-');
  if (!parts.length) return null;
  const last = parts[parts.length - 1];
  if (/^N\d+$/i.test(last) && parts.length >= 2) {
    return parts[parts.length - 2] + '-' + last;
  }
  return last;
}

async function screenNoten() {
  const database = db.open();
  let rows, stats;
  try {
    rows = db.getNoten(database, { hasNote: true, sortBy: 'fach' });
    stats = db.getStats(database);
  } finally { database.close(); }

  const graded = rows.filter(r => r.note != null);
  if (!graded.length) {
    return { text: '📚 Noch keine benoteten Einträge.', keyboard: notenNav() };
  }

  const groups = {};
  for (const r of graded) {
    const key = r.semester || 'Andere';
    (groups[key] = groups[key] || []).push(r);
  }
  const semOrder = Object.keys(groups).sort((a, b) => {
    if (a.startsWith('S') && b.startsWith('S')) return a.localeCompare(b);
    if (a.startsWith('S')) return -1;
    if (b.startsWith('S')) return 1;
    return a.localeCompare(b);
  });

  let text = '📚 <b>Alle Noten</b>  <i>(' + graded.length + ' benotet)</i>\n';
  text += '<i>Tippe auf eine Modul-Nummer unten für ZP/LB-Details.</i>\n';
  for (const sem of semOrder) {
    const avgSem = stats.avgBySemester && stats.avgBySemester[sem];
    text += '\n━━━ <b>' + escapeHtml(sem) + '</b>';
    if (avgSem != null) text += '  ·  Ø <b>' + avgSem + '</b>';
    text += ' ━━━\n\n';

    groups[sem].sort((a, b) => (b.note || 0) - (a.note || 0));
    for (const r of groups[sem]) {
      const mod = extractModulNummer(r);
      const prefix = mod ? '<code>' + escapeHtml(mod) + '</code>  ' : '';
      text += formatNoteColor(r.note) + '  <b>' + formatNote(r.note) + '</b>  ' + prefix + escapeHtml(r.fach_name) + '\n';
    }
  }

  text += '\n━━━━━━━━━━━━━━━━━━\n';
  text += '🎯 Ø gesamt: <b>' + (stats.avgNote != null ? stats.avgNote : '—') + '</b>';

  // Detail-Buttons: ein Knopf pro Modul mit der Modul-Nummer als Beschriftung.
  // 4 pro Reihe, Telegram limitiert max 100 Buttons / 4096 chars Text.
  const detailRows = [];
  const PER_ROW = 4;
  for (let i = 0; i < graded.length; i += PER_ROW) {
    detailRows.push(graded.slice(i, i + PER_ROW).map(r => ({
      text: extractModulNummer(r) || r.kuerzel_id,
      callback_data: 'modul_' + r.kuerzel_id
    })));
  }

  const keyboard = {
    inline_keyboard: [
      ...detailRows,
      [
        { text: '🎯 Durchschnitt', callback_data: 'durchschnitt' },
        { text: '🔄 Aktualisieren', callback_data: 'noten' }
      ],
      [{ text: '⬅️ Menü', callback_data: 'menu' }]
    ]
  };

  return { text, keyboard };
}

// Berechnet gewichteten Schnitt aus Pruefungen — nur wenn alle bewertet.
function calcWeightedAvg(pruefungen) {
  if (!pruefungen || !pruefungen.length) return null;
  let sumW = 0, sumWN = 0;
  for (const p of pruefungen) {
    const n = Number(p.bewertung);
    const w = Number(p.gewicht_pct);
    if (!isFinite(n)) return null;
    if (isFinite(w) && w > 0) { sumW += w; sumWN += n * w; }
  }
  if (sumW <= 0) return null;
  return sumWN / sumW;
}

// Modul-Detail: Tocco-Modulnote prominent, dann ZP/LB-Liste mit Gewichten.
// Aufgerufen via callback_data="modul_<kuerzel_id>" aus screenNoten.
async function screenModulDetail(kuerzelId) {
  if (!kuerzelId || !/^[\w\-./:]+$/.test(kuerzelId) || kuerzelId.length > 128) {
    return { text: '⚠️ Ungültige Modul-ID.', keyboard: simpleNav() };
  }
  const database = db.open();
  let modul, pruefungen;
  try {
    modul = db.getNotenRow(database, kuerzelId);
    pruefungen = db.getPruefungen(database, kuerzelId);
  } finally { database.close(); }

  if (!modul) {
    return { text: '📚 <b>Modul nicht gefunden</b>', keyboard: simpleNav() };
  }

  const mod = extractModulNummer(modul);
  const sem = modul.semester ? '  <i>' + escapeHtml(modul.semester) + '</i>' : '';
  let text = '📚 ';
  if (mod) text += '<code>' + escapeHtml(mod) + '</code>  ';
  text += '<b>' + escapeHtml(modul.fach_name || modul.kuerzel_id) + '</b>' + sem + '\n\n';

  if (modul.note != null) {
    text += '🎯 <b>Modulnote (Tocco):</b> ' + formatNoteColor(modul.note)
         + ' <b>' + Number(modul.note).toFixed(3) + '</b>\n';
    // Berechnete Note nur dazuschreiben wenn sie matcht (Tocco hat Vorrang;
    // bei Diskrepanz wäre der berechnete Wert verwirrend).
    const calc = calcWeightedAvg(pruefungen);
    if (calc != null && Math.abs(calc - modul.note) < 0.05) {
      text += '   <i>(eigene Berechnung stimmt: ' + calc.toFixed(3) + ')</i>\n';
    }
    text += '\n';
  } else {
    text += '<i>Noch keine Modulnote.</i>\n\n';
  }

  if (pruefungen.length) {
    text += '<b>Prüfungen</b>\n';
    text += formatPruefungenBlock(pruefungen) + '\n';
    if (modul.detail_scraped_at) {
      const d = new Date(modul.detail_scraped_at);
      if (!isNaN(d.getTime())) {
        text += '\n<i>aktualisiert ' + formatDateTime(modul.detail_scraped_at) + '</i>';
      }
    }
  } else {
    text += '<i>Keine Prüfungs-Details vorhanden.</i>\n';
    if (modul.detail_id) {
      text += '<i>(Beim nächsten Scrape werden sie versucht zu laden.)</i>';
    } else {
      text += '<i>(Keine Detail-ID — Modul hat keine aufrufbare Detail-Seite.)</i>';
    }
  }

  return {
    text,
    keyboard: {
      inline_keyboard: [
        [{ text: '📚 Alle Noten', callback_data: 'noten' }, { text: '⬅️ Menü', callback_data: 'menu' }]
      ]
    }
  };
}

async function screenDurchschnitt() {
  const database = db.open();
  let stats;
  try { stats = db.getStats(database); } finally { database.close(); }

  let text = '🎯 <b>Notendurchschnitt</b>\n\n';
  text += 'Ø gesamt: <b>' + (stats.avgNote != null ? stats.avgNote : '—') + '</b>\n';
  if (stats.avgBySemester && Object.keys(stats.avgBySemester).length) {
    const entries = Object.entries(stats.avgBySemester).sort(([a], [b]) => a.localeCompare(b));
    for (const [sem, v] of entries) {
      text += 'Ø ' + sem + ': <b>' + v + '</b>\n';
    }
  }
  text += '\n<i>' + stats.notenWithGradeCount + ' von ' + stats.notenCount + ' Modulen benotet</i>';
  return { text, keyboard: durchschnittNav() };
}

function formatTag(label, rows) {
  if (!rows.length) return '📅 <b>' + label + '</b>\n\nKeine Termine. 🎉';
  let text = '📅 <b>' + label + '</b>\n\n';
  for (const r of rows) {
    text += '🕐 <b>' + r.zeit_von + '–' + r.zeit_bis + '</b>\n';
    text += '📚 ' + escapeHtml(r.veranstaltung) + '\n';
    if (r.raum) text += '🏫 ' + escapeHtml(r.raum) + '\n';
    if (r.dozent) text += '👤 ' + escapeHtml(r.dozent) + '\n';
    text += '\n';
  }
  return text.trim();
}

async function screenHeute() {
  const today = isoToday(0);
  const database = db.open();
  let rows;
  try { rows = db.getStundenplan(database, { from: today, to: today }); } finally { database.close(); }
  return { text: formatTag('Heute · ' + dayLabel(today), rows), keyboard: stundenplanNav('heute') };
}

async function screenMorgen() {
  const tomorrow = isoToday(1);
  const database = db.open();
  let rows;
  try { rows = db.getStundenplan(database, { from: tomorrow, to: tomorrow }); } finally { database.close(); }
  return { text: formatTag('Morgen · ' + dayLabel(tomorrow), rows), keyboard: stundenplanNav('morgen') };
}

async function screenWoche() {
  const { from, to } = nextWeekRange();
  const database = db.open();
  let rows;
  try { rows = db.getStundenplan(database, { from, to }); } finally { database.close(); }

  if (!rows.length) {
    return {
      text: '📅 <b>Nächste Woche</b>\n<i>' + from + ' bis ' + to + '</i>\n\nKeine Termine. 🎉',
      keyboard: stundenplanNav('woche')
    };
  }

  const byDate = {};
  for (const r of rows) (byDate[r.datum_iso] = byDate[r.datum_iso] || []).push(r);

  let text = '📅 <b>Nächste Woche</b>\n<i>' + from + ' bis ' + to + '</i>\n\n';
  // Reihenfolge: weiter weg oben, näher am heute unten.
  // Eine Woche passt komplett in Telegram-Limit, daher kein Tages-Limit nötig.
  for (const date of Object.keys(byDate).sort().reverse()) {
    text += '━━━━━━━━━━━━━━━━━━\n';
    text += '<b>' + dayLabel(date) + '</b>\n\n';
    for (const r of byDate[date]) {
      text += '🕐 ' + r.zeit_von + '–' + r.zeit_bis + '  <b>' + escapeHtml(r.veranstaltung) + '</b>\n';
      const bits = [];
      if (r.raum) bits.push('🏫 ' + r.raum);
      if (r.dozent) bits.push('👤 ' + r.dozent);
      if (bits.length) text += '   ' + escapeHtml(bits.join('  ·  ')) + '\n';
      text += '\n';
    }
  }
  return { text: text.trim(), keyboard: stundenplanNav('woche') };
}

// Schätzt grob die Bytes-Größe eines Tag-Blocks (für Smart-Truncate).
function estimateDayBytes(date, events) {
  let b = 30 + Buffer.byteLength(dayLabel(date), 'utf8');
  for (const r of events) {
    b += 50;
    b += Buffer.byteLength(String(r.veranstaltung || ''), 'utf8');
    b += Buffer.byteLength(String(r.raum || ''), 'utf8');
    b += Buffer.byteLength(String(r.dozent || ''), 'utf8');
  }
  return b;
}

async function screenStundenplan() {
  const today = isoToday(0);
  const database = db.open();
  let rows;
  try { rows = db.getStundenplan(database, { from: today, limit: 200 }); } finally { database.close(); }

  if (!rows.length) {
    return {
      text: '📋 <b>Stundenplan</b>\n\nKeine kommenden Termine. 🎉',
      keyboard: stundenplanNav('stundenplan')
    };
  }

  const byDate = {};
  for (const r of rows) (byDate[r.datum_iso] = byDate[r.datum_iso] || []).push(r);

  // Bis zu ~1 Monat zeigen. Smart-Truncate: chronologisch füllen bis Byte-
  // Budget erreicht — fernste Tage werden weggelassen statt heute.
  const allDates = Object.keys(byDate).sort();
  const MAX_DAYS = 31;
  const BUDGET_BYTES = 3500;

  let estimated = 200; // header overhead
  const visibleDates = [];
  for (const date of allDates) {
    if (visibleDates.length >= MAX_DAYS) break;
    const cost = estimateDayBytes(date, byDate[date]);
    if (estimated + cost > BUDGET_BYTES) break;
    visibleDates.push(date);
    estimated += cost;
  }
  const truncatedDays = allDates.length - visibleDates.length;
  // Reverse: weiter weg oben, heute unten.
  const dates = visibleDates.slice().reverse();

  const visibleCount = visibleDates.reduce((sum, d) => sum + byDate[d].length, 0);
  let text = '📋 <b>Stundenplan</b>  <i>(' + visibleCount + ' Termine, ' + visibleDates.length + ' Tage';
  if (truncatedDays > 0) text += ' · +' + truncatedDays + ' weitere — siehe „Alle"';
  text += ')</i>\n';
  for (const date of dates) {
    text += '\n━━ <b>' + escapeHtml(dayLabel(date)) + '</b> ━━\n';
    for (const r of byDate[date]) {
      text += '\n🕐 <b>' + r.zeit_von + '–' + r.zeit_bis + '</b>  ' + escapeHtml(r.veranstaltung) + '\n';
      const bits = [];
      if (r.raum) bits.push('🏫 ' + r.raum);
      if (r.dozent) bits.push('👤 ' + r.dozent);
      if (bits.length) text += '   <i>' + escapeHtml(bits.join('  ·  ')) + '</i>\n';
    }
  }

  return { text: text.trim(), keyboard: stundenplanNav('stundenplan') };
}

// Phasen-Labels (deutsch, kompakt) — synchron zu PHASE_LABELS im Frontend
const PHASE_LABELS_DE = {
  starting:      'Initialisiert…',
  browser:       'Browser startet…',
  login:         'Login läuft…',
  noten:         'Noten werden geladen…',
  stundenplan:   'Stundenplan wird geladen…',
  saving:        'In DB speichern…',
  noten_details: 'Modul-Details werden geladen…'
};

// Sekunden seit ISO-Zeitstempel, oder null wenn ungültig
function elapsedSec(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.round((Date.now() - t) / 1000));
}

// Stundenplan „Alle": gruppiert ALLE kommenden Termine nach Monat.
// Returnt structure mit messages[] (eine Telegram-Message pro Monat).
// Reihenfolge je Message: Tage absteigend (wie /stundenplan).
const MONTHS_DE = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
                   'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];

function buildMonthlyStundenplan() {
  const today = isoToday(0);
  const database = db.open();
  let rows;
  try {
    rows = db.getStundenplan(database, { from: today, limit: 1000 });
  } finally {
    database.close();
  }

  if (!rows.length) return { messages: [], totalEvents: 0, totalMonths: 0 };

  // Gruppieren nach yyyy-MM
  const byMonth = new Map();
  for (const r of rows) {
    const m = (r.datum_iso || '').match(/^(\d{4})-(\d{2})/);
    if (!m) continue;
    const monthKey = m[1] + '-' + m[2];
    if (!byMonth.has(monthKey)) byMonth.set(monthKey, []);
    byMonth.get(monthKey).push(r);
  }

  const monthKeys = [...byMonth.keys()].sort();
  const messages = [];

  for (const mk of monthKeys) {
    const events = byMonth.get(mk);
    const [yyyy, mm] = mk.split('-');
    const monthLabel = MONTHS_DE[parseInt(mm, 10) - 1] + ' ' + yyyy;

    // Pro Monat: nach Tag gruppieren, Tage rückwärts (weit weg oben)
    const byDay = {};
    for (const r of events) (byDay[r.datum_iso] = byDay[r.datum_iso] || []).push(r);
    const dayKeys = Object.keys(byDay).sort().reverse();

    let text = '📋 <b>' + escapeHtml(monthLabel) + '</b>  <i>(' + events.length + ' Termine)</i>\n';

    // Falls ein Monat zu groß für eine Telegram-Message wird, splitten.
    // Wir bauen erst alles zusammen und checken am Ende.
    let block = '';
    for (const date of dayKeys) {
      block += '\n━━ <b>' + escapeHtml(dayLabel(date)) + '</b> ━━\n';
      for (const r of byDay[date]) {
        block += '\n🕐 <b>' + r.zeit_von + '–' + r.zeit_bis + '</b>  ' + escapeHtml(r.veranstaltung) + '\n';
        const bits = [];
        if (r.raum) bits.push('🏫 ' + r.raum);
        if (r.dozent) bits.push('👤 ' + r.dozent);
        if (bits.length) block += '   <i>' + escapeHtml(bits.join('  ·  ')) + '</i>\n';
      }
    }
    text += block;

    // Falls trotzdem zu groß: splitten in Hälften (selten — Monat hat
    // typisch <30 Tage × 5 Lektionen = 150 Termine, das passt).
    if (Buffer.byteLength(text, 'utf8') > 3800) {
      // Greedy split in 2 Teile, naiv: erste Hälfte der Tage, zweite Hälfte
      const half = Math.ceil(dayKeys.length / 2);
      const part1Dates = dayKeys.slice(0, half);
      const part2Dates = dayKeys.slice(half);
      messages.push(buildMonthMessage(monthLabel + ' (Teil 1)', part1Dates, byDay));
      messages.push(buildMonthMessage(monthLabel + ' (Teil 2)', part2Dates, byDay));
    } else {
      messages.push(text);
    }
  }

  return { messages, totalEvents: rows.length, totalMonths: monthKeys.length };
}

function buildMonthMessage(label, dayKeys, byDay) {
  const totalEvents = dayKeys.reduce((s, d) => s + byDay[d].length, 0);
  let text = '📋 <b>' + escapeHtml(label) + '</b>  <i>(' + totalEvents + ' Termine)</i>\n';
  for (const date of dayKeys) {
    text += '\n━━ <b>' + escapeHtml(dayLabel(date)) + '</b> ━━\n';
    for (const r of byDay[date]) {
      text += '\n🕐 <b>' + r.zeit_von + '–' + r.zeit_bis + '</b>  ' + escapeHtml(r.veranstaltung) + '\n';
      const bits = [];
      if (r.raum) bits.push('🏫 ' + r.raum);
      if (r.dozent) bits.push('👤 ' + r.dozent);
      if (bits.length) text += '   <i>' + escapeHtml(bits.join('  ·  ')) + '</i>\n';
    }
  }
  return text;
}

// Sendet alle Monatsblöcke als separate Telegram-Messages und parkt die IDs
// in state.multiMessageIds — beim nächsten "Menü" o.ä. werden sie gelöscht.
// Editiert die Trigger-Message (callback-source) zur kompakten Übersicht.
async function sendStundenplanAlle(chatId, triggerMessageId) {
  // Erst alte Multi-Messages löschen (falls existent)
  await purgeMultiMessages(chatId);

  const { messages, totalEvents, totalMonths } = buildMonthlyStundenplan();

  // Trigger-Message wird zur Übersicht
  const overviewKb = stundenplanNav('stundenplan_alle');
  let overviewText;
  if (!messages.length) {
    overviewText = '📋 <b>Stundenplan — Alle</b>\n\nKeine kommenden Termine. 🎉';
    try {
      await tg('editMessageText', {
        chat_id: chatId,
        message_id: triggerMessageId,
        text: truncate(overviewText),
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: overviewKb
      });
    } catch (_) { /* ignore */ }
    return;
  }

  overviewText = '📋 <b>Stundenplan — Alle</b>\n\n'
              + '<b>' + totalEvents + '</b> Termine in <b>' + totalMonths + '</b> Monaten\n'
              + '<i>Pro Monat eine Nachricht — werden gelöscht beim Wechsel zurück.</i>';
  try {
    await tg('editMessageText', {
      chat_id: chatId,
      message_id: triggerMessageId,
      text: truncate(overviewText),
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: overviewKb
    });
  } catch (_) { /* ignore */ }

  // Sende eine Message pro Monatsblock (älteste oben, neueste unten — Telegram
  // zeigt neue Messages unten, also chronologisch wie wir's wollen).
  const newIds = [];
  for (const text of messages) {
    try {
      const sent = await tg('sendMessage', {
        chat_id: chatId,
        text: truncate(text),
        parse_mode: 'HTML',
        disable_web_page_preview: true
      });
      if (sent && sent.message_id) newIds.push(sent.message_id);
    } catch (e) {
      state.logger?.log('Telegram sendStundenplanAlle: ' + (e.message || e), 'warn');
    }
  }
  state.multiMessageIds = newIds;
}

// Löscht alle bisher gesendeten Multi-Messages (best-effort).
async function purgeMultiMessages(chatId) {
  if (!state.multiMessageIds || !state.multiMessageIds.length) return;
  const ids = state.multiMessageIds.slice();
  state.multiMessageIds = [];
  for (const mid of ids) {
    tg('deleteMessage', { chat_id: chatId, message_id: mid }).catch(() => {});
  }
}

async function screenStatus() {
  const s = state.getStatus ? state.getStatus() : null;
  const database = db.open();
  let stats;
  try { stats = db.getStats(database); } finally { database.close(); }

  let text = '📟 <b>Server-Status</b>\n\n';
  if (s) {
    // Live-Tracking während eines Scrapes
    if (s.running) {
      const phase = s.currentPhase || 'starting';
      const phaseLabel = PHASE_LABELS_DE[phase] || phase;
      const elapsed = elapsedSec(s.phaseStartedAt);
      text += '🔄 <b>Scrape läuft</b>\n';
      text += '   Phase: <b>' + escapeHtml(phaseLabel) + '</b>';
      if (elapsed != null) text += '  <i>(' + elapsed + 's)</i>';
      text += '\n';
    } else if (s.lastError) {
      text += '⚠️ <b>Letzter Run mit Fehler</b>\n';
    } else {
      text += '💤 <b>Idle</b>\n';
    }

    text += '\n<b>Zeitplan</b>\n';
    text += '· Letzter Run: <b>' + escapeHtml(formatDateTime(s.lastRun)) + '</b>\n';
    text += '· Nächster Run: <b>'
         + escapeHtml(s.nextRun ? formatDateTime(s.nextRun) : (s.enabled ? '(berechnend)' : 'manuell'))
         + '</b>\n';
    text += '· Auto-Run: <b>' + (s.enabled ? `ein (${s.intervalMinutes} Min)` : 'aus') + '</b>\n';

    // Wochen-Refresh
    text += '\n<b>Wochen-Check</b>  <i>(Sa 03:00)</i>\n';
    text += '· Letzter: <b>'
         + escapeHtml(s.lastWeeklyDetailAt ? formatDateTime(s.lastWeeklyDetailAt) : 'noch nie')
         + '</b>\n';
    text += '· Nächster: <b>'
         + escapeHtml(s.nextWeeklyRun ? formatDateTime(s.nextWeeklyRun) : '–')
         + '</b>\n';

    // Letzter Lauf-Summary
    const ls = s.lastStats;
    if (ls && !s.running) {
      text += '\n<b>Letzter Lauf</b>\n';
      const n = ls.noten || {};
      const sp = ls.stundenplan || {};
      const det = ls.detail || {};
      text += '· Noten: <b>' + (n.inserted || 0) + '</b> neu, <b>' + (n.changed || 0) + '</b> geändert\n';
      text += '· Stundenplan: <b>' + (sp.inserted || 0) + '</b> neu';
      if (ls.pruned) text += ', <b>' + ls.pruned + '</b> vergangen entfernt';
      text += '\n';
      if (det.modulesScraped) {
        text += '· Details: <b>' + det.modulesScraped + '</b> Modul(e), <b>' + (det.totalEntries || 0) + '</b> Prüfung(en)';
        if (det.errors) text += ' <i>(' + det.errors + ' Fehler)</i>';
        text += '\n';
      }
    }

    if (s.lastError) {
      text += '\n⚠️ <b>Letzter Fehler:</b>\n<code>' + escapeHtml(s.lastError) + '</code>\n';
    }
  } else {
    text += '<i>Status-Info nicht verfügbar.</i>\n';
  }
  text += '\n📊 <b>DB</b>: ' + stats.notenCount + ' Noten · ' + stats.notenWithGradeCount + ' benotet · ' + stats.stundenplanUpcoming + ' Events';

  // Aktualisieren-Button + Menü zurück
  const keyboard = {
    inline_keyboard: [
      [
        { text: '🔄 Aktualisieren', callback_data: 'status' },
        { text: '⬅️ Menü', callback_data: 'menu' }
      ]
    ]
  };
  return { text, keyboard };
}

// OK-Button schließt zum Menü.
function okMenuKb() {
  return {
    inline_keyboard: [
      [{ text: '✓ OK', callback_data: 'menu' }]
    ]
  };
}

// Baut den Live-Status-Text für die /scrape-Message basierend auf state.
// running=true → Phase + Sekunden seit Phasen-Start.
// running=false → finale Zusammenfassung (oder Fehler).
function buildScrapeLiveText(s) {
  if (!s) return '🔄 <b>Scrape gestartet</b>';
  if (s.running) {
    const phase = s.currentPhase || 'starting';
    const phaseLabel = PHASE_LABELS_DE[phase] || phase;
    const elapsed = elapsedSec(s.phaseStartedAt);
    let text = '🔄 <b>Scrape läuft…</b>\n\n';
    text += '<b>Phase:</b> ' + escapeHtml(phaseLabel);
    if (elapsed != null) text += '  <i>(' + elapsed + 's)</i>';
    return text;
  }
  // Fertig
  if (s.lastError) {
    return '❌ <b>Scrape-Fehler</b>\n<code>' + escapeHtml(s.lastError) + '</code>';
  }
  let text = '✅ <b>Scrape fertig</b>\n\n';
  if (s.lastRun) text += '<i>' + escapeHtml(formatDateTime(s.lastRun)) + '</i>\n\n';
  const ls = s.lastStats;
  if (ls) {
    const n = ls.noten || {};
    const sp = ls.stundenplan || {};
    const det = ls.detail || {};
    text += '· Noten: <b>' + (n.inserted || 0) + '</b> neu, <b>' + (n.changed || 0) + '</b> geändert\n';
    text += '· Stundenplan: <b>' + (sp.inserted || 0) + '</b> neu';
    if (ls.pruned) text += ', <b>' + ls.pruned + '</b> vergangen entfernt';
    text += '\n';
    if (det.modulesScraped) {
      text += '· Details: <b>' + det.modulesScraped + '</b> Modul(e), <b>' + (det.totalEntries || 0) + '</b> Prüfung(en)';
      if (det.errors) text += ' <i>(' + det.errors + ' Fehler)</i>';
      text += '\n';
    }
  }
  return text.trim();
}

// Stoppt den Live-Polling-Timer für die /scrape-Message.
function stopScrapePoll() {
  if (state.scrapePollTimer) {
    clearInterval(state.scrapePollTimer);
    state.scrapePollTimer = null;
  }
  state.scrapeMessage = null;
}

// Startet das Live-Polling auf einer bestimmten Message. Editiert sie alle
// 2.5s mit dem aktuellen Status, bis state.running false wird — dann ein
// finaler Edit mit Summary, danach stop.
function startScrapePoll(chatId, messageId) {
  // Falls schon läuft (z.B. doppelter /scrape), alten Timer stoppen
  stopScrapePoll();
  state.scrapeMessage = { chatId, messageId };

  let lastText = null;
  let stoppedAfterDone = false;

  const tick = async () => {
    // Sicherheit: User hat zur Menü navigiert → Message gehört nicht mehr uns
    if (!state.scrapeMessage || state.scrapeMessage.messageId !== messageId) {
      stopScrapePoll();
      return;
    }
    const s = state.getStatus ? state.getStatus() : null;
    const text = buildScrapeLiveText(s);

    // Nur editieren wenn sich was geändert hat — spart Telegram-API-Calls
    if (text !== lastText) {
      try {
        await tg('editMessageText', {
          chat_id: chatId,
          message_id: messageId,
          text: truncate(text),
          parse_mode: 'HTML',
          disable_web_page_preview: true,
          reply_markup: okMenuKb()
        });
        lastText = text;
      } catch (e) {
        // Message wurde gelöscht oder ist zu alt → Polling stoppen
        if (/message.*not found|message can't be edited/i.test(e.message || '')) {
          stopScrapePoll();
          return;
        }
      }
    }

    // Wenn Scrape fertig: einmal noch updaten (mit Summary), dann stop
    if (s && !s.running) {
      if (stoppedAfterDone) {
        stopScrapePoll();
      } else {
        stoppedAfterDone = true; // nächster Tick stoppt
      }
    }
  };

  // Erster Tick sofort, dann alle 2.5s
  state.scrapePollTimer = setInterval(tick, 2500);
  tick().catch(() => {});
}

async function screenScrape() {
  if (!state.triggerScrape) {
    return { text: '⚠️ Scrape-Trigger nicht verfügbar.', keyboard: simpleNav() };
  }
  try {
    const r = await state.triggerScrape();
    if (r && r.triggered === false) {
      // Bereits aktiv → trotzdem Live-Tracking auf existierende Session
      // (das wird nach Render gestartet via showScrapeProgressFor)
      return {
        text: '⏳ <b>Bereits ein Scrape aktiv</b>'
            + (r.reason ? '\n<i>' + escapeHtml(r.reason) + '</i>' : ''),
        keyboard: okMenuKb(),
        startLivePoll: true
      };
    }
    return {
      text: '🔄 <b>Scrape gestartet</b>',
      keyboard: okMenuKb(),
      startLivePoll: true
    };
  } catch (e) {
    return {
      text: '❌ <b>Fehler</b>\n<code>' + escapeHtml(e.message || e) + '</code>',
      keyboard: okMenuKb()
    };
  }
}

const SCREENS = {
  menu: screenMenu,
  noten: screenNoten,
  durchschnitt: screenDurchschnitt,
  heute: screenHeute,
  morgen: screenMorgen,
  woche: screenWoche,
  stundenplan: screenStundenplan,
  status: screenStatus,
  scrape: screenScrape
};

// Slash-Command → Screen-Mapping (für Power-User)
const CMD_MAP = {
  '/start': 'menu',
  '/menu': 'menu',
  '/help': 'menu',
  '/noten': 'noten',
  '/durchschnitt': 'durchschnitt',
  '/heute': 'heute',
  '/morgen': 'morgen',
  '/woche': 'woche',
  '/stundenplan': 'stundenplan',
  '/scrape': 'scrape',
  '/status': 'status'
};

// ---------- Update-Handler ----------
async function handleMessage(msg) {
  if (!msg.text) return;
  const raw = msg.text.trim().split(/\s+/)[0].toLowerCase();
  const cmd = raw.split('@')[0];
  const screenName = CMD_MAP[cmd] || 'menu';

  // Wenn User auf einen anderen Command als /scrape wechselt → laufendes
  // Live-Polling stoppen, sonst würde der Polling-Timer das neue Screen
  // überschreiben.
  if (screenName !== 'scrape') stopScrapePoll();

  // Multi-Messages aufräumen sobald der User irgendeinen Slash-Command tippt
  // (kein Bedarf, die monatlichen Stundenplan-Posts noch im Chat zu lassen).
  if (state.multiMessageIds && state.multiMessageIds.length) {
    await purgeMultiMessages(msg.chat.id);
  }

  const screen = await SCREENS[screenName]();

  // Eine einzige Menu-Nachricht: editiere die letzte, sonst neu
  await showScreen(msg.chat.id, screen);

  // /scrape → Polling auf der gerade gerenderten Message starten
  if (screen.startLivePoll && state.lastMenuMessageId) {
    startScrapePoll(msg.chat.id, state.lastMenuMessageId);
  }

  // User-Command-Message löschen um Chat sauber zu halten (best-effort)
  tg('deleteMessage', { chat_id: msg.chat.id, message_id: msg.message_id }).catch(() => {});
}

async function handleCallback(cb) {
  // Spinner sofort wegnehmen
  tg('answerCallbackQuery', { callback_query_id: cb.id }).catch(() => {});

  if (!cb.message) return;
  const chatId = cb.message.chat.id;

  // Wenn der User von einer aktiven Scrape-Live-Message wegnavigiert,
  // Polling stoppen — sonst würde der Timer das Menü überschreiben.
  if (state.scrapeMessage && cb.message.message_id === state.scrapeMessage.messageId) {
    stopScrapePoll();
  }

  // Dismiss: Push-Message löschen
  if (cb.data === 'dismiss') {
    try {
      await tg('deleteMessage', { chat_id: chatId, message_id: cb.message.message_id });
    } catch (_) { /* best-effort */ }
    return;
  }

  // Spezial-Handler: Stundenplan „Alle" — sendet mehrere Messages
  if (cb.data === 'stundenplan_alle') {
    try {
      await sendStundenplanAlle(chatId, cb.message.message_id);
      state.lastMenuMessageId = cb.message.message_id;
    } catch (e) {
      state.logger?.log('Callback handler error (stundenplan_alle): ' + (e.message || e), 'error');
    }
    return;
  }

  // Bei JEDEM anderen Callback: zuerst die Multi-Messages bereinigen
  // (z.B. User klickt „Menü" oder „Heute" aus einer Multi-Message-Übersicht).
  if (state.multiMessageIds && state.multiMessageIds.length) {
    await purgeMultiMessages(chatId);
  }

  // Statische Screens
  let screenPromise = null;
  if (SCREENS[cb.data]) {
    screenPromise = SCREENS[cb.data]();
  } else if (cb.data && cb.data.startsWith('modul_')) {
    // Dynamischer Modul-Detail-Screen, callback_data = 'modul_<kuerzel_id>'
    const kuerzelId = cb.data.slice('modul_'.length);
    screenPromise = screenModulDetail(kuerzelId);
  } else {
    return; // unbekanntes callback ignorieren
  }

  try {
    const screen = await screenPromise;
    await editMessage(chatId, cb.message.message_id, screen.text, screen.keyboard);
    // Das Callback-Message IST jetzt das aktuelle Menü
    state.lastMenuMessageId = cb.message.message_id;
    // Wenn der Screen Live-Polling will (z.B. nach /scrape), starte den Timer
    // auf der Message die wir gerade editiert haben.
    if (screen.startLivePoll) {
      startScrapePoll(chatId, cb.message.message_id);
    }
  } catch (e) {
    state.logger?.log('Callback handler error: ' + (e.message || e), 'error');
    await tg('answerCallbackQuery', {
      callback_query_id: cb.id,
      text: '❌ ' + (e.message || 'Fehler'),
      show_alert: true
    }).catch(() => {});
  }
}

async function handleUpdate(update) {
  // Whitelist-Check für beide Update-Typen
  const from = (update.message?.from) || (update.callback_query?.from) || (update.edited_message?.from);
  if (!from || from.id !== state.allowedUserId) {
    state.logger?.log(`📱 Abgelehnt: User ${from?.id} (${from?.username || 'no username'})`, 'warn');
    return;
  }

  if (update.callback_query) return handleCallback(update.callback_query);
  if (update.message) return handleMessage(update.message);
  if (update.edited_message) return handleMessage(update.edited_message);
}

// ---------- Poll Loop ----------
async function pollLoop() {
  let backoff = 1000;
  while (state.running) {
    try {
      const updates = await tg('getUpdates', { offset: state.offset, timeout: 30, allowed_updates: ['message', 'edited_message', 'callback_query'] });
      backoff = 1000;
      for (const u of updates) {
        state.offset = u.update_id + 1;
        handleUpdate(u).catch(e => state.logger?.log('Update handler: ' + e.message, 'error'));
      }
    } catch (e) {
      if (!state.running) return;
      state.logger?.log('Bot poll error: ' + (e.message || e) + ' (retry in ' + Math.round(backoff / 1000) + 's)', 'warn');
      await new Promise(r => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 30000);
    }
  }
}

// ---------- Public API ----------
async function start(cfg) {
  if (!cfg.token) throw new Error('telegramToken fehlt');
  if (!cfg.allowedUserId) throw new Error('telegramAllowedUserId fehlt');
  if (state.running) return;

  state.token = cfg.token;
  state.allowedUserId = Number(cfg.allowedUserId);
  state.logger = cfg.logger || null;
  state.triggerScrape = cfg.triggerScrape || null;
  state.getStatus = cfg.getStatus || null;
  state.running = true;

  try {
    const me = await tg('getMe');
    state.logger?.log(`📱 Telegram-Bot @${me.username} online, Whitelist: ${state.allowedUserId}`, 'info');
    // Set Command-Menü im Telegram-Client ("/" zeigt Liste)
    tg('setMyCommands', {
      commands: [
        { command: 'menu', description: 'Hauptmenü öffnen' },
        { command: 'noten', description: 'Alle Noten + Durchschnitt' },
        { command: 'durchschnitt', description: 'Nur Durchschnitt' },
        { command: 'heute', description: 'Stundenplan heute' },
        { command: 'morgen', description: 'Stundenplan morgen' },
        { command: 'woche', description: 'Nächste Woche' },
        { command: 'stundenplan', description: 'Alle kommenden Lektionen' },
        { command: 'scrape', description: 'Manueller Scrape' },
        { command: 'status', description: 'Server-Status' }
      ]
    }).catch(() => {});
  } catch (e) {
    state.running = false;
    throw new Error('Telegram-Token ungültig: ' + (e.message || e));
  }

  pollLoop();
}

function stop() {
  state.running = false;
  state.logger?.log('📱 Telegram-Bot gestoppt', 'info');
}

async function notify(text, opts = {}) {
  if (!state.running || !state.allowedUserId) return;
  try {
    await sendPush(state.allowedUserId, text, opts.keyboard);
  } catch (e) {
    state.logger?.log('Telegram notify failed: ' + e.message, 'warn');
  }
}

// Formatiert die Prüfungs-Liste eines Moduls als kompakten Block.
// Reihenfolge: ZP zuerst, dann LB, dann OTHER (siehe db.getPruefungen).
// Layout: Type-Badge (ZP/LB) + Nummer + Gewicht + Note. Ohne Bezeichnungs-
// Doppelung wenn Bezeichnung redundant ist (z.B. "LB" + Typ "LB").
function formatPruefungenBlock(pruefungen) {
  if (!pruefungen || !pruefungen.length) return '';
  const lines = [];
  for (const p of pruefungen) {
    const note = p.bewertung != null ? Number(p.bewertung).toFixed(1) : '—';
    const color = formatNoteColor(p.bewertung);
    // Label-Strategie:
    //   - ZP/LB → "<typ> <nr>"  (z.B. "LB 1", "ZP 2")
    //   - OTHER → originale bezeichnung (z.B. "Mündliche Prüfung")
    let label;
    if (p.pruefung_typ === 'OTHER') {
      label = p.bezeichnung || ('Prüfung ' + (p.pruefung_nr || ''));
    } else {
      label = p.pruefung_typ + ' ' + (p.pruefung_nr || '');
    }
    const gewicht = p.gewicht ? ' <i>' + escapeHtml(p.gewicht) + '</i>' : '';
    lines.push('   ' + color + ' <code>' + escapeHtml(label) + '</code>' + gewicht + '  <b>' + note + '</b>');
  }
  return lines.join('\n');
}

/**
 * Detaillierte Push-Nachricht bei Noten-Änderungen.
 * changes: Array von { type, kuerzel_id, fach_name, semester, prev_note, new_note }
 * stats:   optional, getStats-Ergebnis für Ø-Anzeige
 * pruefungenByKuerzel: optional, { kuerzel_id: [pruefungen...] } — zeigt LB/ZP-Liste
 */
async function notifyGradeChanges(changes, stats, pruefungenByKuerzel) {
  if (!state.running || !state.allowedUserId) return;
  if (!changes || !changes.length) return;

  const news = changes.filter(c => c.type === 'new');
  const upd = changes.filter(c => c.type === 'changed');

  let text;
  if (changes.length === 1) {
    const c = changes[0];
    text = c.type === 'new'
      ? '🎉 <b>Neue Note!</b>\n\n'
      : '📝 <b>Note aktualisiert</b>\n\n';
  } else {
    const parts = [];
    if (news.length) parts.push(news.length + ' neue');
    if (upd.length) parts.push(upd.length + ' geändert');
    text = '🔔 <b>Noten-Update</b>  <i>(' + parts.join(', ') + ')</i>\n\n';
  }

  // Neue Noten zuerst, dann Änderungen — je sortiert nach Note absteigend
  const sections = [
    { list: news, label: news.length && changes.length > 1 ? '🎉 <b>Neu</b>' : null },
    { list: upd,  label: upd.length && changes.length > 1 ? '📝 <b>Geändert</b>' : null }
  ];

  for (const sec of sections) {
    if (!sec.list.length) continue;
    if (sec.label) text += sec.label + '\n';
    sec.list.sort((a, b) => (b.new_note || 0) - (a.new_note || 0));
    for (const c of sec.list) {
      const sem = c.semester ? '  <i>' + escapeHtml(c.semester) + '</i>' : '';
      const mod = extractModulNummer(c);
      const modPrefix = mod ? '<code>' + escapeHtml(mod) + '</code> ' : '';
      text += '📚 ' + modPrefix + '<b>' + escapeHtml(c.fach_name) + '</b>' + sem + '\n';
      if (c.type === 'new') {
        text += '   ' + formatNoteColor(c.new_note) + ' <b>' + c.new_note.toFixed(1) + '</b>\n';
      } else {
        const prevColor = formatNoteColor(c.prev_note);
        const newColor = formatNoteColor(c.new_note);
        const prevStr = c.prev_note != null ? c.prev_note.toFixed(1) : '—';
        const newStr = c.new_note != null ? c.new_note.toFixed(1) : '—';
        const arrow = c.prev_note != null && c.new_note != null
          ? (c.new_note > c.prev_note ? ' 📈' : c.new_note < c.prev_note ? ' 📉' : '')
          : '';
        text += '   ' + prevColor + ' ' + prevStr + '  →  ' + newColor + ' <b>' + newStr + '</b>' + arrow + '\n';
      }
      // Detail-Prüfungen für dieses Modul (falls vom Aufrufer bereitgestellt)
      const ps = pruefungenByKuerzel && c.kuerzel_id ? pruefungenByKuerzel[c.kuerzel_id] : null;
      if (ps && ps.length) {
        text += formatPruefungenBlock(ps) + '\n';
      }
      text += '\n';
    }
  }

  text += '━━━━━━━━━━━━━━━━━━\n';
  if (stats && stats.avgNote != null) {
    text += '🎯 Ø gesamt: <b>' + stats.avgNote + '</b>';
    if (stats.avgBySemester && Object.keys(stats.avgBySemester).length) {
      const parts = Object.entries(stats.avgBySemester)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([s, v]) => `${s}: <b>${v}</b>`);
      text += '  ·  ' + parts.join(' · ');
    }
  }

  const keyboard = {
    inline_keyboard: [
      [
        { text: '📚 Alle Noten', callback_data: 'noten' },
        { text: '📟 Menü', callback_data: 'menu' }
      ]
    ]
  };

  try {
    await sendPush(state.allowedUserId, text, keyboard);
  } catch (e) {
    state.logger?.log('Telegram notifyGradeChanges failed: ' + e.message, 'warn');
  }
}

/**
 * Push-Nachricht bei Raumwechsel / Online-Switch.
 * changes: Array von { datum_iso, zeit_von, zeit_bis, veranstaltung, dozent,
 *                       prev_raum, new_raum, wentOnline, wentOffline }
 */
async function notifyRoomChanges(changes) {
  if (!state.running || !state.allowedUserId) return;
  if (!changes || !changes.length) return;

  // Gruppierung: "went online" separat herausheben (auffälligste Änderung)
  const online = changes.filter(c => c.wentOnline);
  const offline = changes.filter(c => c.wentOffline);
  const rest = changes.filter(c => !c.wentOnline && !c.wentOffline);

  let text;
  if (changes.length === 1) {
    const c = changes[0];
    if (c.wentOnline) text = '🌐 <b>Lektion wechselt auf ONLINE</b>\n\n';
    else if (c.wentOffline) text = '🏫 <b>Lektion wechselt zu Präsenz</b>\n\n';
    else text = '📍 <b>Raumwechsel</b>\n\n';
  } else {
    const parts = [];
    if (online.length) parts.push(online.length + ' online');
    if (offline.length) parts.push(offline.length + ' präsenz');
    if (rest.length) parts.push(rest.length + ' raumwechsel');
    text = '📍 <b>' + changes.length + ' Lektionen geändert</b>  <i>(' + parts.join(', ') + ')</i>\n\n';
  }

  const sections = [
    { list: online,  icon: '🌐', label: online.length && changes.length > 1 ? '🌐 <b>Jetzt online</b>' : null },
    { list: offline, icon: '🏫', label: offline.length && changes.length > 1 ? '🏫 <b>Jetzt Präsenz</b>' : null },
    { list: rest,    icon: '📍', label: rest.length && changes.length > 1 ? '📍 <b>Raumwechsel</b>' : null }
  ];

  for (const sec of sections) {
    if (!sec.list.length) continue;
    if (sec.label) text += sec.label + '\n\n';
    sec.list.sort((a, b) => (a.datum_iso + a.zeit_von).localeCompare(b.datum_iso + b.zeit_von));
    for (const c of sec.list) {
      const datum = dayLabel(c.datum_iso);
      text += '<b>' + escapeHtml(datum) + '</b>\n';
      text += '🕐 ' + c.zeit_von + '–' + c.zeit_bis + '\n';
      text += '📚 ' + escapeHtml(c.veranstaltung) + '\n';
      text += '🏫 <s>' + escapeHtml(c.prev_raum) + '</s> → <b>' + escapeHtml(c.new_raum) + '</b>\n';
      if (c.dozent) text += '👤 ' + escapeHtml(c.dozent) + '\n';
      text += '\n';
    }
  }

  const keyboard = {
    inline_keyboard: [
      [
        { text: '☀️ Heute', callback_data: 'heute' },
        { text: '🌅 Morgen', callback_data: 'morgen' },
        { text: '📆 Woche', callback_data: 'woche' }
      ]
    ]
  };

  try {
    await sendPush(state.allowedUserId, text.trim(), keyboard);
  } catch (e) {
    state.logger?.log('Telegram notifyRoomChanges failed: ' + e.message, 'warn');
  }
}

/**
 * Wöchentlicher Detail-Refresh-Bericht — Push wird ausgelöst wenn der
 * samstägliche Full-Scrape neue ZP/LB-Einträge entdeckt hat, OHNE dass
 * sich die Modulnote geändert hätte (Edge-Case ZP=5.5 + LB=5.5).
 *
 * report: Array von { kuerzel_id, kuerzel_code, fach_name, semester, added: [...] }
 *   added = Array von { pruefung_typ, pruefung_nr, bezeichnung, gewicht, bewertung }
 * Leeres Report-Array → kein Push.
 */
async function notifyWeeklyDetailReport(report) {
  if (!state.running || !state.allowedUserId) return;
  if (!Array.isArray(report) || !report.length) return;

  const totalAdded = report.reduce((sum, r) => sum + (r.added ? r.added.length : 0), 0);
  if (!totalAdded) return;

  let text = '🔍 <b>Wochen-Check</b>  <i>(' + totalAdded + ' neue Prüfung'
           + (totalAdded === 1 ? '' : 'en') + ')</i>\n\n';
  text += '<i>Diese ZP/LB sind seit dem letzten Check dazugekommen — die Modulnote selbst hat sich aber nicht geändert.</i>\n\n';

  for (const m of report) {
    if (!m.added || !m.added.length) continue;
    const sem = m.semester ? '  <i>' + escapeHtml(m.semester) + '</i>' : '';
    const mod = extractModulNummer(m);
    const modPrefix = mod ? '<code>' + escapeHtml(mod) + '</code> ' : '';
    text += '📚 ' + modPrefix + '<b>' + escapeHtml(m.fach_name || m.kuerzel_id) + '</b>' + sem + '\n';

    // Sortierung: ZP vor LB vor OTHER, dann nach nr
    const sorted = [...m.added].sort((a, b) => {
      const order = { ZP: 0, LB: 1, OTHER: 2 };
      const oa = order[a.pruefung_typ] != null ? order[a.pruefung_typ] : 9;
      const ob = order[b.pruefung_typ] != null ? order[b.pruefung_typ] : 9;
      if (oa !== ob) return oa - ob;
      return (a.pruefung_nr || 0) - (b.pruefung_nr || 0);
    });

    for (const p of sorted) {
      const note = p.bewertung != null ? Number(p.bewertung).toFixed(1) : '—';
      const color = formatNoteColor(p.bewertung);
      const label = p.pruefung_typ === 'OTHER'
        ? (p.bezeichnung || ('Prüfung ' + (p.pruefung_nr || '')))
        : (p.pruefung_typ + ' ' + (p.pruefung_nr || ''));
      const gewicht = p.gewicht ? ' <i>' + escapeHtml(p.gewicht) + '</i>' : '';
      text += '   ' + color + ' <code>' + escapeHtml(label) + '</code>' + gewicht + '  <b>' + note + '</b>\n';
    }
    text += '\n';
  }

  const keyboard = {
    inline_keyboard: [
      [
        { text: '📚 Alle Noten', callback_data: 'noten' },
        { text: '📟 Menü', callback_data: 'menu' }
      ]
    ]
  };

  try {
    await sendPush(state.allowedUserId, text.trim(), keyboard);
  } catch (e) {
    state.logger?.log('Telegram notifyWeeklyDetailReport failed: ' + e.message, 'warn');
  }
}

module.exports = { start, stop, notify, notifyGradeChanges, notifyRoomChanges, notifyWeeklyDetailReport };
