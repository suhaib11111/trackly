# Trackly web app

Bag tracker PWA: live map, lost mode, history, safe zones, English / Kurdish Sorani / Arabic.
Plain HTML, CSS and JavaScript, so there's nothing to install or build.

## Files
- `index.html` – all screens
- `css/styles.css` – design (light + dark, right-to-left support)
- `js/config.js` – Supabase URL and publishable key, tracker timing
- `js/i18n.js` – all text in 3 languages
- `js/app.js` – the app logic
- `js/fake-backend.js` – TEST MODE: pretend Supabase + pretend tracker (switch in `js/config.js`)
- `manifest.json`, `sw.js`, `icons/` – makes it installable (Add to Home Screen)

## Run it on your computer
A service worker doesn't work from a double-clicked file, so use a small local server:
- VS Code: install the "Live Server" extension, right-click `index.html`, then "Open with Live Server"
- or in a terminal inside this folder: `npx serve .`

## Test mode (on right now)
`js/config.js` has `fakeBackend: true`. The app then uses `js/fake-backend.js`: a pretend login and a
pretend tracker moving around Erbil, all saved in this browser only. A red "TEST MODE" label shows at the top.

1. Create any account (e.g. `test@test.com` / `123456`). No email is sent.
2. Pair the test tracker: code `SB-0001`, secret `demo1234` (also `SB-0002`). It comes with 2 days of history and a "Home" safe zone.
3. The bag sends a new point every 30 s (real tracker: 1–1.5 min). Hold the red button 2 s → lost mode → every 5 s.
4. Try the other states from the browser console (F12):
   - `TracklyFake.battery(15)` – low battery banner
   - `TracklyFake.noSignal()` / `TracklyFake.signalBack()` – grey pin, "last seen"
   - `TracklyFake.reset()` – delete all test data

Good to know: test data is saved per web address. `localhost:5180` on the computer and `172.20.10.3:8080`
on the phone are two different "browsers" to the app, so each has its own accounts.

## What's in the app
- Map: 4 styles (Clean, Detailed with shops/buildings/house numbers, Satellite, Satellite + labels),
  scale bar, zoom up to 20, "show my bag", live "my location" with "300 m north-east of you" (needs https),
  directions to the bag, safe zones drawn on the map, the bag icon glides to each new point
- Tap the bag: full address, coordinates (tap to copy), accuracy, last update, speed + direction, Google Maps
- Moving: speed (km/h) and an arrow showing which way it's going (GPS glitches over 150 km/h are ignored)
- Today's path button: the day's route on the main map, growing live
- History: replay the day with a slider or play button (time + battery at each moment)
- Test mode with `usePhoneGps: true`: the pretend tracker follows this phone's real GPS (https only)
- Safe zones: pick a type (Home, Work, School, Gym, Family, Other), search a place, tap the map or use
  "My location" / "Bag's location", set the size, tap a zone in the list to edit, move or delete it
- Remembered on this phone: your email (the phone's password manager can save the password), and the
  tracker code + secret after pairing, so pairing again is one tap

## Real mode
1. Review and run `supabase/proposed/001_claim_mode_safe_zones.sql` in Supabase (SQL Editor).
2. Set `fakeBackend: false` in `js/config.js`.

## Test it (real mode)
1. Create an account. Supabase sends a confirmation email by default. For quick testing you can turn
   that off in Supabase: Authentication, then Sign In / Providers, then Email, then "Confirm email".
2. Pair the test tracker: code `SB-0001`, plus the secret from your ESP32 code.
3. Run the Wokwi tracker and move the motion sensor: the pin appears and updates live.
4. Hold the red button for 2 seconds, then confirm: the ESP32 switches to 5-second updates.

## Put it online
Upload this folder to Vercel (or Netlify). It's a static site, no settings needed.

## Next steps (not in this version)
- Safe zone alerts and low battery alerts as push notifications (needs a Supabase Edge Function)
- "Find nearby" sound (needs a small change in the ESP32 code)
- QR code scanning when pairing
