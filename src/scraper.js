/**
 * Tocco WISS Scraper — pure reusable module.
 *
 * Exports runScrape(config, onLog) which performs the full login + scrape
 * pipeline and returns structured data. No console.log, no process.env,
 * no process.exit. All I/O side channels go through onLog(message, level).
 */

const fs = require('node:fs');
const path = require('node:path');

// ---------- Security Helpers ----------
// Entfernt sensitive Query-Parameter aus Fehlermeldungen / URLs.
function redact(s) {
  if (s == null) return '';
  return String(s).replace(
    /([?&](?:password|passwd|code|access_token|refresh_token|token|secret|api[-_]?key)=)[^&\s]+/gi,
    '$1[REDACTED]'
  );
}

function isDebug() {
  return process.env.DEBUG_SCRAPER === 'true';
}

// ---------- Browser Setup ----------
function requirePlaywright() {
  try { return require('playwright').chromium; }
  catch (e) {
    throw new Error('Playwright nicht installiert. Führe zuerst aus: npm install && npx playwright install chromium');
  }
}

// ---------- Fetch-Wrapper (läuft IM BROWSER, damit Session voll gilt) ----------
async function api(page, restBase, endpoint, opts = {}) {
  return page.evaluate(async ({ url, opts }) => {
    try {
      const res = await fetch(url, {
        method: opts.method || 'GET',
        credentials: 'include',
        headers: { 'Accept': 'application/json', ...(opts.headers || {}) },
        body: opts.body
      });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch (_) {}
      return { ok: res.ok, status: res.status, text, json };
    } catch (e) {
      return { ok: false, status: 0, text: String(e), json: null };
    }
  }, { url: restBase + endpoint, opts });
}

