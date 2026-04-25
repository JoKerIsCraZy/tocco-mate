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
  lastMenuMessageId: null  // Nur EIN Menü-Message, wird editiert statt dupliziert
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

function truncate(text) {
  const MAX = 4000;
  if (text.length <= MAX) return text;
  return text.slice(0, MAX - 30) + '\n\n<i>… (gekürzt)</i>';
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
    { text: '📋 Gesamt', data: 'stundenplan' }
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
  return { text, keyboard: notenNav() };
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
  for (const date of Object.keys(byDate).sort()) {
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

async function screenStundenplan() {
  const today = isoToday(0);
  const database = db.open();
  let rows;
  try { rows = db.getStundenplan(database, { from: today, limit: 50 }); } finally { database.close(); }

  if (!rows.length) {
    return {
      text: '📋 <b>Stundenplan</b>\n\nKeine kommenden Termine. 🎉',
      keyboard: stundenplanNav('stundenplan')
    };
  }

  const byDate = {};
  for (const r of rows) (byDate[r.datum_iso] = byDate[r.datum_iso] || []).push(r);
  const dates = Object.keys(byDate).sort();

  let text = '📋 <b>Stundenplan</b>  <i>(' + rows.length + ' Termine, ' + dates.length + ' Tage)</i>\n';
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

async function screenStatus() {
  const s = state.getStatus ? state.getStatus() : null;
  const database = db.open();
  let stats;
  try { stats = db.getStats(database); } finally { database.close(); }

  let text = '📟 <b>Server-Status</b>\n\n';
  if (s) {
    text += (s.running ? '🔄 Läuft gerade…\n' : '💤 Idle\n');
    text += 'Letzter Run: <b>' + escapeHtml(formatDateTime(s.lastRun)) + '</b>\n';
    text += 'Nächster Run: <b>' + escapeHtml(s.nextRun ? formatDateTime(s.nextRun) : (s.enabled ? '(berechnend)' : 'manuell')) + '</b>\n';
    text += 'Auto-Run: <b>' + (s.enabled ? `ein (${s.intervalMinutes} Min)` : 'aus') + '</b>\n';
    if (s.lastError) text += '⚠️ Letzter Fehler: <code>' + escapeHtml(s.lastError) + '</code>\n';
  } else {
    text += '<i>Status-Info nicht verfügbar.</i>\n';
  }
  text += '\n📊 DB: <b>' + stats.notenCount + '</b> Noten · <b>' + stats.notenWithGradeCount + '</b> benotet · <b>' + stats.stundenplanUpcoming + '</b> Events';
  return { text, keyboard: simpleNav() };
}

async function screenScrape() {
  if (!state.triggerScrape) {
    return { text: '⚠️ Scrape-Trigger nicht verfügbar.', keyboard: simpleNav() };
  }
  try {
    const r = await state.triggerScrape();
    if (r && r.triggered === false) {
      return {
        text: '⏳ <b>Bereits ein Scrape aktiv</b>\n' + (r.reason ? '<i>' + escapeHtml(r.reason) + '</i>' : ''),
        keyboard: simpleNav()
      };
    }
    return {
      text: '🔄 <b>Scrape gestartet</b>\n\nDauert ca. 15–30 Sekunden. Du bekommst automatisch eine Nachricht bei neuen Noten oder Fehlern.',
      keyboard: simpleNav()
    };
  } catch (e) {
    return {
      text: '❌ <b>Fehler</b>\n<code>' + escapeHtml(e.message || e) + '</code>',
      keyboard: simpleNav()
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
  const screen = await SCREENS[screenName]();

  // Eine einzige Menu-Nachricht: editiere die letzte, sonst neu
  await showScreen(msg.chat.id, screen);

  // User-Command-Message löschen um Chat sauber zu halten (best-effort)
  tg('deleteMessage', { chat_id: msg.chat.id, message_id: msg.message_id }).catch(() => {});
}

async function handleCallback(cb) {
  // Spinner sofort wegnehmen
  tg('answerCallbackQuery', { callback_query_id: cb.id }).catch(() => {});

  if (!cb.message) return;

  // Dismiss: Push-Message löschen
  if (cb.data === 'dismiss') {
    try {
      await tg('deleteMessage', { chat_id: cb.message.chat.id, message_id: cb.message.message_id });
    } catch (_) { /* best-effort */ }
    return;
  }

  const handler = SCREENS[cb.data];
  if (!handler) return;

  try {
    const screen = await handler();
    await editMessage(cb.message.chat.id, cb.message.message_id, screen.text, screen.keyboard);
    // Das Callback-Message IST jetzt das aktuelle Menü
    state.lastMenuMessageId = cb.message.message_id;
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

/**
 * Detaillierte Push-Nachricht bei Noten-Änderungen.
 * changes: Array von { type, fach_name, semester, prev_note, new_note }
 * stats:   optional, getStats-Ergebnis für Ø-Anzeige
 */
async function notifyGradeChanges(changes, stats) {
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

module.exports = { start, stop, notify, notifyGradeChanges, notifyRoomChanges };
