---
name: verify
description: Build, launch and drive FireYak (Ionic/Vue web app) headlessly to verify changes at the UI surface.
---

# Verifying FireYak changes

Surface: browser GUI (Ionic + Vue + MapLibre). Drive with headless Chrome over raw CDP — no Playwright/puppeteer in this repo, but `/usr/bin/google-chrome` exists and Node ≥22 has a global `WebSocket`.

## Launch

```bash
npm run dev &          # Vite on http://localhost:5173 (hash router: /#/supplypipe, /#/settings …)
google-chrome --headless=new --remote-debugging-port=9222 \
  --user-data-dir=<scratch>/chrome-profile --no-first-run --window-size=1280,900 about:blank &
```

Reusable CDP helper + drivers from a previous session: `cdp.mjs`, `drive.mjs`, `drive2.mjs` in the session scratchpad (recreate from this recipe if gone — ~100 lines: JSON-RPC over the page's `webSocketDebuggerUrl`, `Runtime.evaluate`, `Page.captureScreenshot`, `Input.dispatchMouseEvent` drags).

## Gotchas that cost time

- **Map position**: seed before app code runs, don't fight geolocation:
  `Page.addScriptToEvaluateOnNewDocument` → `localStorage.setItem('mapView', JSON.stringify({lat:48.2274,lng:15.3369,zoom:16}))` (Melk). At z16/48°N one screen-px ≈ 0.35 m — panning 6×400 px ≈ 400 m line.
- **Clicking Ionic UI**: `Runtime.evaluate` + `element.click()` works. Find items by their icon alt text (`img[alt="Fire point"]`, `"Suction point"`) or button text (`/berechnen|calculate/i`).
- **ion-input**: set `.value` then `dispatchEvent(new CustomEvent('ionChange', {detail:{value}}))`.
- **Settings persistence** (Capacitor Preferences on web) lands in `localStorage['CapacitorStorage.<key>']` — assert there.
- **Map pan** = mouse drag on the canvas (`Input.dispatchMouseEvent` pressed/moved×12/released).
- Enable `Network.enable` and collect `requestWillBeSent` URLs — the cleanest way to prove which elevation/tile backend was used (`tiles.mapterhorn.com` vs `api.open-meteo.com`).
- Labels/lines render into the WebGL canvas: verify via screenshot, not DOM.

## Flows worth driving

- Supply pipe: `/#/supplypipe` → Set fire object → pan → Set suction point → Berechnen → results panel `.calculation-results` innerText + screenshot (routed line, per-segment hose labels, pump markers).
- Settings: `/#/settings` → pump-calculation section (hose length/diameter/name), clamp-to-roads toggle; re-run supply pipe to see them applied.