async function ensureLoggedIn(config, onLog) {
  const { msEmail, msPassword, baseUrl, headless, slowMo, storageFile, cwd } = config;
  const restBase = baseUrl + '/nice2';
  const chromium = requirePlaywright();
  onLog('🌐 Starte ' + (headless ? 'headless ' : 'sichtbaren ') + 'Chromium' + (slowMo ? ' (slow-mo ' + slowMo + 'ms)' : ''), 'info');
  const browser = await chromium.launch({ headless, slowMo });

  // 1. Versuch: gecachter State
  if (fs.existsSync(storageFile)) {
    onLog('♻️  Lade gespeicherten Browser-State (storage.json)...', 'info');
    const ctx = await browser.newContext({ storageState: storageFile });
    const pg = await ctx.newPage();
    await pg.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await pg.waitForTimeout(1500);
    const chk = await api(pg, restBase, '/username');
    if (chk.ok && !chk.text.includes('anonymous')) {
      const u = (chk.json && chk.json.username) || '(user)';
      onLog('✅ Session gültig, eingeloggt als ' + u, 'info');
      return { browser, context: ctx, page: pg };
    }
    onLog('⏰ Gecachte Session ungültig → neuer Login', 'info');
    await pg.close().catch(() => {});
    await ctx.close().catch(() => {});
  }

  // 2. Frischer Login
  if (!msEmail || !msPassword) {
    await browser.close();
    throw new Error('MS_EMAIL + MS_PASSWORD fehlen in config.');
  }
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    // kurzer Settle-Puffer statt networkidle (Tocco hat Dauer-Polling)
    await page.waitForTimeout(1500);
    onLog('📍 Geladen: ' + page.url(), 'info');

    // Falls die Seite schon direkt MS-Login zeigt (z.B. durch Session-Hint) → überspringen
    const alreadyAtMS = /login\.microsoft(online)?\.com|login\.live\.com/.test(page.url());

    let loginPage = page;
    if (!alreadyAtMS) {
      // Suche den "WISS Office 365" Button — mehrere Strategien
      onLog('🔍 Suche SSO-Button...', 'info');
      const strategies = [
        () => page.getByRole('link',   { name: /Office\s*365/i }),
        () => page.getByRole('button', { name: /Office\s*365/i }),
        () => page.getByText('WISS Office 365', { exact: false }),
        () => page.locator('a, button, input[type="submit"], input[type="button"]').filter({ hasText: /Office\s*365/i }),
        () => page.locator('input[value*="Office" i]'),
        () => page.locator('a[href*="saml" i], a[href*="oauth" i], a[href*="sso" i], a[href*="azure" i]').first()
      ];
      let clickTarget = null;
      for (let i = 0; i < strategies.length; i++) {
        const loc = strategies[i]().first();
        const n = await loc.count().catch(() => 0);
        if (n > 0) {
          clickTarget = loc;
          onLog('   Strategie ' + (i+1) + ' hat Button gefunden (' + n + ' Match' + (n>1?'es':'') + ')', 'info');
          break;
        }
      }

      if (!clickTarget) {
        // Diagnose: Screenshot immer (nützlich), DOM-Dump nur bei DEBUG_SCRAPER.
        const shot = path.join(cwd, 'debug-no-button.png');
        await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
        onLog('❌ Kein SSO-Button gefunden. Screenshot: ' + shot, 'error');

        if (isDebug()) {
          const allClickables = await page.evaluate(() => {
            const items = Array.from(document.querySelectorAll('a, button, input[type="submit"], input[type="button"]'));
            return items.map(el => ({
              tag: el.tagName,
              text: (el.textContent || el.value || '').trim().slice(0, 60),
              href: el.href || null,
              id: el.id || null,
              cls: el.className || null
            })).filter(x => x.text || x.href);
          });
          onLog('   [DEBUG] Klickbare Elemente auf der Seite:', 'error');
          allClickables.slice(0, 20).forEach(c => onLog('     ' + c.tag + '  "' + c.text + '"  ' + (c.href || ''), 'error'));
        }
        throw new Error('SSO-Button nicht lokalisierbar');
      }

      onLog('🔴 Klicke SSO-Button...', 'info');
      const popupPromise = context.waitForEvent('page', { timeout: 10000 }).catch(() => null);
      const navPromise = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => null);
      await clickTarget.click({ timeout: 10000 });
      const popup = await popupPromise;
      if (popup) {
        onLog('🪟 Popup erkannt → ' + popup.url(), 'info');
        await popup.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => {});
        loginPage = popup;
      } else {
        await navPromise;
        onLog('➡️  Navigation in gleicher Seite → ' + page.url(), 'info');
      }
    } else {
      onLog('ℹ️  Bereits auf Microsoft — überspringe SSO-Button', 'info');
    }

    // E-Mail-Feld (Microsoft login) — auf loginPage (kann page oder popup sein)
    const emailSel = 'input[type="email"]:visible, input[name="loginfmt"]:visible';
    await loginPage.waitForSelector(emailSel, { state: 'visible', timeout: 25000 });
    onLog('📧 Email eingeben...', 'info');
    await loginPage.click(emailSel);
    await loginPage.fill(emailSel, msEmail);
    await loginPage.waitForTimeout(300);
    onLog('➡️  Weiter-Button klicken...', 'info');
    await loginPage.click('input[type="submit"]:visible, button[type="submit"]:visible');

    // Warten bis URL sich ändert oder Passwortseite geladen ist (Federated Login möglich)
    await loginPage.waitForTimeout(1500);
    onLog('📍 Nach Email: ' + loginPage.url(), 'info');

    // Passwort — mit größerer Toleranz + Sichtbarkeitscheck
    const pwSel = 'input[type="password"]:visible, input[name="passwd"]:visible, input#passwordInput:visible';
    try {
      await loginPage.waitForSelector(pwSel, { state: 'visible', timeout: 25000 });
    } catch (e) {
      const shot = path.join(cwd, 'debug-no-password.png');
      await loginPage.screenshot({ path: shot, fullPage: true }).catch(() => {});
      onLog('❌ Passwortfeld nicht gefunden. Screenshot: ' + shot, 'error');
      onLog('   URL: ' + redact(loginPage.url()), 'error');

      if (isDebug()) {
        const inputs = await loginPage.evaluate(() => Array.from(document.querySelectorAll('input')).map(i => ({
          type: i.type, name: i.name || null, id: i.id || null,
          placeholder: i.placeholder || null, visible: i.offsetParent !== null
        })));
        onLog('   [DEBUG] Sichtbare Inputs:', 'error');
        inputs.filter(i => i.visible).forEach(i => onLog('     type=' + i.type + ' name=' + i.name + ' id=' + i.id + ' placeholder=' + i.placeholder, 'error'));
      }
      throw e;
    }

    onLog('🔑 Passwort eingeben...', 'info');
    const pwLoc = loginPage.locator(pwSel).first();
    await pwLoc.click();
    await loginPage.waitForTimeout(200);
    await pwLoc.fill('');
    await pwLoc.pressSequentially(msPassword, { delay: 20 });

    // Verify: Feld hat wirklich Inhalt (aber ohne Längen zu loggen).
    const pwLen = await pwLoc.evaluate(el => el.value.length).catch(() => 0);
    if (pwLen !== msPassword.length) {
      onLog('⚠️  Passwort-Eingabe unvollständig, versuche erneut...', 'warn');
      await pwLoc.click({ clickCount: 3 });
      await loginPage.keyboard.press('Delete');
      await pwLoc.pressSequentially(msPassword, { delay: 30 });
    }

    await loginPage.waitForTimeout(300);
    onLog('➡️  Anmelden-Button klicken...', 'info');
    await loginPage.click('input[type="submit"]:visible, button[type="submit"]:visible');
    await loginPage.waitForLoadState('domcontentloaded').catch(() => {});

    // "Angemeldet bleiben?" (KMSI) — Checkbox anhaken + Ja klicken
    onLog('⏳ Warte auf "Angemeldet bleiben"-Dialog...', 'info');
    try {
      await loginPage.waitForSelector(
        'input[name="DontShowAgain"], #KmsiCheckboxField, input#idBtn_Back, button#idSIButton9',
        { timeout: 15000 }
      );

      // Checkbox "Diese Meldung nicht mehr anzeigen" anhaken (falls vorhanden)
      const checkbox = loginPage.locator('input[name="DontShowAgain"], #KmsiCheckboxField').first();
      if (await checkbox.count().catch(() => 0)) {
        const isChecked = await checkbox.isChecked().catch(() => false);
        if (!isChecked) {
          onLog('☑️  "Angemeldet bleiben" Checkbox anhaken...', 'info');
          await checkbox.check({ timeout: 5000 }).catch(async () => {
            // Fallback: direkt klicken falls .check() nicht geht
            await checkbox.click({ force: true });
          });
          await loginPage.waitForTimeout(300);
        }
      }

      // "Ja" Button — mehrere mögliche Selektoren
      onLog('✔️  "Ja" klicken...', 'info');
      const yesBtn = loginPage.locator([
        'button#idSIButton9',
        'input#idSIButton9',
        'input[type="submit"][value="Ja"]',
        'input[type="submit"][value="Yes"]',
        'input[data-report-event="Signin_Submit"]',
        'input[type="submit"]:visible',
        'button[type="submit"]:visible'
      ].join(', ')).first();
      await yesBtn.click({ timeout: 10000 });
      await loginPage.waitForLoadState('domcontentloaded').catch(() => {});
    } catch (e) {
      onLog('ℹ️  KMSI-Dialog nicht erschienen oder schon durchgeklickt (' + redact((e.message || '').split('\n')[0]) + ')', 'info');
    }

    // Warten bis IRGENDWO (page oder popup) wieder auf tocco.ch
    onLog('⏳ Warte auf Redirect zurück zu Tocco...', 'info');
    await Promise.race([
      page.waitForURL(/tocco\.ch/, { timeout: 45000 }).catch(() => null),
      loginPage === page ? Promise.resolve() : loginPage.waitForURL(/tocco\.ch/, { timeout: 45000 }).catch(() => null)
    ]);
    // Wenn Popup: es schließt sich oft automatisch, Hauptseite lädt Tocco
    if (loginPage !== page && !loginPage.isClosed()) {
      await loginPage.close().catch(() => {});
    }
    // Hauptseite einmal reloaden falls sie noch auf Extranet-Landing steht
    if (!/tocco\.ch/.test(page.url()) || /extranet/i.test(page.url())) {
      await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
    }
    await page.waitForTimeout(2000);

    const cookies = await context.cookies();
    const toccoCookies = cookies.filter(c => c.domain.includes('tocco.ch'));

    if (!toccoCookies.length) throw new Error('Keine Tocco-Cookies nach Login — Flow möglicherweise unterbrochen.');

    // Verify: /username auf der echten Seite (nicht extern!)
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(1500);
    const verify = await api(page, restBase, '/username');
    if (!verify.ok || verify.text.includes('anonymous')) {
      throw new Error('Login lief durch, aber /username = anonymous. URL: ' + redact(page.url()));
    }
    const u = (verify.json && verify.json.username) || '(user)';
    onLog('✅ Eingeloggt als ' + u, 'info');

    // Storage State für nächstes Mal speichern (mit restriktiven Permissions).
    await context.storageState({ path: storageFile });
    try { fs.chmodSync(storageFile, 0o600); } catch (_) { /* Windows compat */ }
    onLog('💾 Browser-State gespeichert in storage.json', 'info');

    return { browser, context, page };
  } catch (e) {
    try {
      const shot = path.join(cwd, 'login-error.png');
      await page.screenshot({ path: shot, fullPage: true });
      onLog('📸 Screenshot: ' + shot, 'error');
    } catch (_) {}
    await browser.close().catch(() => {});
    throw new Error('Login fehlgeschlagen: ' + redact(e.message || ''));
  }
}

