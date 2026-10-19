# Trackly (web app)

Bag tracker PWA: plain HTML/CSS/JS + Vite, Supabase, Leaflet/OpenStreetMap.

- `src/config.js` – Supabase URL + publishable key
- `src/lib/` – shared helpers (Supabase client, map, i18n, time)
- `src/screens/` – one file per screen (login, pair, map, history, zones, account)
- `src/i18n/` – en / ku / ar texts
- `public/` – manifest, service worker, icons
- `supabase/proposed/` – SQL waiting for review (nothing here runs automatically)
