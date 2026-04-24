# tocco-mate

Inoffizieller Scraper für das WISS Tocco-Schulportal. Holt automatisch Noten & Stundenplan per Microsoft SSO, speichert sie lokal und zeigt sie in einem modernen Web-UI.

## Features

- Noten-Dashboard mit Durchschnittsberechnung (gesamt + pro Semester)
- Stundenplan-Übersicht mit Datum-/Limit-Filterung
- Automatischer Scheduler (Intervall-Modus oder Wochenplan)
- Telegram-Bot mit Push-Notifications bei Notenänderungen und Scrape-Fehlern
- SQLite-Historie — alle Notenänderungen werden nachverfolgt
- Live-Log-Stream via Server-Sent Events (SSE)

---

## Quick Start — Docker (empfohlen)

```bash
git clone <repo>
cd tocco-mate
cp .env.example .env
# .env öffnen und MS_EMAIL + MS_PASSWORD eintragen
docker compose up -d
docker compose logs -f tocco-mate   # API_TOKEN aus dem Log kopieren
```

Dann im Browser `http://localhost:3000` öffnen und den kopierten Token eingeben.

**API_TOKEN:** Wird beim ersten Start automatisch generiert und in `data/.api-token` gespeichert. Er erscheint einmalig im Container-Log. Wer einen eigenen Token setzen möchte, trägt `API_TOKEN=...` in `.env` ein — dann wird die automatische Generierung übersprungen.

---

## Quick Start — ohne Docker (lokal)

```bash
npm install
npm run setup                 # Playwright Chromium herunterladen
cp .env.example .env          # Werte eintragen
npm run serve                 # HTTP-Server auf :3000
# oder einmaliger Scrape via CLI:
npm start
```

---

## Konfiguration

Alle Einstellungen werden über `.env` gesetzt. Variablen ohne Default sind optional, sofern nicht als Pflicht markiert.

| Variable | Typ | Default | Beschreibung |
|---|---|---|---|
| `API_TOKEN` | string | _(auto)_ | Token für alle `/api/*`-Routen und das Web-UI. Wird automatisch generiert wenn leer. |
| `ALLOW_UI_CREDENTIALS` | bool | `false` | Erlaubt das Ändern von `msPassword` und `telegramToken` über das Web-UI. Schreibt Secrets in `data/settings.json`. |
| `MS_EMAIL` | string | — | **Pflicht.** Microsoft-Konto-E-Mail (`name@wiss-edu.ch`). |
| `MS_PASSWORD` | string | — | **Pflicht.** Passwort für das Microsoft-Konto. |
| `TOCCO_BASE` | string | `https://wiss.tocco.ch` | Basis-URL des Tocco-Portals. Nur via `.env` änderbar (SSRF-Schutz). |
| `NOTEN_URL` | string | _(Tocco-Notenseite)_ | Vollständige URL der Notenseite. Nur via `.env`. |
| `STUNDENPLAN_URL` | string | _(Tocco-Stundenplanseite)_ | Vollständige URL der Stundenplanseite. Nur via `.env`. |
| `USER_PK` | string | _(leer)_ | Tocco-Benutzer-ID (optional). Nur via `.env`. |
| `PORT` | number | `3000` | HTTP-Port des Express-Servers. |
| `HEADLESS` | bool | `true` | Playwright headless betreiben. `false` = Browser sichtbar (Debug). |
| `SLOW_MO` | number | `0` | Millisekunden zwischen Playwright-Aktionen (Debug). |
| `DEBUG_SCRAPER` | bool | `false` | Aktiviert ausführliche DOM-Dumps bei Scraper-Fehlern. |
| `TELEGRAM_ENABLED` | bool | `false` | Telegram-Bot aktivieren. |
| `TELEGRAM_TOKEN` | string | — | Bot-Token von @BotFather. |
| `TELEGRAM_ALLOWED_USER_ID` | number | — | Numerische Telegram-User-ID — nur diese darf den Bot verwenden. |

Einstellungen, die über das Web-UI änderbar sind (Scheduler-Modus, Intervall, Zeitfenster usw.), werden in `data/settings.json` gespeichert und überschreiben `.env`-Werte.

---

## Sicherheit

**API_TOKEN**
Alle `/api/*`-Routen und das Web-UI sind hinter dem API_TOKEN gesichert. Bei Verlust: entweder `API_TOKEN=neuer-wert` in `.env` eintragen oder `data/.api-token` löschen und den Container/Server neu starten — ein neuer Token wird dann generiert und im Log ausgegeben.

**Netzwerk**
Das Standard-Port-Mapping im Compose-File ist `3000:3000` (LAN-offen). Wer den Dienst nur lokal erreichbar machen möchte, ändert das Mapping in `docker-compose.yml` auf `127.0.0.1:3000:3000`.

Nicht ohne Reverse-Proxy + TLS ins öffentliche Internet exponieren. Empfohlen: Caddy, Traefik oder nginx mit TLS davorschalten.