// ---------- Scraping ----------
async function waitForToccoLoad(page, label, onLog) {
  const LOADING_REGEX = /daten\s+werden\s+(ü|ue)bertragen|wird\s+geladen|loading|l(ä|ae)dt/i;
  const MAX_WAIT = 60000;
  const POLL_MS = 400;
  const start = Date.now();
  let sawLoading = false;
  let ticks = 0;

  while (Date.now() - start < MAX_WAIT) {
    const state = await page.evaluate((regexSrc) => {
      const re = new RegExp(regexSrc.pattern, regexSrc.flags);
      const txt = document.body ? (document.body.innerText || '') : '';
      return { loading: re.test(txt), bodyLen: txt.length };
    }, { pattern: LOADING_REGEX.source, flags: LOADING_REGEX.flags }).catch(() => ({ loading: false, bodyLen: 0 }));

    if (state.loading) {
      sawLoading = true;
      if (ticks % 3 === 0) {
        onLog('  ⏳ ' + (label ? label + ': ' : '') + '"Daten werden übertragen..." seit ' + ((Date.now()-start)/1000).toFixed(1) + 's', 'progress');
      }
    } else if (sawLoading) {
      onLog('  ✓ ' + (label ? label + ': ' : '') + 'Laden abgeschlossen nach ' + ((Date.now()-start)/1000).toFixed(1) + 's', 'info');
      break;
    } else if (Date.now() - start > 3000 && state.bodyLen > 100) {
      onLog('  ✓ ' + (label ? label + ': ' : '') + 'Kein Lade-Indikator', 'info');
      break;
    }
    ticks++;
    await page.waitForTimeout(POLL_MS);
  }

  if (Date.now() - start >= MAX_WAIT) {
    onLog('  ⚠️  Max-Wait erreicht', 'warn');
  }
  await page.waitForTimeout(600);
}

