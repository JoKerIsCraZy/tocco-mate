/**
 * Tocco Mate — Web-Push Notification Layer.
 *
 * - VAPID-Keys werden bei Boot generiert wenn nicht in .env gesetzt
 *   (Fallback-Datei data/vapid.json — wird auch von .env überschrieben).
 * - Subscriptions in der SQLite-Tabelle push_subscriptions.
 * - sendToAll() ist best-effort: 410 (Gone) entfernt die Subscription.
 *
 * Das Modul ist defensiv geschrieben — wenn web-push nicht installiert ist,
 * wird es im Server.js bewusst optional geladen (try/catch). Hier setzen wir
 * voraus dass es verfügbar ist.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const webpush = require('web-push');
const db = require('./db');

const VAPID_FILE = path.join(process.cwd(), 'data', 'vapid.json');

let _keys = null;       // { publicKey, privateKey, subject }
let _initialized = false;

function loadOrGenerateKeys(envSubject) {
  // 1) Aus .env (höchste Priorität)
  const envPub = process.env.VAPID_PUBLIC_KEY;
  const envPriv = process.env.VAPID_PRIVATE_KEY;
  const envSubj = process.env.VAPID_SUBJECT || envSubject || 'mailto:admin@example.com';
  if (envPub && envPriv) {
    return { publicKey: envPub, privateKey: envPriv, subject: envSubj };
  }

  // 2) Aus data/vapid.json
  if (fs.existsSync(VAPID_FILE)) {
    try {
      const j = JSON.parse(fs.readFileSync(VAPID_FILE, 'utf8'));
      if (j.publicKey && j.privateKey) {
        return { publicKey: j.publicKey, privateKey: j.privateKey, subject: j.subject || envSubj };
      }
    } catch (_) { /* fallthrough → regenerate */ }
  }

  // 3) Erst-Generierung
  const fresh = webpush.generateVAPIDKeys();
  const out = { publicKey: fresh.publicKey, privateKey: fresh.privateKey, subject: envSubj };
  try {
    fs.mkdirSync(path.dirname(VAPID_FILE), { recursive: true });
    fs.writeFileSync(VAPID_FILE, JSON.stringify(out, null, 2), { mode: 0o600 });
  } catch (_) { /* nicht persistierbar — keys leben nur in-process */ }
  return out;
}

function init(opts) {
  if (_initialized) return _keys;
  _keys = loadOrGenerateKeys(opts && opts.subject);
  webpush.setVapidDetails(_keys.subject, _keys.publicKey, _keys.privateKey);
  _initialized = true;
  return _keys;
}

function getPublicKey() {
  if (!_initialized) init();
  return _keys.publicKey;
}

function addSubscription(database, sub, ua) {
  if (!_initialized) init();
  db.addPushSubscription(database, sub, ua);
}

function removeSubscription(database, endpoint) {
  return db.removePushSubscription(database, endpoint);
}

/**
 * Sendet ein Notification-Payload an EINE Subscription.
 * Returnt { ok: true } | { ok: false, gone: true } | { ok: false, error }.
 */
async function sendOne(subscription, payloadObj) {
  if (!_initialized) init();
  const payload = JSON.stringify(payloadObj);
  try {
    await webpush.sendNotification(subscription, payload, { TTL: 86400 });
    return { ok: true };
  } catch (err) {
    const status = err && err.statusCode;
    // 404 / 410 = Subscription tot, sollte gelöscht werden.
    if (status === 404 || status === 410) return { ok: false, gone: true };
    return { ok: false, error: err && err.message };
  }
}

/**
 * Sendet ein Notification-Payload an ALLE registrierten Subscriptions.
 * Tote Subscriptions werden silently aus der DB entfernt.
 *
 * @param {{title:string, body:string, url?:string, tag?:string}} payload
 * @param {*} database optional — falls null wird ein eigener db.open() gemacht.
 */
