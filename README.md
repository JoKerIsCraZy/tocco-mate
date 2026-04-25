<div align="center">

# tocco-mate

**Ein inoffizieller Scraper für das WISS Tocco-Schulportal.**

Holt automatisch Noten und Stundenplan via Microsoft SSO, speichert alles lokal
und stellt deine Daten in einem modernen Web-Dashboard bereit.

[![Docker](https://img.shields.io/badge/docker-ghcr.io-2496ED?logo=docker&logoColor=white)](https://github.com/JoKerIsCraZy/tocco-mate/pkgs/container/tocco-mate)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-339933?logo=node.js&logoColor=white)](package.json)
[![Playwright](https://img.shields.io/badge/playwright-1.59-45ba4b?logo=playwright&logoColor=white)](https://playwright.dev)

</div>

---

## Überblick

`tocco-mate` automatisiert den manuellen Login ins WISS Tocco-Portal und liefert
dir deine Schuldaten strukturiert zurück. Statt dich mehrmals pro Woche selbst
einzuloggen, läuft der Scraper im Hintergrund und benachrichtigt dich bei Bedarf
direkt per Telegram.

### Kernfunktionen

| Bereich | Beschreibung |
|---|---|
| **Noten-Dashboard** | Durchschnittsberechnung (gesamt und pro Semester), sortier- und filterbar |
| **Stundenplan** | Übersicht kommender Termine mit Datums- und Limit-Filter |
| **Scheduler** | Intervall-Modus oder konfigurierbarer Wochenplan, UI-steuerbar |
| **Telegram-Bot** | Push-Notifications bei Notenänderungen und Scrape-Fehlern |
| **SQLite-Historie** | Lückenlose Nachverfolgung aller Notenänderungen |
| **Live-Logs** | Echtzeit-Log-Stream im Dashboard via Server-Sent Events |

---

## Quick Start mit Docker

Der einfachste Weg. Wähle den Einzeiler passend zu deinem System und ersetze
die beiden markierten Platzhalter mit deinen Zugangsdaten.

> **Pflichtfelder:** `MS_EMAIL`, `MS_PASSWORD`
> **Optional:** `API_TOKEN` — wenn nicht gesetzt, wird beim ersten Start
> automatisch ein sicherer Token generiert.

> **Hinweis NAS / Unraid:** wenn beim Start ein `EACCES: permission denied`
> auf `/app/data/*` auftaucht, setze zusätzlich `-e PUID=…` und `-e PGID=…`
> passend zu dem Host-User, der `./data` besitzt. Defaults: `1000`/`1000`.
> Werte → siehe [Docker-Berechtigungen (PUID / PGID)](#docker-berechtigungen-puid--pgid).

### Linux / macOS / Git Bash / WSL

```bash
docker run -d --name tocco-mate --restart unless-stopped -p 3000:3000 \
  -e MS_EMAIL="dein.name@wiss-edu.ch" \
  -e MS_PASSWORD="DEIN_PASSWORT" \
  -e ALLOW_UI_CREDENTIALS=false \
  -e PUID=$(id -u) -e PGID=$(id -g) \
  -v "$(pwd)/data:/app/data" \
  ghcr.io/jokeriscrazy/tocco-mate:latest
```

### Windows PowerShell

```powershell
docker run -d --name tocco-mate --restart unless-stopped -p 3000:3000 `
  -e MS_EMAIL="dein.name@wiss-edu.ch" `
  -e MS_PASSWORD="DEIN_PASSWORT" `
  -e ALLOW_UI_CREDENTIALS=false `
  -v "${PWD}/data:/app/data" `
  ghcr.io/jokeriscrazy/tocco-mate:latest
```

### Windows CMD

```cmd
docker run -d --name tocco-mate --restart unless-stopped -p 3000:3000 ^
  -e MS_EMAIL="dein.name@wiss-edu.ch" ^
  -e MS_PASSWORD="DEIN_PASSWORT" ^
  -e ALLOW_UI_CREDENTIALS=false ^
  -v "%cd%/data:/app/data" ^
  ghcr.io/jokeriscrazy/tocco-mate:latest
```

> Auf Windows greifen `PUID`/`PGID` nicht — Docker Desktop bzw. WSL2
> übersetzt das Bind-Mount automatisch.

### Nach dem Start

1. **API-Token aus den Logs auslesen**

   ```bash
   docker logs tocco-mate | grep AUTO-GENERATED
   ```

2. **Dashboard öffnen**: [http://localhost:3000](http://localhost:3000) und mit dem Token einloggen.

3. **Optional weitere Features aktivieren** (beim `docker run` ergänzen):

   ```bash
   # Telegram-Bot
   -e TELEGRAM_ENABLED=true \
   -e TELEGRAM_TOKEN="1234567890:AAAA-BBBBCCCC_DDDDEEEEE" \
   -e TELEGRAM_ALLOWED_USER_ID="123456789"

   # Fixen API-Token setzen (statt Auto-Generierung)
   -e API_TOKEN="mindestens_32_zufaellige_zeichen_hier"
   ```

### Alternative: Docker Compose

```bash
git clone https://github.com/JoKerIsCraZy/tocco-mate.git
cd tocco-mate
cp .env.example .env              # MS_EMAIL und MS_PASSWORD eintragen
docker compose up -d
docker compose logs -f tocco-mate
```

---

## Lokale Installation (ohne Docker)

Für Entwicklung oder wenn kein Docker verfügbar ist.

```bash
git clone https://github.com/JoKerIsCraZy/tocco-mate.git
cd tocco-mate
npm install
npm run setup                     # Playwright Chromium
cp .env.example .env              # Werte eintragen
npm run serve                     # Dashboard auf Port 3000
```

**Einmaliger Scrape ohne Server:**

```bash
npm start
```

**Voraussetzungen:** Node.js >= 20, ausreichend Speicher für Chromium
(ca. 300 MB), ein WISS-Schulaccount.

---

## Konfiguration

Alle Einstellungen werden über Umgebungsvariablen gesetzt (`.env`-Datei oder
Docker `-e`). Pflichtwerte sind explizit markiert.

### Authentifizierung

| Variable | Typ | Default | Beschreibung |
|---|---|---|---|
| `MS_EMAIL` | string | — | **Pflicht.** Microsoft-E-Mail (`name@wiss-edu.ch`) |
| `MS_PASSWORD` | string | — | **Pflicht.** Microsoft-Passwort |
| `API_TOKEN` | string | *auto* | Schutz aller `/api/*`-Routen. Wird bei leerem Wert automatisch generiert |
| `ALLOW_UI_CREDENTIALS` | bool | `false` | Credentials über das Web-UI änderbar (speichert in `settings.json`) |

### Tocco-URLs (SSRF-Schutz: nur via ENV setzbar)

| Variable | Default |
|---|---|
| `TOCCO_BASE` | `https://wiss.tocco.ch` |
| `NOTEN_URL` | *Notenseite* |
| `STUNDENPLAN_URL` | *Stundenplanseite* |
| `USER_PK` | *(leer)* |

### Server und Browser

| Variable | Typ | Default | Beschreibung |
|---|---|---|---|
| `PORT` | number | `3000` | HTTP-Port des internen Express-Servers |
| `HEADLESS` | bool | `true` | `false` = sichtbarer Browser (Debug) |
| `SLOW_MO` | number | `0` | Millisekunden zwischen Playwright-Aktionen (Debug) |
| `DEBUG_SCRAPER` | bool | `false` | Aktiviert DOM-Dumps bei Scraper-Fehlern |

### Telegram (optional)

| Variable | Typ | Default | Beschreibung |
|---|---|---|---|
| `TELEGRAM_ENABLED` | bool | `false` | Telegram-Bot einschalten |
| `TELEGRAM_TOKEN` | string | — | Bot-Token von [@BotFather](https://t.me/BotFather) |
| `TELEGRAM_ALLOWED_USER_ID` | number | — | Numerische User-ID (Bot-Zugang) |

### Docker-Berechtigungen (PUID / PGID)

Beim ersten Start chownt der Container das gemountete `./data`-Verzeichnis
automatisch auf den Host-User. Setze `PUID` und `PGID` so, dass sie zu der
User-/Group-ID passen, der dein `./data`-Verzeichnis auf dem Host gehört —
das verhindert das typische `EACCES: permission denied`-Problem bei
Bind-Mounts.

| Variable | Typ | Default | Beschreibung |
|---|---|---|---|
| `PUID` | number | `1000` | User-ID, unter der `node` im Container läuft |
| `PGID` | number | `1000` | Group-ID, unter der `node` im Container läuft |

| Plattform | Typische Werte |
|---|---|
| Linux / macOS / WSL | `PUID=$(id -u)` `PGID=$(id -g)` (meist `1000`/`1000`) |
| Unraid | `PUID=99` `PGID=100` |
| Synology | `PUID=1026` `PGID=100` |
| QNAP | `PUID=1000` `PGID=100` |

### Zeitzone (TZ)

Steuert die Anzeige von Zeitstempeln in Logs und Telegram-Status (Format
`dd.MM.yyyy HH:mm:ss`). Default ist `Europe/Zurich` — kannst du auf jede
[IANA-Zeitzone](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones)
umsetzen, falls du in einer anderen Region bist.

| Variable | Default | Beispiele |
|---|---|---|
| `TZ` | `Europe/Zurich` | `Europe/Berlin`, `Europe/Vienna`, `America/New_York`, `Etc/UTC` |

> Scheduler-Einstellungen aus dem Web-UI überschreiben die `.env`-Werte
> und werden in `data/settings.json` persistiert.

---

## Sicherheit

**API-Token**
Alle API-Routen (außer `/healthz`) erfordern den `API_TOKEN` entweder als
`Authorization: Bearer <token>`-Header oder als `?token=<token>`-Query-Parameter.
Bei Verlust: `API_TOKEN` in der Config neu setzen oder `data/.api-token` löschen
und den Dienst neu starten.

**Netzwerk**
Das Standard-Port-Mapping `3000:3000` bindet auf alle Interfaces. Setze es auf
`127.0.0.1:3000:3000`, wenn der Dienst nur lokal erreichbar sein soll. Für
öffentliche Exposition ist ein Reverse-Proxy mit TLS (Caddy, Traefik, nginx)
zwingend erforderlich.

**Persistente Daten**
Das `data/`-Verzeichnis enthält `storage.json` mit aktiven Session-Cookies und
optional `settings.json` mit Credentials bei aktivem `ALLOW_UI_CREDENTIALS=true`.
Diese Dateien niemals veröffentlichen.

**Was `ALLOW_UI_CREDENTIALS` macht**
Ist der Flag auf `false` (Default), dürfen `MS_PASSWORD` und `TELEGRAM_TOKEN`
ausschliesslich über Umgebungsvariablen gesetzt werden. Das Web-UI zeigt diese
Felder als schreibgeschützt an. Bei `true` kannst du sie direkt im Browser
ändern; die Werte landen dann allerdings im Klartext in `data/settings.json`
auf der Platte. Empfehlung: in Produktion auf `false` lassen.

---

## API

Alle Endpoints erwarten den API-Token (außer `/healthz`).

| Methode | Pfad | Beschreibung |
|---|---|---|
| `GET` | `/healthz` | Health-Check (ohne Auth) |
| `GET` | `/api/status` | Scheduler-Status und Server-Zeit |
| `GET` | `/api/settings` | Konfiguration abrufen (Passwort maskiert) |
| `PATCH` | `/api/settings` | Einstellungen aktualisieren |
| `GET` | `/api/noten` | Noten abrufen (`?semester=S1&sortBy=note`) |
| `GET` | `/api/stundenplan` | Kommende Events (`?limit=100&from=YYYY-MM-DD`) |
| `GET` | `/api/history/:kuerzelId` | Historie eines Fachs |
| `GET` | `/api/stats` | Gesamt-Statistiken |
| `POST` | `/api/scrape` | Manuellen Scrape auslösen |
| `GET` | `/api/logs` | Letzte Log-Zeilen (`?limit=200`) |
| `GET` | `/api/events` | SSE-Stream für Status- und Log-Updates |

**Beispiel:**

```bash
curl -H "Authorization: Bearer $API_TOKEN" http://localhost:3000/api/noten
```

---

## Telegram-Bot

1. Bot bei [@BotFather](https://t.me/BotFather) erstellen und Token notieren.
2. Eigene User-ID bei [@userinfobot](https://t.me/userinfobot) auslesen.
3. Werte setzen und Dienst neu starten:

   ```bash
   TELEGRAM_ENABLED=true
   TELEGRAM_TOKEN=...
   TELEGRAM_ALLOWED_USER_ID=...
   ```

### Verfügbare Befehle

| Befehl | Funktion |
|---|---|
| `/noten` | Aktuelle Notenübersicht |
| `/durchschnitt` | Durchschnitt gesamt und pro Semester |
| `/heute` | Stundenplan heute |
| `/morgen` | Stundenplan morgen |
| `/woche` | Kommende 7 Tage |
| `/scrape` | Manuellen Scrape auslösen |
| `/status` | Scheduler- und Dienststatus |
| `/help` | Befehlsübersicht |

---

## Architektur

```
tocco-mate/
├── src/
│   ├── server.js       Express-API, Scheduler, SSE-Stream
│   ├── scraper.js      Playwright-Login und Scraping-Logik
│   ├── db.js           SQLite-Anbindung für Noten-Historie
│   ├── bot.js          Telegram-Bot (Long-Polling)
│   └── settings.js     Konfigurations-Management
├── web/                Vanilla-JS-Frontend (kein Build-Schritt)
├── data/               Runtime-Daten (Docker-Volume)
├── Dockerfile
└── docker-compose.yml
```

**Stack:** Node.js 20, Express 5, Playwright 1.59 (Chromium), SQLite (nativ),
Vanilla-JS-Frontend ohne Build-Pipeline.

---

## Troubleshooting

| Symptom | Lösung |
|---|---|
| Login schlägt fehl | Passwort abgelaufen, MFA aktiv oder falsche E-Mail. Setze `HEADLESS=false` für visuelles Debugging. |
| `login-error.png` wird angelegt | Bilddatei im `data/`-Verzeichnis prüfen — sie zeigt die Seite zum Zeitpunkt des Fehlers. |
| Session ungültig | `data/storage.json` löschen, damit beim nächsten Scrape ein frischer Login erzwungen wird. |
| Keine Updates | Scheduler-Status (`autoRun`) im Dashboard prüfen oder manuell via `POST /api/scrape` auslösen. |
| Token vergessen | `data/.api-token` löschen und Dienst neu starten — ein neuer Token wird generiert und geloggt. |

---

## Mitwirken

Beiträge sind willkommen. Siehe [CONTRIBUTING.md](CONTRIBUTING.md) für
Richtlinien zu Issues, Pull Requests und Entwicklungssetup.

## Lizenz

Veröffentlicht unter der [MIT-Lizenz](LICENSE).

## Disclaimer

`tocco-mate` ist ein inoffizielles Hobby-Projekt und steht in keinerlei
Verbindung zur WISS oder zur Tocco AG. Die Nutzung erfolgt auf eigene
Verantwortung. Bitte respektiere die Terms of Service deiner Schule.

---

<div align="center">

**English?**
`tocco-mate` is an unofficial scraper for the WISS Tocco portal. It fetches
grades and timetables via Microsoft SSO, stores them locally in SQLite, and
serves a web dashboard. Quick start:

```bash
docker run -d --name tocco-mate -p 3000:3000 \
  -e MS_EMAIL="..." -e MS_PASSWORD="..." \
  ghcr.io/jokeriscrazy/tocco-mate:latest
```

The auto-generated `API_TOKEN` is printed on first start.
Do not expose to the public internet without a reverse proxy and TLS.

</div>