async function setPageSize(page, size, onLog) {
  onLog('🔢 Setze Seitengröße auf ' + size + '...', 'info');

  // Finde den Page-Size Combobox über Nachbarschaft zu "Anzeige Eintrag"-Text
  const inputInfo = await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll('*'));
    const anchor = all.find(el =>
      el.children.length === 0 &&
      /Anzeige\s+Eintrag/i.test(el.textContent || '')
    );
    if (!anchor) return { found: false, reason: 'Anzeige Eintrag Text nicht gefunden' };

    // Walk up bis ein Container gefunden wird, der einen x-form-text Input enthält
    let container = anchor.parentElement;
    for (let i = 0; i < 15 && container; i++) {
      const input = container.querySelector('input.x-form-text, input.x-form-field');
      if (input) {
        input.id = input.id || ('tocco-pagesize-' + Date.now());
        return { found: true, id: input.id, currentValue: input.value };
      }
      container = container.parentElement;
    }
    return { found: false, reason: 'Kein Input in Toolbar gefunden' };
  });

  if (!inputInfo.found) {
    onLog('  ⚠️  ' + inputInfo.reason, 'warn');
    return false;
  }
  onLog('  Input gefunden (aktueller Wert: ' + inputInfo.currentValue + ')', 'info');

  const sel = '#' + inputInfo.id;
  await page.click(sel, { clickCount: 3 }).catch(() => {});
  await page.fill(sel, '').catch(() => {});
  await page.type(sel, String(size), { delay: 50 });
  await page.keyboard.press('Enter');
  onLog('  ✓ ' + size + ' eingegeben + Enter', 'info');
  return true;
}