async function sendToAll(payload, database) {
  if (!_initialized) init();
  const ownDb = !database;
  const d = database || db.open();
  try {
    const subs = db.getAllPushSubscriptions(d);
    if (!subs.length) return { sent: 0, removed: 0 };

    const tasks = subs.map(async (s) => {
      const subscription = {
        endpoint: s.endpoint,
        keys: { p256dh: s.p256dh, auth: s.auth }
      };
      const r = await sendOne(subscription, payload);
      if (r.gone) {
        try { db.removePushSubscription(d, s.endpoint); } catch (_) {}
      }
      return r;
    });

    const results = await Promise.allSettled(tasks);
    let sent = 0, removed = 0;
    results.forEach((r) => {
      if (r.status !== 'fulfilled') return;
      if (r.value.ok) sent++;
      else if (r.value.gone) removed++;
    });
    return { sent, removed };
  } finally {
    if (ownDb) try { d.close(); } catch (_) {}
  }
}

/* ============================================================
   High-level helpers — formatieren Diff-Events aus saveNoten /
   saveStundenplan in lesbare Push-Notifications.
   ============================================================ */

function notifyGradeChanges(gradeChanges, database) {
  if (!Array.isArray(gradeChanges) || !gradeChanges.length) return Promise.resolve(null);
  const news = gradeChanges.filter(g => g.type === 'new');
  const upd  = gradeChanges.filter(g => g.type === 'changed');

  // Bei wenigen Events: Detail-Push pro Modul.
  // Bei vielen: ein zusammenfassendes Push (sonst Notification-Spam).
  if (gradeChanges.length <= 3) {
    const tasks = gradeChanges.map((c) => {
      const subj = (c.fach_name || c.kuerzel_code || 'Modul');
      const note = c.new_note != null ? c.new_note.toFixed(1) : '—';
      const title = c.type === 'new'
        ? '🆕 Neue Note: ' + subj
        : '✏️ Note geändert: ' + subj;
      const prev = c.prev_note != null ? c.prev_note.toFixed(1) : '—';
      const body = c.type === 'new'
        ? 'Neue Bewertung: ' + note
        : 'Von ' + prev + ' → ' + note;
      return sendToAll({
        title, body,
        url: '/mobile/#/modul/' + encodeURIComponent(c.kuerzel_id) + '?code=' + encodeURIComponent(c.kuerzel_code || ''),
        tag: 'grade-' + c.kuerzel_id
      }, database);
    });
    return Promise.allSettled(tasks);
  }
  return sendToAll({
    title: '📚 Notenupdate',
    body: news.length + ' neue · ' + upd.length + ' geändert',
    url: '/mobile/#/noten',
    tag: 'grade-summary'
  }, database);
}

function notifyRoomChanges(roomChanges, database) {
  if (!Array.isArray(roomChanges) || !roomChanges.length) return Promise.resolve(null);

  if (roomChanges.length <= 3) {
    const tasks = roomChanges.map((c) => {
      const arrow = c.wentOnline ? '🌐' : (c.wentOffline ? '🏫' : '🚪');
      const dateLabel = formatDay(c.datum_iso);
      const title = arrow + ' Zimmerwechsel: ' + (c.veranstaltung || 'Termin');
      const body = dateLabel + ' ' + (c.zeit_von || '') + ' · ' + c.prev_raum + ' → ' + c.new_raum;
      return sendToAll({
        title, body,
        url: '/mobile/#/stundenplan',
        tag: 'room-' + (c.datum_iso || '') + '-' + (c.zeit_von || '')
      }, database);
    });
    return Promise.allSettled(tasks);
  }
  return sendToAll({
    title: '🏫 Stundenplan-Änderungen',
    body: roomChanges.length + ' Zimmerwechsel — siehe Stundenplan',
    url: '/mobile/#/stundenplan',
    tag: 'room-summary'
  }, database);
}

function formatDay(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso + 'T00:00:00');
    return d.toLocaleDateString('de-DE', { weekday: 'short', day: 'numeric', month: 'short' });
  } catch (_) {
    return iso;
  }
}

module.exports = {
  init,
  getPublicKey,
  addSubscription,
  removeSubscription,
  sendOne,
  sendToAll,
  notifyGradeChanges,
  notifyRoomChanges
};
