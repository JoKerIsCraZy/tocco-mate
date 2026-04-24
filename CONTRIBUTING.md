# Beitragen zu tocco-cli

Danke für dein Interesse! Dieses Dokument erklärt, wie du das Projekt lokal aufsetzt und Beiträge einreichst.

## Lokale Entwicklung

```bash
git clone <repo>
cd tocco-cli
cp .env.example .env          # Werte eintragen (MS_EMAIL, MS_PASSWORD)
npm install
npm run setup                 # Playwright Chromium installieren
npm run serve                 # HTTP-Server auf :3000 starten
# oder einmal-Scrape:
npm start
```

> Tipp: `HEADLESS=false` in `.env` setzen, damit der Browser sichtbar ist — hilfreich beim Debuggen von Login-Problemen.

## Projektstruktur

```
tocco-cli/
├── src/
│   ├── server.js       # Express-API, Scheduler, SSE
│   ├── scraper.js      # Playwright-Login + Noten/Stundenplan-Scraping
│   ├── db.js           # SQLite-Zugriff (node:sqlite, parametrisierte Queries)
│   ├── bot.js          # Telegram-Bot (Long-Polling)
│   └── settings.js     # Konfigurations-Merge (Defaults < .env < data/settings.json)
├── web/                # Vanilla-JS-Frontend (kein Build-Schritt)
├── data/               # Runtime-Daten — gitignored (DB, Session, Token)
├── Dockerfile
├── docker-compose.yml
├── .env.example
└── package.json
```

`data/` wird nie committet — sie enthält Secrets und Session-Cookies.

## Issues & Pull Requests

1. **Issue erstellen** — beschreibe das Problem oder die Feature-Idee kurz. Bitte vorher prüfen, ob es bereits ein offenes Issue gibt.
2. **Fork** des Repos erstellen, einen Feature-Branch anlegen (`git checkout -b feat/mein-feature`).
3. Änderungen implementieren.
4. **Pull Request** gegen `main` öffnen — kurze Beschreibung, was geändert wurde und warum.

Für Bugfixes reicht meist ein kleines reproduzierbares Beispiel im Issue.

## Code-Style

- **Sprache:** CommonJS (`require`/`module.exports`), kein Build-Schritt.
- **Dateigrösse:** max. ~400 Zeilen pro Datei; lieber mehrere kleine Module.
- **Fehlerbehandlung:** Fehler immer explizit behandeln — nie still verschlucken.
- **Keine externen Linter-Configs** im Repo; orientiere dich am bestehenden Stil der Dateien in `src/`.
- **Keine Secrets** in Commits — `.env`, `data/` und `*.png` sind gitignored.
- **Immutability:** Objekte nicht in-place ändern, sondern neue Objekte zurückgeben (wie in `settings.js` praktiziert).

Kurz: lies zwei, drei bestehende Dateien in `src/` durch — der Stil ist konsistent und selbsterklärend.

## Lizenz

Mit einem Pull Request stimmst du zu, dass dein Beitrag unter der [MIT-Lizenz](LICENSE) dieses Projekts veröffentlicht wird.