async function scrapePage(page, url, label, onLog, options = {}) {
  onLog('📖 Lade ' + label + ': ' + url, 'info');
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await waitForToccoLoad(page, label, onLog);

  if (options.afterLoad) {
    const changed = await options.afterLoad(page);
    if (changed) {
      await page.waitForTimeout(500); // kurze Wartezeit damit Loading-Indikator erscheint
      await waitForToccoLoad(page, label, onLog);
    }
  }

  return page.evaluate(() => {
    const tables = Array.from(document.querySelectorAll('table')).map(tbl => {
      const rows = Array.from(tbl.querySelectorAll('tr'));
      return rows.map(tr => Array.from(tr.querySelectorAll('th, td')).map(c => (c.innerText || '').trim().replace(/\s+/g, ' ')));
    }).filter(t => t.length > 0 && t.some(r => r.some(c => c)));

    const main = document.querySelector('main, #main, .main-content, .content, article, body');
    const text = main ? (main.innerText || '').trim() : '';

    return { tables, text, url: location.href, title: document.title };
  });
}

// ---------- Text-Parser (Tabellen-HTML ist wertlos bei Tocco, Text hat die Daten) ----------
function parseNoten(text) {
  const lines = text.split('\n').map(l => l.replace(/\t/g, '').trim()).filter(Boolean);
  const startIdx = lines.findIndex(l => /^Fach-Bezeichnung$/i.test(l));
  if (startIdx < 0) return [];

  // Stopp-Marker: alles nach Pagination oder Footer ignorieren
  const stopMarkers = /^(Seite|Anzeige Eintrag|DIREKT ZU|Copyright|WISS & SOCIAL|RECHTLICHES|zu unserem|Datenschutz|Allg\.)/i;

  const entries = [];
  let current = null;
  for (let i = startIdx + 1; i < lines.length; i++) {
    const l = lines[i];
    if (stopMarkers.test(l)) break;
    if (/^\d+$/.test(l)) {
      if (current && current.length >= 3) entries.push(current.slice(0, 4));
      current = [];
    } else if (current !== null && current.length < 4) {
      // Note ist das 4. Feld — nimm nur wenn es wie eine Note aussieht (X.X, leer, oder kurz)
      if (current.length === 3) {
        // 4. Position = Note; akzeptiere nur sinnvolle Werte
        if (/^\d+([.,]\d+)?$/.test(l) || l === '' || l.length <= 10) {
          current.push(l);
        } else {
          // Sieht nicht nach Note aus → Entry hat keine Note, fertig
          entries.push(current.slice(0, 4));
          current = null;
        }
      } else {
        current.push(l);
      }
    }
  }
  if (current && current.length >= 3) entries.push(current.slice(0, 4));

  return entries.map(e => ({
    fach: e[0] || '',
    kuerzel: e[1] || '',
    typ: e[2] || '',
    note: /^\d+([.,]\d+)?$/.test(e[3] || '') ? e[3] : ''
  }));
}

