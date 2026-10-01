# E-Rechnung (PWA)

Offline-fähige PWA: visuelle PDF-Rechnung lesen und als **ZUGFeRD / Factur-X**
(PDF mit eingebettetem CII-XML) speichern.

**Version:** 2.2

## Ablauf

1. App öffnen (HTTPS oder `localhost`)
2. ZUGFeRD-Profil wählen (EN 16931, XRechnung, BASIC, MINIMUM)
3. PDF Rechnung wählen oder auf den Button ziehen
4. Extrahierte Felder prüfen / korrigieren
5. **ZUGFeRD erzeugen** – Teilen oder Download (`*_zugferd.pdf`)

## Lokal starten

```bash
cd e-rechnung
python3 -m http.server
```

Dann http://localhost:8000

## Einstellungen: Eigene Firmendaten

Die Felder unter „Eigene Firmendaten“ sind online leer. Werte werden nur **lokal** im Browser (`localStorage`) gespeichert. Über **Importieren** / **Exportieren** lassen sich die Daten als TXT-Datei sichern und wieder einlesen (kein Upload auf einen Server).

## Wichtige Dateien

| Pfad | Rolle |
|------|--------|
| `js/app.js` | UI, DnD, Orchestrierung |
| `js/parse.js` | Heuristik PDF-Text → Felder |
| `js/zugferd.js` | CII `CrossIndustryInvoice` XML |
| `js/embed.js` | pdf-lib Embed `factur-x.xml` + XMP |
| `js/settings.js` | Speichern-Art + lokale Firmendaten (Import/Export) |

## Windows Chrome

Nach dem Deploy unter HTTPS: Adressleiste → Install-Symbol → App installieren.
Manifest: `display: "standalone"`, Icons 192/512 (`any` abgerundet, `maskable` vollflächig).

## Deploy

Netlify Drop: Ordnerinhalt von `e-rechnung/` hochladen (siehe `DEPLOY.txt`). Kein Build-Schritt.

## Hinweis

Echte Rechnungs-PDFs und persönliche Firmendaten gehören nicht ins Repository und nicht in Deploy-ZIPs.