**ALLOW_UI_CREDENTIALS**
Wenn `ALLOW_UI_CREDENTIALS=true` gesetzt ist, werden `msPassword` und `telegramToken` in `data/settings.json` im Klartext gespeichert (Dateimodus 0600). Nur auf eigenen, nicht gemeinsam genutzten Maschinen aktivieren.

**data/**
Das Verzeichnis enthält `storage.json` mit aktiven Browser-Cookies (Live-Login). Nie in Git committen (ist bereits in `.gitignore`), nie teilen.

---

## Architektur

```
tocco-mate/
├── src/
│   ├── server.js       # Express-API, Scheduler, SSE-Stream
│   ├── scraper.js      # Playwright-Login, Noten- und Stundenplan-Scraping
│   ├── db.js           # SQLite via node:sqlite (experimental), parametrisierte Queries
│   ├── bot.js          # Telegram-Bot (Long-Polling)
│   └── settings.js     # Konfigurations-Merge: Defaults < .env < data/settings.json
├── web/                # Vanilla-JS-Frontend (kein Build-Schritt)
├── data/               # Runtime-Daten — gitignored
├── Dockerfile
├── docker-compose.yml
└── .env.example
```

---

## API-Endpoints

Alle Endpoints ausser `/healthz` erwarten den API_TOKEN im `Authorization`-Header (`Bearer <token>`) oder — bei SSE — als Query-Parameter `?token=<token>`.

| Methode | Pfad | Beschreibung | Auth |
|---|---|---|---|
| `GET` | `/healthz` | Health-Check | Nein |
| `GET` | `/api/status` | Scheduler-Status, Server-Zeit | Ja |
| `GET` | `/api/settings` | Aktuelle Einstellungen (Passwort maskiert) | Ja |
| `PATCH` | `/api/settings` | Einstellungen aktualisieren | Ja |
| `GET` | `/api/noten` | Noten + Durchschnitt (`?semester=S1&sortBy=note&hasNote=true`) | Ja |
| `GET` | `/api/stundenplan` | Kommende Events (`?limit=100&from=YYYY-MM-DD`) | Ja |
| `GET` | `/api/history/:kuerzelId` | Noten-Verlauf für ein Fach | Ja |
| `GET` | `/api/stats` | Gesamt-Statistiken | Ja |
| `POST` | `/api/scrape` | Scrape sofort auslösen | Ja |
| `GET` | `/api/logs` | Ringbuffer der letzten Log-Zeilen (`?limit=200`) | Ja |
| `GET` | `/api/events` | SSE: `status`, `log`, `scrape_done` | Ja (Query) |

---

## Telegram-Bot (optional)

1. Bot erstellen: In Telegram an **@BotFather** schreiben → `/newbot` → Token notieren.
2. Eigene User-ID holen: An **@userinfobot** schreiben → numerische ID notieren.
3. In `.env` eintragen:
   ```
   TELEGRAM_ENABLED=true
   TELEGRAM_TOKEN=1234567890:AAAA-BBBBCCCC_DDDDEEEEE
   TELEGRAM_ALLOWED_USER_ID=123456789
   ```
4. Server neu starten — Bot startet automatisch.

Verfügbare Befehle: `/noten`, `/durchschnitt`, `/heute`, `/morgen`, `/woche`, `/scrape`, `/status`, `/help`.

Push-Notifications werden automatisch gesendet bei neuen oder geänderten Noten sowie bei Scrape-Fehlern.

---

## Troubleshooting

| Problem | Ursache / Lösung |
|---|---|
| Login schlägt fehl | Passwort abgelaufen, MFA aktiv oder E-Mail falsch. `HEADLESS=false` setzen, um den Browser sichtbar zu machen. |
| `login-error.png` erscheint | Screenshot vom Fehlermoment — Inhalt prüfen für weiteren Kontext. |
| Session ungültig | `data/storage.json` löschen → Session wird neu aufgebaut. |
| Daten werden nicht aktualisiert | Scheduler ausgeschaltet (`autoRun=false`) oder ausserhalb des Zeitfensters. `/api/scrape` manuell aufrufen. |
| Port bereits belegt | `PORT=3001` in `.env` eintragen. |
| Playwright-Fehler in Docker | Container-Healthcheck-Log prüfen; Chromium-Abhängigkeiten fehlen selten, da das `Dockerfile` darauf ausgelegt ist. |

---

## Lizenz

MIT — siehe [LICENSE](LICENSE).

## Mitwirken

Beiträge sind willkommen — siehe [CONTRIBUTING.md](CONTRIBUTING.md).

---

## English Summary

**tocco-mate** is an unofficial scraper for the WISS Tocco school portal (Switzerland). It logs in automatically via Microsoft SSO, fetches grades and timetable data, stores everything in a local SQLite database, and serves a web dashboard on port 3000.

**Docker quick-start:**
```bash
cp .env.example .env   # add MS_EMAIL + MS_PASSWORD
docker compose up -d
# open http://localhost:3000 — use the API_TOKEN printed in the logs
```

All API endpoints are protected by an `API_TOKEN` (auto-generated on first start). Do not expose the service to the public internet without a reverse proxy and TLS. See the Sicherheit section above for details.

License: MIT.