function parseStundenplan(text) {
  const lines = text.split('\n').map(l => l.replace(/\t/g, '').trim()).filter(Boolean);
  const dateRegex = /^(\d{2}\.\d{2}\.\d{2,4})\s+(\d{2}:\d{2})\s*-\s*(\d{2}:\d{2})/;
  // Klassenformat: UIFZ-2524-020, UIFZ-2524-020/021, etc.
  const klasseRegex = /^[A-Z]{2,}[-]\d{2,}[-]\d{2,}(\/\d+)?$/;
  // Explizite Footer-/Button-Texte, die ausserhalb der Datentabelle stehen
  const stopMarkers = /^(Seite|Anzeige Eintrag|DIREKT ZU|Copyright|WISS & SOCIAL|RECHTLICHES|zu unserem|Datenschutz|Allg\.|Alle Rechte|Ein Unternehmen|Kalaidos|Termine exportieren|iCal)/i;

  const entries = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(dateRegex);
    if (!m) continue;

    const fields = [];
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j];
      if (dateRegex.test(l) || /^\d+$/.test(l)) break;
      if (stopMarkers.test(l)) break;
      fields.push(l);
      // Strukturelle Grenze: sobald wir eine Klasse + genau 1 weiteres Feld
      // (= Veranstaltung) gesammelt haben → Eintrag komplett, Schluss.
      // Das fängt ALLE Footer-Leakage-Fälle ab, unabhängig von Texten.
      if (fields.length >= 2 && klasseRegex.test(fields[fields.length - 2])) {
        break;
      }
    }

    // Mapping:
    //   fields[0]           = Raum
    //   fields[last]        = Veranstaltung
    //   fields[last-1]      = Klasse (UIFZ-...)
    //   Dozent              = erstes Feld dazwischen mit Komma
    const raum = fields[0] || '';
    const veranstaltung = fields[fields.length - 1] || '';
    const klasse = fields[fields.length - 2] || '';
    const middle = fields.slice(1, Math.max(1, fields.length - 2));
    const dozent = middle.find(f => f.includes(',')) || '';

    // Sanity-Check: wenn klasse nicht dem Pattern entspricht, ist der Eintrag kaputt
    // → überspringen statt Müll in die DB schreiben.
    if (!klasseRegex.test(klasse)) continue;

    entries.push({
      datum: m[1],
      zeit: m[2] + ' – ' + m[3],
      raum,
      dozent,
      klasse,
      veranstaltung
    });
  }
  return entries;
}

// ---------- Public API ----------
async function runScrape(config, onLog) {
  const log = onLog || (() => {});
  const cfg = {
    baseUrl: 'https://wiss.tocco.ch',
    headless: true,
    slowMo: 0,
    ...config
  };

  if (!cfg.notenUrl) throw new Error('config.notenUrl fehlt');
  if (!cfg.stundenplanUrl) throw new Error('config.stundenplanUrl fehlt');
  if (!cfg.storageFile) throw new Error('config.storageFile fehlt');
  if (!cfg.cwd) throw new Error('config.cwd fehlt');

  const { browser, page } = await ensureLoggedIn(cfg, log);

  try {
    const notenRaw = await scrapePage(page, cfg.notenUrl, 'Noten', log, {
      afterLoad: (p) => setPageSize(p, 100, log)
    });
    const noten = parseNoten(notenRaw.text || '');

    const spRaw = await scrapePage(page, cfg.stundenplanUrl, 'Stundenplan', log, {
      afterLoad: (p) => setPageSize(p, 100, log)
    });
    const stundenplan = parseStundenplan(spRaw.text || '');

    return {
      noten,
      stundenplan,
      rawText: { noten: notenRaw.text, stundenplan: spRaw.text },
      fetchedAt: new Date().toISOString()
    };
  } finally {
    await browser.close().catch(() => {});
  }
}

module.exports = { runScrape, redact };
