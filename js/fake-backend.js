/* Trackly TEST MODE: a pretend Supabase that lives in this browser.

   Why: so every screen (login, pairing, live map, lost mode, history, safe zones) can be tried
   before the real database functions exist and without a real tracker.

   How: app.js only uses a few Supabase calls (auth, from(...).select/insert/update/delete,
   rpc(...), channel(...)). This file answers those same calls with the same shapes
   ({ data, error }), so app.js doesn't know the difference. Switch it off in js/config.js
   (fakeBackend: false) to use the real Supabase.

   Everything is saved in localStorage ("trackly.fake.db"). Nothing is sent anywhere.

   Test trackers you can pair:  SB-0001 / demo1234   and   SB-0002 / demo1234

   Helpers in the browser console (F12):
     TracklyFake.battery(15)   set battery to 15 % (shows the low battery banner)
     TracklyFake.noSignal()    pretend the bag stopped sending 80 min ago (grey pin)
     TracklyFake.signalBack()  start sending again
     TracklyFake.reset()       delete all test accounts and data
*/
(function () {
  'use strict';

  const KEY = 'trackly.fake.db';
  const DEVICES = { 'SB-0001': 'demo1234', 'SB-0002': 'demo1234' };
  // Demo speed: real trackers send every 1–1.5 min; here every 30 s so you don't wait. Lost mode is real: 5 s.
  const NORMAL_EVERY_S = 30;
  const LOST_EVERY_S = 5;

  // Places in Erbil the pretend bag travels between
  const PLACES = {
    home: [36.2297, 43.9937],     // Ankawa
    citadel: [36.1912, 44.0092],
    familyMall: [36.2010, 43.9620],
    park: [36.2045, 43.9935],     // Sami Abdulrahman Park
    majidi: [36.1665, 44.0370]
  };

  // ---------- storage ----------
  const empty = () => ({ users: [], session: null, trackers: [], locations: [], safe_zones: [], silent: {} });
  function load() {
    try { return Object.assign(empty(), JSON.parse(localStorage.getItem(KEY)) || {}); } catch (e) { return empty(); }
  }
  let db = load();
  function save() {
    // keep the newest 6000 locations so localStorage never gets full
    if (db.locations.length > 6000) db.locations = db.locations.slice(-6000);
    try { localStorage.setItem(KEY, JSON.stringify(db)); } catch (e) { /* storage full or blocked */ }
  }

  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const ok = (data) => ({ data, error: null });
  const fail = (message) => ({ data: null, error: { message } });
  const me = () => (db.session ? db.session.user.id : null);

  // Never keep passwords as plain text, even in a test
  // (crypto.subtle only exists on https or localhost; on a phone over Wi-Fi http we use a simple fallback.
  //  That's fine for test mode only — the real login never hashes in the browser.)
  async function hash(text) {
    if (!(window.crypto && crypto.subtle)) {
      let h = 5381;
      for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
      return 'weak-' + h.toString(16);
    }
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  // ---------- "Row Level Security": you only see your own rows ----------
  const myTrackerIds = () => db.trackers.filter((t) => t.owner_id === me()).map((t) => t.id);
  const visible = {
    trackers: (r) => r.owner_id === me(),
    locations: (r) => myTrackerIds().includes(r.tracker_id),
    safe_zones: (r) => r.owner_id === me()
  };

  // ---------- realtime ----------
  const channels = new Set();
  function emit(event, table, row) {
    channels.forEach((ch) => ch.listeners.forEach((l) => {
      if (l.event !== event || l.table !== table) return;
      const m = /^(\w+)=eq\.(.+)$/.exec(l.filter || '');
      if (m && String(row[m[1]]) !== m[2]) return;
      setTimeout(() => l.cb({ new: Object.assign({}, row) }), 0);
    }));
  }

  // ---------- query builder: from('table').select().eq().order().limit() ... then await ----------
  function from(table) {
    const q = { op: 'select', filters: [], sort: null, max: null, one: false, payload: null, returnRows: false };
    const api = {
      select() { if (q.op === 'select') q.op = 'select'; else q.returnRows = true; return api; },
      insert(row) { q.op = 'insert'; q.payload = row; return api; },
      update(values) { q.op = 'update'; q.payload = values; return api; },
      delete() { q.op = 'delete'; return api; },
      eq(col, val) { q.filters.push((r) => String(r[col]) === String(val)); return api; },
      gte(col, val) { q.filters.push((r) => r[col] >= val); return api; },
      lt(col, val) { q.filters.push((r) => r[col] < val); return api; },
      order(col, opts) { q.sort = { col, asc: !opts || opts.ascending !== false }; return api; },
      limit(n) { q.max = n; return api; },
      single() { q.one = true; return api; },
      then(resolve, reject) { return run().then(resolve, reject); }
    };

    async function run() {
      await wait(120); // feels like a network call
      if (!me()) return fail('not signed in');
      const rows = db[table];
      if (!rows) return fail('relation "' + table + '" does not exist');
      const mine = (r) => visible[table](r) && q.filters.every((f) => f(r));

      if (q.op === 'insert') {
        const row = Object.assign({ id: uid(), created_at: new Date().toISOString() }, q.payload);
        if (table === 'safe_zones') {
          if (!myTrackerIds().includes(row.tracker_id)) return fail('not your tracker');
          Object.assign(row, { owner_id: me(), enabled: row.enabled !== false });
        }
        rows.push(row); save();
        return ok(q.one ? Object.assign({}, row) : [Object.assign({}, row)]);
      }
      if (q.op === 'update') {
        const hit = rows.filter(mine);
        hit.forEach((r) => Object.assign(r, q.payload)); save();
        if (table === 'trackers') hit.forEach((r) => emit('UPDATE', 'trackers', r));
        return ok(q.returnRows ? hit.map((r) => Object.assign({}, r)) : null);
      }
      if (q.op === 'delete') {
        db[table] = rows.filter((r) => !mine(r)); save();
        return ok(null);
      }
      let out = rows.filter(mine).map((r) => Object.assign({}, r));
      if (q.sort) {
        const { col, asc } = q.sort;
        out.sort((a, b) => (a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0) * (asc ? 1 : -1));
      }
      if (q.max != null) out = out.slice(0, q.max);
      if (q.one) return out.length ? ok(out[0]) : fail('no rows');
      return ok(out);
    }
    return api;
  }

  // ---------- database functions (what the real SQL will do) ----------
  async function rpc(name, args) {
    await wait(250);
    if (!me()) return fail('not signed in');
    if (name === 'claim_tracker') {
      const code = String(args.p_code || '').trim().toUpperCase();
      if (DEVICES[code] !== String(args.p_secret || '').trim()) return fail('invalid_code');
      const existing = db.trackers.find((t) => t.device_code === code);
      if (existing && existing.owner_id !== me()) return fail('already_paired');
      if (existing) return ok(existing.id);
      const tr = { id: uid(), device_code: code, owner_id: me(), name: args.p_name || 'My bag', mode: 'normal', created_at: new Date().toISOString() };
      db.trackers.push(tr);
      seedHistory(tr);
      save();
      return ok(tr.id);
    }
    if (name === 'set_tracker_mode') {
      if (!['normal', 'lost'].includes(args.p_mode)) return fail('bad mode');
      const tr = db.trackers.find((t) => t.id === args.p_tracker && t.owner_id === me());
      if (!tr) return fail('not your tracker');
      tr.mode = args.p_mode; save();
      emit('UPDATE', 'trackers', tr);
      return ok(null);
    }
    return fail('function ' + name + ' does not exist');
  }

  // ---------- auth (same shapes as supabase.auth) ----------
  const authListeners = new Set();
  const auth = {
    async signUp({ email, password }) {
      await wait(500);
      email = String(email || '').trim().toLowerCase();
      if (db.users.some((u) => u.email === email)) return { data: { user: null, session: null }, error: { message: 'User already registered' } };
      if (String(password || '').length < 6) return { data: { user: null, session: null }, error: { message: 'Password should be at least 6 characters' } };
      const user = { id: uid(), email, pw: await hash(password) };
      db.users.push(user);
      return signInAs(user); // like Supabase with "Confirm email" turned off
    },
    async signInWithPassword({ email, password }) {
      await wait(500);
      email = String(email || '').trim().toLowerCase();
      const user = db.users.find((u) => u.email === email);
      // same message for unknown email and wrong password, so nobody can guess which emails exist
      if (!user || user.pw !== (await hash(String(password || '')))) return { data: { user: null, session: null }, error: { message: 'Invalid login credentials' } };
      return signInAs(user);
    },
    async signOut() {
      db.session = null; save();
      authListeners.forEach((cb) => cb('SIGNED_OUT', null));
      return { error: null };
    },
    async getSession() { return { data: { session: db.session }, error: null }; },
    onAuthStateChange(cb) {
      authListeners.add(cb);
      return { data: { subscription: { unsubscribe: () => authListeners.delete(cb) } } };
    }
  };
  function signInAs(user) {
    db.session = { access_token: 'fake-' + uid(), user: { id: user.id, email: user.email } };
    save();
    authListeners.forEach((cb) => cb('SIGNED_IN', db.session));
    return { data: { user: db.session.user, session: db.session }, error: null };
  }

  // ---------- pretend tracker ----------
  const lastOf = (trId) => {
    for (let i = db.locations.length - 1; i >= 0; i--) if (db.locations[i].tracker_id === trId) return db.locations[i];
    return null;
  };
  const jitter = (m) => (Math.random() - 0.5) * (m / 111000) * 2; // ± m metres in degrees (roughly)

  function addPoint(trId, lat, lng, battery, time, live, accuracy) {
    const row = { id: uid(), tracker_id: trId, lat: +lat.toFixed(6), lng: +lng.toFixed(6), battery, created_at: new Date(time).toISOString() };
    if (accuracy) row.accuracy = Math.round(accuracy); // metres (real trackers don't send this yet)
    db.locations.push(row);
    if (live) emit('INSERT', 'locations', row);
    return row;
  }

  // A believable day: still at home, trips between places (a point every 90 s while moving), hourly check-ins when still
  function seedDay(trId, dayStart, until, battery) {
    const plan = [
      [8, 'home'], [9, 'citadel'], [12.5, 'familyMall'], [16.5, 'park'], [19, 'majidi'], [21, 'home']
    ];
    let pos = PLACES.home, t = dayStart + 8 * 3600e3;
    for (const [hour, place] of plan) {
      const leave = dayStart + hour * 3600e3;
      // still: hourly check-ins until it's time to leave
      for (; t < leave && t < until; t += 3600e3) addPoint(trId, pos[0] + jitter(8), pos[1] + jitter(8), battery, t, false);
      if (leave >= until) return { pos, battery };
      // trip: about 25 km/h, a point every 90 s
      const to = PLACES[place], steps = 14;
      for (let s = 1; s <= steps && t < until; s++, t += 90e3) {
        const k = s / steps;
        addPoint(trId, pos[0] + (to[0] - pos[0]) * k + jitter(25), pos[1] + (to[1] - pos[1]) * k + jitter(25), battery, t, false);
      }
      battery = Math.max(25, battery - 4);
      pos = to;
    }
    for (; t < until; t += 3600e3) addPoint(trId, pos[0] + jitter(8), pos[1] + jitter(8), battery, t, false);
    return { pos, battery };
  }

  function seedHistory(tr) {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const day = 86400e3, now = Date.now();
    seedDay(tr.id, today.getTime() - 2 * day, today.getTime() - day, 100);
    seedDay(tr.id, today.getTime() - day, today.getTime(), 95);
    const r = seedDay(tr.id, today.getTime(), now - 60e3, 78);
    addPoint(tr.id, r.pos[0], r.pos[1], r.battery, now - 20e3, false); // fresh point, so the bag shows as online
    // a ready-made safe zone, so History can show "Left Home / Arrived Home"
    db.safe_zones.push({ id: uid(), owner_id: tr.owner_id, tracker_id: tr.id, name: 'Home', kind: 'home', lat: PLACES.home[0], lng: PLACES.home[1], radius_m: 300, notify_on: 'both', enabled: true, created_at: new Date().toISOString() });
  }

  // ---------- "the phone is the tracker": use this phone's real GPS + battery ----------
  // On (config usePhoneGps: true), the pretend tracker sits wherever this phone is, live.
  // Needs https (or localhost). If GPS isn't allowed, it falls back to the pretend route around Erbil.
  const gps = { fix: null, started: false, failed: false, battery: null, lastSent: {} };
  function startGps() {
    gps.started = true;
    const cfg = window.TRACKLY_CONFIG || {};
    if (cfg.usePhoneGps === false || !navigator.geolocation || !window.isSecureContext) { gps.failed = true; return; }
    navigator.geolocation.watchPosition((pos) => {
      const first = !gps.fix;
      gps.fix = { lat: pos.coords.latitude, lng: pos.coords.longitude, acc: pos.coords.accuracy, at: Date.now() };
      if (first) {
        tick(true);                // jump to where you really are straight away
        const tag = document.getElementById('fake-tag');
        if (tag) tag.textContent = 'TEST MODE · LIVE GPS';
      }
      else tick(false, true);      // moved? send now (like the real tracker does when the bag moves)
    }, () => { gps.failed = true; }, { enableHighAccuracy: true, maximumAge: 3000, timeout: 20000 });
    // real phone battery where the browser allows it (Android Chrome; not iPhone)
    if (navigator.getBattery) navigator.getBattery().then((b) => {
      const read = () => { gps.battery = Math.round(b.level * 100); };
      read(); b.addEventListener('levelchange', read);
    }).catch(() => {});
  }

  // Every 5 s: each of my trackers sends a point when it's due (5 s lost, 30 s normal)
  const heading = {};
  function tick(force, onMove) {
    if (!me()) return;
    const mine = db.trackers.filter((t) => t.owner_id === me());
    if (mine.length && !gps.started) startGps();
    mine.forEach((tr) => {
      if (db.silent[tr.id]) return;
      const last = lastOf(tr.id);
      if (!last) return;
      const lost = tr.mode === 'lost';
      const since = Date.now() - new Date(last.created_at).getTime();

      if (gps.fix && Date.now() - gps.fix.at < 120000) {
        const moved = Math.hypot((gps.fix.lat - last.lat) * 111000, (gps.fix.lng - last.lng) * 90000);
        // send when due, or as soon as it moved 20 m+ (at most every 5 s)
        const due = force || since >= (lost ? LOST_EVERY_S : NORMAL_EVERY_S) * 1000 - 500 || (onMove && moved > 20 && since >= 5000);
        if (!due) return;
        const battery = gps.battery ?? Math.max(1, (last.battery ?? 80) - (Math.random() < (lost ? 0.15 : 0.05) ? 1 : 0));
        addPoint(tr.id, gps.fix.lat, gps.fix.lng, battery, Date.now(), true, gps.fix.acc);
        save();
        return;
      }
      if (onMove) return;
      if (since < (lost ? LOST_EVERY_S : NORMAL_EVERY_S) * 1000 - 500) return;
      // lost: someone is walking away with it (~12 m per 5 s); normal: moves now and then
      const moving = lost || Math.random() < 0.5;
      const step = lost ? 12 : 35;   // metres per point: walking pace
      heading[tr.id] = (heading[tr.id] ?? Math.random() * 6.28) + (Math.random() - 0.5) * 0.6;
      const lat = last.lat + (moving ? Math.cos(heading[tr.id]) * step / 111000 : 0);
      const lng = last.lng + (moving ? Math.sin(heading[tr.id]) * step / 90000 : 0);
      const drain = lost ? (Math.random() < 0.15 ? 1 : 0) : (Math.random() < 0.05 ? 1 : 0);
      addPoint(tr.id, lat, lng, Math.max(1, (last.battery ?? 80) - drain), Date.now(), true);
      save();
    });
  }
  setInterval(tick, 5000);
  window.addEventListener('load', () => setTimeout(tick, 1500)); // start GPS soon after opening

  // ---------- console helpers ----------
  window.TracklyFake = {
    battery(n) {
      myTrackerIds().forEach((id) => { const l = lastOf(id); if (l) addPoint(id, l.lat, l.lng, Math.max(0, Math.min(100, n)), Date.now(), true); });
      save(); return 'Battery set to ' + n + '%';
    },
    noSignal() {
      // remove the last 80 minutes of points, then leave one "last seen" point 80 min ago
      const cut = new Date(Date.now() - 80 * 60e3).toISOString();
      myTrackerIds().forEach((id) => {
        db.silent[id] = true;
        const l = lastOf(id);
        db.locations = db.locations.filter((r) => r.tracker_id !== id || r.created_at <= cut);
        if (l) addPoint(id, l.lat, l.lng, l.battery, Date.now() - 80 * 60e3, false);
      });
      save(); location.reload(); return 'No signal for 80 min (page reloads)';
    },
    signalBack() { db.silent = {}; save(); return 'Sending again within 30 s'; },
    gpsStatus() { return gps.fix ? 'Using this phone’s GPS (±' + Math.round(gps.fix.acc) + ' m)' : (gps.failed ? 'GPS not available, using the pretend route' : 'Waiting for GPS…'); },
    reset() { localStorage.removeItem(KEY); location.reload(); return 'All test data deleted'; }
  };

  // ---------- the pretend client ----------
  window.createFakeSupabase = function () {
    return {
      auth, from, rpc,
      channel(name) {
        const ch = { name, listeners: [] };
        ch.on = (type, opts, cb) => { ch.listeners.push({ event: opts.event, table: opts.table, filter: opts.filter, cb }); return ch; };
        ch.subscribe = () => { channels.add(ch); return ch; };
        return ch;
      },
      removeChannel(ch) { channels.delete(ch); return Promise.resolve('ok'); }
    };
  };

  // Small label so it's always clear this is not real data
  document.addEventListener('DOMContentLoaded', () => {
    const tag = document.createElement('div');
    tag.id = 'fake-tag';
    tag.textContent = 'TEST MODE';
    tag.setAttribute('aria-hidden', 'true');
    tag.style.cssText = 'position:fixed;top:max(6px,env(safe-area-inset-top));left:50%;transform:translateX(-50%);z-index:9999;' +
      'padding:2px 10px;border-radius:999px;background:#D93A3F;color:#fff;font:600 11px Sora,system-ui,sans-serif;letter-spacing:1px;pointer-events:none';
    document.body.appendChild(tag);
  });
})();
