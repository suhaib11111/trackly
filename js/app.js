/* Trackly web app
   Plain JavaScript, no build step. Uses Supabase (auth + database + realtime) and Leaflet (map). */
(function () {
  'use strict';

  const CFG = window.TRACKLY_CONFIG;
  // Test mode uses the pretend backend (js/fake-backend.js); otherwise the real Supabase
  const sb = CFG.fakeBackend ? window.createFakeSupabase() : window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey);
  const ERBIL = [36.1911, 44.0092];
  const LANGS = ['en', 'ckb', 'ar'];

  // ---------- state ----------
  const state = {
    user: null,
    trackers: [],
    tracker: null,          // current tracker row
    recent: [],             // latest locations, newest first
    zones: [],
    lang: pickLanguage(),
    tab: 'map',
    authMode: 'login',
    channel: null,
    followBag: true,
    bannerHiddenFor: null,
    zoneEdit: null,         // { notify }
    historyDay: 0,
    historyDate: null,
    areaCache: {},
    areaKey: null,
    mapStyle: (() => { const v = localStorage.getItem('trackly-map-style'); return ['clean', 'detailed', 'sat', 'hybrid'].includes(v) ? v : (v === 'sat' ? 'sat' : 'clean'); })(),
    showPath: localStorage.getItem('trackly-show-path') === '1',   // today's path on the main map
    historyPts: [],
    me: null                // the phone's own location { lat, lng, acc }, after "My location"
  };

  const map = { m: null, tiles: null, marker: null, accuracy: null, trail: null, history: null, zones: null, editCircle: null, meDot: null, meCircle: null };

  // Safe zone types: icon (SVG path) + the default name key. The user can still type any name.
  const ZONE_KINDS = {
    home: 'M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z',
    work: 'M3 8h18v12H3zM9 8V5h6v3M3 13h18',
    school: 'M2 9l10-5 10 5-10 5zM6 11v5c3 2 9 2 12 0v-5',
    gym: 'M6 7v10M18 7v10M3 10v4M21 10v4M6 12h12',
    family: 'M12 20s-7-4.5-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.5-7 10-7 10z',
    other: 'M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21zM12 7.5a2 2 0 1 0 0 4 2 2 0 0 0 0-4z'
  };
  const kindIcon = (kind) => '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="' + (ZONE_KINDS[kind] || ZONE_KINDS.other) + '"/></svg>';

  // ---------- helpers ----------
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  function pickLanguage() {
    const saved = localStorage.getItem('trackly-lang');
    if (saved && LANGS.includes(saved)) return saved;
    const nav = (navigator.language || 'en').toLowerCase();
    if (nav.startsWith('ckb') || nav.startsWith('ku')) return 'ckb';
    if (nav.startsWith('ar')) return 'ar';
    return 'en';
  }

  function t(key, vars) {
    const dict = window.I18N[state.lang] || window.I18N.en;
    let s = dict[key] !== undefined ? dict[key] : (window.I18N.en[key] !== undefined ? window.I18N.en[key] : key);
    if (vars) Object.keys(vars).forEach((k) => { s = s.split('{' + k + '}').join(String(vars[k])); });
    return s;
  }

  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { el.hidden = true; }, 3200);
  }

  function showView(id) {
    $$('.view').forEach((v) => { v.hidden = v.id !== id; });
    if (id === 'view-app' && map.m) setTimeout(() => map.m.invalidateSize(), 50);
  }

  function errorText(err) {
    const msg = (err && (err.message || err.error_description)) || '';
    if (msg.includes('invalid_code')) return t('err_invalid_code');
    if (msg.includes('already_paired')) return t('err_already_paired');
    if (msg.toLowerCase().includes('invalid login')) return t('err_login');
    if (msg && msg.length < 140 && !msg.includes('fetch')) return msg;
    return t('err_generic');
  }

  function distanceM(a, b) {
    const R = 6371000;
    const toRad = (x) => (x * Math.PI) / 180;
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  function ageSeconds(row) {
    return Math.max(0, (Date.now() - new Date(row.created_at).getTime()) / 1000);
  }

  function relTime(sec) {
    if (sec < 15) return t('just_now');
    if (sec < 60) return t('sec_ago', { n: Math.round(sec) });
    if (sec < 3600) return t('min_ago', { n: Math.round(sec / 60) });
    if (sec < 86400) return t('hour_ago', { n: Math.round(sec / 3600) });
    return t('day_ago', { n: Math.round(sec / 86400) });
  }

  function clockTime(iso) {
    const locale = state.lang === 'en' ? 'en-GB' : (state.lang === 'ar' ? 'ar-IQ-u-nu-latn' : 'ckb-IQ-u-nu-latn');
    try { return new Date(iso).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' }); }
    catch (e) { return new Date(iso).toTimeString().slice(0, 5); }
  }

  function isDark() { return window.matchMedia('(prefers-color-scheme: dark)').matches; }
  function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

  // ---------- language ----------
  function applyLang() {
    const dict = window.I18N[state.lang];
    document.documentElement.lang = state.lang;
    document.documentElement.dir = dict._dir;
    $$('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
    $$('[data-i18n-ph]').forEach((el) => { el.placeholder = t(el.dataset.i18nPh); });
    $$('[data-i18n-aria]').forEach((el) => { el.setAttribute('aria-label', t(el.dataset.i18nAria)); });
    $$('.lang-btn').forEach((el) => { el.textContent = dict._label; });
    $$('.lang-label').forEach((el) => { el.textContent = dict._label; });
    updateAuthButton();
    state.areaKey = null;
    if (state.tracker) { renderMapPanel(); renderZones(); if (state.tab === 'history') loadHistory(); }
  }

  function cycleLang() {
    state.lang = LANGS[(LANGS.indexOf(state.lang) + 1) % LANGS.length];
    localStorage.setItem('trackly-lang', state.lang);
    applyLang();
  }

  // ---------- auth ----------
  function updateAuthButton() {
    const btn = $('#auth-submit');
    btn.textContent = state.authMode === 'login' ? t('login') : t('signup');
    $('#auth-password').autocomplete = state.authMode === 'login' ? 'current-password' : 'new-password';
  }

  async function onAuthSubmit(e) {
    e.preventDefault();
    const email = $('#auth-email').value.trim();
    const password = $('#auth-password').value;
    const err = $('#auth-error');
    err.textContent = '';
    if (!email || password.length < 6) { err.textContent = t('err_fill'); return; }
    const btn = $('#auth-submit');
    btn.disabled = true;
    try {
      if (state.authMode === 'login') {
        const { error } = await sb.auth.signInWithPassword({ email, password });
        if (error) throw error;
      } else {
        const { data, error } = await sb.auth.signUp({ email, password });
        if (error) throw error;
        if (!data.session) { err.textContent = t('err_signup_check'); return; }
      }
      rememberLogin(email, password);
      await route();
    } catch (ex) {
      err.textContent = errorText(ex);
    } finally {
      btn.disabled = false;
    }
  }

  // Remember the email on this phone, and offer the password to the phone's password manager
  // (iCloud Keychain / Google Password Manager). We never store the password ourselves.
  function rememberLogin(email, password) {
    localStorage.setItem('trackly-last-email', email);
    try {
      if (window.PasswordCredential && window.isSecureContext) {
        navigator.credentials.store(new window.PasswordCredential({ id: email, password, name: email })).catch(() => {});
      }
    } catch (e) { /* not supported */ }
  }

  // ---------- saved trackers (code + secret kept on this phone, so re-pairing is one tap) ----------
  function savedTrackers() {
    try { return JSON.parse(localStorage.getItem('trackly-saved-trackers')) || []; } catch (e) { return []; }
  }
  function saveTracker(code, secret, name) {
    const list = savedTrackers().filter((x) => x.code !== code);
    list.unshift({ code, secret, name });
    localStorage.setItem('trackly-saved-trackers', JSON.stringify(list.slice(0, 5)));
  }
  function renderSavedTrackers() {
    const list = savedTrackers();
    // in test mode, always offer the test tracker
    if (CFG.fakeBackend && !list.some((x) => x.code === 'SB-0001')) list.push({ code: 'SB-0001', secret: 'demo1234', name: t('test_tracker') });
    const box = $('#saved-trackers');
    const wrap = $('#saved-list');
    wrap.innerHTML = '';
    box.hidden = !list.length;
    const paired = state.trackers.map((x) => x.device_code);
    list.filter((x) => !paired.includes(x.code)).forEach((x) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'saved-item';
      const strong = document.createElement('strong');
      strong.textContent = x.name || x.code;
      b.appendChild(strong);
      if (x.name) { const span = document.createElement('span'); span.textContent = x.code; b.appendChild(span); }
      b.addEventListener('click', () => {
        $('#pair-code').value = x.code;
        $('#pair-secret').value = x.secret;
        if (!$('#pair-name').value && x.name && x.name !== t('test_tracker')) $('#pair-name').value = x.name;
        $('#pair-form').requestSubmit();
      });
      wrap.appendChild(b);
    });
    if (!wrap.children.length) box.hidden = true;
  }

  async function logout() {
    unsubscribe();
    await sb.auth.signOut();
    state.user = null; state.trackers = []; state.tracker = null; state.recent = []; state.zones = [];
    showView('view-auth');
  }

  // ---------- routing ----------
  async function route() {
    const { data } = await sb.auth.getSession();
    state.user = data.session ? data.session.user : null;
    if (!state.user) { showView('view-auth'); return; }
    $('#account-email').textContent = state.user.email || '';
    await loadTrackers();
    if (!state.trackers.length) { renderSavedTrackers(); showView('view-pair'); $('[data-action="pair-back"]').hidden = true; return; }
    if (!localStorage.getItem('trackly-setup-done')) { showView('view-setup'); return; }
    openApp();
  }

  async function loadTrackers() {
    const { data, error } = await sb.from('trackers').select('id, device_code, name, mode').order('created_at');
    if (error) { toast(errorText(error)); state.trackers = []; return; }
    state.trackers = data || [];
    const sel = $('#tracker-select');
    sel.innerHTML = '';
    state.trackers.forEach((tr) => {
      const o = document.createElement('option');
      o.value = tr.id;
      o.textContent = tr.name || tr.device_code;
      sel.appendChild(o);
    });
  }

  // ---------- pairing ----------
  async function onPairSubmit(e) {
    e.preventDefault();
    const code = $('#pair-code').value.trim();
    const secret = $('#pair-secret').value.trim();
    const name = $('#pair-name').value.trim();
    const err = $('#pair-error');
    err.textContent = '';
    if (!code || !secret) { err.textContent = t('err_fill'); return; }
    const btn = $('#pair-submit');
    btn.disabled = true;
    try {
      const { data, error } = await sb.rpc('claim_tracker', { p_code: code, p_secret: secret, p_name: name || null });
      if (error) throw error;
      saveTracker(code.toUpperCase(), secret, name);
      $('#pair-form').reset();
      await loadTrackers();
      localStorage.setItem('trackly-tracker', data);
      if (!localStorage.getItem('trackly-setup-done')) showView('view-setup');
      else openApp();
    } catch (ex) {
      err.textContent = errorText(ex);
    } finally {
      btn.disabled = false;
    }
  }

  // ---------- setup / notifications ----------
  async function allowNotifications() {
    const standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
    const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
    if (!('Notification' in window)) { toast(ios && !standalone ? t('toast_notif_install') : t('toast_notif_blocked')); return; }
    const result = await Notification.requestPermission();
    toast(result === 'granted' ? t('toast_notif_on') : t('toast_notif_blocked'));
    if (result === 'granted') finishSetup();
  }

  function finishSetup() {
    localStorage.setItem('trackly-setup-done', '1');
    if (state.trackers.length) openApp(); else showView('view-pair');
  }

  // ---------- map ----------
  function initMap() {
    if (map.m) return;
    map.m = L.map('map', { zoomControl: false, attributionControl: true, zoomSnap: 0.5, maxZoom: 20 }).setView(ERBIL, 14);
    L.control.scale({ imperial: false, position: 'bottomleft', maxWidth: 110 }).addTo(map.m);
    map.m.attributionControl.setPrefix(false);
    setTiles();
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { setTiles(); renderMapPanel(); });
    map.m.on('dragstart', () => { if (!state.zoneEdit) { state.followBag = false; updateCenterBtn(); } });
    // while adding a safe zone, a tap on the map moves the pin there
    map.m.on('click', (e) => { $('#style-picker').hidden = true; if (state.zoneEdit) placePinAt(e.latlng); });
    map.zones = L.layerGroup().addTo(map.m);
    // the floating map buttons sit just above the bottom card, whatever its height
    if (window.ResizeObserver) new ResizeObserver(() => {
      document.documentElement.style.setProperty('--sheet-h', $('#sheet').offsetHeight + 'px');
    }).observe($('#sheet'));
  }

  // Base map. Default: OpenFreeMap (free, no key, sharp vector map with light + dark styles).
  // "Satellite": Esri World Imagery photos. Fallback if the phone has no WebGL: OpenStreetMap images.
  function webglOk() {
    try { const c = document.createElement('canvas'); return !!(c.getContext('webgl2') || c.getContext('webgl')); } catch (e) { return false; }
  }
  // Map styles:
  //   clean    = OpenFreeMap Positron / Dark (calm, few colours)
  //   detailed = OpenFreeMap Liberty / Fiord (buildings, shops, parks, house numbers, more labels)
  //   sat      = Esri satellite photos
  //   hybrid   = satellite photos + street names and roads on top
  const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/';
  const OFM_ATTR = '<a href="https://openfreemap.org" target="_blank">OpenFreeMap</a> &copy; <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a>';
  function setTiles() {
    if (map.tiles) map.m.removeLayer(map.tiles);
    const dark = isDark();
    const st = state.mapStyle;
    let raster = true;
    if (st === 'sat' || st === 'hybrid') {
      const layers = [L.tileLayer(ESRI + 'World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 20, maxNativeZoom: 18, attribution: 'Imagery &copy; Esri' })];
      if (st === 'hybrid') {
        layers.push(L.tileLayer(ESRI + 'Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}', { maxZoom: 20, maxNativeZoom: 18, opacity: 0.9 }));
        layers.push(L.tileLayer(ESRI + 'Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}', { maxZoom: 20, maxNativeZoom: 18 }));
      }
      map.tiles = L.layerGroup(layers);
    } else if (L.maplibreGL && webglOk()) {
      raster = false;
      const name = st === 'detailed' ? (dark ? 'fiord' : 'liberty') : (dark ? 'dark' : 'positron');
      map.tiles = L.maplibreGL({ style: 'https://tiles.openfreemap.org/styles/' + name, attribution: OFM_ATTR });
    } else {
      map.tiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 20, maxNativeZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
      });
    }
    map.tiles.addTo(map.m);
    // the CSS dark filter is only for the plain OpenStreetMap fallback
    map.m.getContainer().classList.toggle('map-dark', dark && raster && st !== 'sat' && st !== 'hybrid');
    // white text on photos needs a darker card behind the floating buttons
    map.m.getContainer().classList.toggle('map-photo', st === 'sat' || st === 'hybrid');
    $$('#style-picker [data-style]').forEach((b) => b.classList.toggle('active', b.dataset.style === st));
  }

  function toggleMapStyle() {
    const p = $('#style-picker');
    p.hidden = !p.hidden;
  }
  function pickStyle(st) {
    state.mapStyle = st;
    localStorage.setItem('trackly-map-style', st);
    setTiles();
    $('#style-picker').hidden = true;
  }

  function markerIcon(kind) {
    return L.divIcon({
      className: '',
      html: '<div class="bag-marker ' + kind + '"><span class="pulse"></span><span class="heading" hidden></span><span class="core">' +
        '<svg viewBox="0 0 24 24"><path d="M6 8h12l1 12H5L6 8z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/></svg></span></div>',
      iconSize: [44, 44], iconAnchor: [22, 22]
    });
  }

  // Glide the pin to its new spot instead of jumping (nice in lost mode, every 5 s)
  function moveMarker(layer, to) {
    const from = layer.getLatLng();
    if (from.distanceTo(to) < 1 || from.distanceTo(to) > 3000 || matchMedia('(prefers-reduced-motion: reduce)').matches) { layer.setLatLng(to); return; }
    const t0 = performance.now(), dur = 900;
    cancelAnimationFrame(layer._glide);
    const step = (now) => {
      const k = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - k, 3);
      layer.setLatLng([from.lat + (to.lat - from.lat) * e, from.lng + (to.lng - from.lng) * e]);
      if (k < 1) layer._glide = requestAnimationFrame(step);
    };
    layer._glide = requestAnimationFrame(step);
  }

  function centerOnBag() {
    const loc = state.recent[0];
    if (!loc) { toast(t('no_location')); return; }
    state.followBag = true;
    updateCenterBtn();
    map.m.setView([loc.lat, loc.lng], Math.max(map.m.getZoom(), 17), { animate: true });
  }
  function updateCenterBtn() { $('#btn-center') && $('#btn-center').classList.toggle('active', state.followBag); }

  // The phone's own location: blue dot, and "X km from you" on the card. forZone = move the zone pin there.
  // Live: after the first tap the blue dot keeps following you (watchPosition), and the
  // "X km from you" on the card updates as you walk. Tapping again shows you + the bag.
  let meWatch = null, meWaiting = null;
  function showMeAndBag() {
    state.followBag = false; updateCenterBtn();
    const loc = state.recent[0];
    if (loc) map.m.fitBounds(L.latLngBounds([[loc.lat, loc.lng], [state.me.lat, state.me.lng]]), { paddingTopLeft: [40, 120], paddingBottomRight: [40, $('#sheet').offsetHeight + 40], maxZoom: 17 });
    else map.m.setView([state.me.lat, state.me.lng], 16);
  }
  function locateMe(fly, forZone) {
    if (!navigator.geolocation) { toast(t('toast_no_gps')); return; }
    if (!window.isSecureContext) { toast(t('toast_gps_https')); return; }
    if (state.me && meWatch !== null) {          // already live: act right away
      if (forZone) placePinAt(L.latLng(state.me.lat, state.me.lng)); else if (fly) showMeAndBag();
      return;
    }
    meWaiting = { fly, forZone };
    $('[data-action="locate-me"]').classList.add('active');
    if (meWatch !== null) return;
    const onFix = (pos) => {
      state.me = { lat: pos.coords.latitude, lng: pos.coords.longitude, acc: pos.coords.accuracy };
      drawMe();
      if (meWaiting) {                            // first fix after a tap
        const w = meWaiting; meWaiting = null;
        if (w.forZone) placePinAt(L.latLng(state.me.lat, state.me.lng)); else if (w.fly) showMeAndBag();
      }
      if (!state.zoneEdit) renderMapPanel();
    };
    // a quick first answer (the phone's last known spot), then live updates as you move
    navigator.geolocation.getCurrentPosition(onFix, () => {}, { maximumAge: 60000, timeout: 8000 });
    meWatch = navigator.geolocation.watchPosition(onFix, () => {
      toast(t('toast_no_gps'));
      navigator.geolocation.clearWatch(meWatch); meWatch = null; meWaiting = null;
      $('[data-action="locate-me"]').classList.remove('active');
    }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 5000 });
  }
  function drawMe() {
    if (!state.me) return;
    const ll = [state.me.lat, state.me.lng];
    if (!map.meDot) {
      map.meCircle = L.circle(ll, { radius: Math.min(state.me.acc, 300), weight: 0, fillColor: '#3B82F6', fillOpacity: 0.12, interactive: false }).addTo(map.m);
      map.meDot = L.circleMarker(ll, { radius: 7, weight: 3, color: '#FFFFFF', fillColor: '#3B82F6', fillOpacity: 1, interactive: false }).addTo(map.m);
    } else { map.meDot.setLatLng(ll); map.meCircle.setLatLng(ll).setRadius(Math.min(state.me.acc, 300)); }
  }

  function openDirections() {
    const loc = state.recent[0];
    if (!loc) return;
    window.open('https://www.google.com/maps/dir/?api=1&destination=' + loc.lat.toFixed(6) + ',' + loc.lng.toFixed(6), '_blank', 'noopener');
  }

  // The safe zone a point is inside (smallest one first), or null
  function zoneAt(p) {
    return state.zones.filter((z) => distanceM(p, z) <= z.radius_m).sort((a, b) => a.radius_m - b.radius_m)[0] || null;
  }
  // compass bearing from a to b in degrees (0 = north, 90 = east)
  function bearing(a, b) {
    const toRad = (x) => (x * Math.PI) / 180;
    const y = Math.sin(toRad(b.lng - a.lng)) * Math.cos(toRad(b.lat));
    const x = Math.cos(toRad(a.lat)) * Math.sin(toRad(b.lat)) - Math.sin(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.cos(toRad(b.lng - a.lng));
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  }
  function compass(deg) { return ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'][Math.round(deg / 45) % 8]; }

  // ---- tap the bag: a card with the exact address, coordinates, accuracy and quick actions ----
  async function showBagInfo() {
    if (!state.bagInfo) return;
    const { loc } = state.bagInfo;
    if (!map.info) map.info = L.popup({ className: 'bag-popup', closeButton: true, autoPanPaddingTopLeft: [16, 130], maxWidth: 300, offset: [0, -16] });
    map.info.setLatLng([loc.lat, loc.lng]).setContent(buildBagInfo()).openOn(map.m);
    fillBagInfo();
    // full street address (one request, cached per spot)
    const key = 'full:' + state.lang + ':' + loc.lat.toFixed(4) + ',' + loc.lng.toFixed(4);
    if (!state.areaCache[key]) {
      try {
        const lang = state.lang === 'ckb' ? 'ckb,ku,ar' : state.lang;
        const r = await fetch('https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&lat=' + loc.lat + '&lon=' + loc.lng + '&accept-language=' + lang);
        if (r.ok) state.areaCache[key] = (await r.json()).display_name || '';
      } catch (e) { /* offline */ }
    }
    const el = document.getElementById('bi-address');
    if (el) el.textContent = state.areaCache[key] || $('#bag-area').textContent;
  }
  function buildBagInfo() {
    const box = document.createElement('div');
    box.className = 'bi';
    box.innerHTML =
      '<strong class="bi-title"></strong>' +
      '<p id="bi-address" class="bi-address"></p>' +
      '<dl class="bi-grid">' +
      '<dt data-k="coords"></dt><dd><button type="button" id="bi-coords" class="bi-coords" dir="ltr"></button></dd>' +
      '<dt data-k="accuracy"></dt><dd id="bi-acc"></dd>' +
      '<dt data-k="updated"></dt><dd id="bi-time"></dd>' +
      '<dt data-k="status"></dt><dd id="bi-move"></dd>' +
      '</dl>' +
      '<div class="bi-actions"><button type="button" class="btn btn-secondary" id="bi-copy"></button><button type="button" class="btn btn-primary" id="bi-maps"></button></div>';
    box.querySelectorAll('[data-k]').forEach((x) => { x.textContent = t(x.dataset.k); });
    box.querySelector('.bi-title').textContent = state.tracker ? (state.tracker.name || state.tracker.device_code) : '';
    box.querySelector('#bi-address').textContent = $('#bag-area').textContent;
    box.querySelector('#bi-copy').textContent = t('copy');
    box.querySelector('#bi-maps').textContent = t('open_maps');
    const copy = async () => {
      const l = state.bagInfo.loc;
      const text = l.lat.toFixed(6) + ', ' + l.lng.toFixed(6);
      try { await navigator.clipboard.writeText(text); toast(t('copied')); } catch (e) { toast(text); }
    };
    box.querySelector('#bi-copy').addEventListener('click', copy);
    box.querySelector('#bi-coords').addEventListener('click', copy);
    box.querySelector('#bi-maps').addEventListener('click', () => {
      const l = state.bagInfo.loc;
      window.open('https://www.google.com/maps/search/?api=1&query=' + l.lat.toFixed(6) + ',' + l.lng.toFixed(6), '_blank', 'noopener');
    });
    return box;
  }
  function fillBagInfo() {
    const i = state.bagInfo;
    if (!i || !document.getElementById('bi-coords')) return;
    map.info.setLatLng([i.loc.lat, i.loc.lng]);
    document.getElementById('bi-coords').textContent = i.loc.lat.toFixed(5) + ', ' + i.loc.lng.toFixed(5);
    document.getElementById('bi-acc').textContent = '± ' + fmtDistance(typeof i.loc.accuracy === 'number' ? i.loc.accuracy : 25);
    document.getElementById('bi-time').textContent = clockTime(i.loc.created_at) + ' · ' + relTime(ageSeconds(i.loc));
    document.getElementById('bi-move').textContent = i.stale ? t('unknown')
      : (i.heading !== null ? t('moving_dir', { n: i.kmh, dir: t('dir_' + compass(i.heading)) }) : t('still'));
  }

  // ---- today's path on the main map (the wavy-line button) ----
  let pathPts = [], pathFor = null;
  async function loadPath() {
    if (!state.tracker) return;
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const { data } = await sb.from('locations').select('lat, lng, created_at').eq('tracker_id', state.tracker.id)
      .gte('created_at', start.toISOString()).order('created_at', { ascending: true }).limit(3000);
    pathPts = (data || []).map((p) => [p.lat, p.lng]);
    pathFor = state.tracker.id;
    drawPath();
  }
  function drawPath() {
    if (map.path) { map.m.removeLayer(map.path); map.path = null; }
    if ($('#btn-path')) $('#btn-path').classList.toggle('active', state.showPath);
    if (!state.showPath || !state.tracker || state.tab !== 'map' || state.zoneEdit) return;
    if (pathFor !== state.tracker.id) { pathFor = state.tracker.id; loadPath(); return; }
    // keep it in step with live points
    const l = state.recent[0];
    const end = pathPts[pathPts.length - 1];
    if (l && (!end || end[0] !== l.lat || end[1] !== l.lng)) pathPts.push([l.lat, l.lng]);
    if (pathPts.length > 1) map.path = L.polyline(pathPts, { color: cssVar('--accent'), weight: 4, opacity: 0.75, lineJoin: 'round', interactive: false }).addTo(map.m);
  }
  function togglePath() {
    state.showPath = !state.showPath;
    localStorage.setItem('trackly-show-path', state.showPath ? '1' : '0');
    if (state.showPath) loadPath(); else drawPath();
    toast(state.showPath ? t('path_on') : t('path_off'));
  }

  function fmtDistance(m) {
    if (m < 1000) return Math.round(m / 10) * 10 + (state.lang === 'en' ? ' m' : ' م');
    return (m / 1000).toFixed(m < 10000 ? 1 : 0) + (state.lang === 'en' ? ' km' : (state.lang === 'ar' ? ' كم' : ' کم'));
  }

  // ---------- open app & tracker ----------
  async function openApp() {
    showView('view-app');
    initMap();
    const saved = localStorage.getItem('trackly-tracker');
    const tr = state.trackers.find((x) => x.id === saved) || state.trackers[0];
    $('#tracker-select').value = tr.id;
    await selectTracker(tr.id);
    switchTab('map');
  }

  async function selectTracker(id) {
    unsubscribe();
    state.tracker = state.trackers.find((x) => x.id === id) || null;
    if (!state.tracker) return;
    localStorage.setItem('trackly-tracker', id);
    state.followBag = true;
    state.areaKey = null;

    const [locs, zones] = await Promise.all([
      sb.from('locations').select('lat, lng, battery, created_at').eq('tracker_id', id).order('created_at', { ascending: false }).limit(60),
      sb.from('safe_zones').select('*').eq('tracker_id', id).order('created_at')
    ]);
    if (locs.error) toast(errorText(locs.error));
    state.recent = locs.data || [];
    state.zones = zones.data || [];

    state.channel = sb.channel('tracker-' + id)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'locations', filter: 'tracker_id=eq.' + id }, (payload) => {
        state.recent.unshift(payload.new);
        if (state.recent.length > 200) state.recent.length = 200;
        renderMapPanel();
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'trackers', filter: 'id=eq.' + id }, (payload) => {
        Object.assign(state.tracker, { mode: payload.new.mode, name: payload.new.name });
        renderMapPanel();
      })
      .subscribe();

    renderMapPanel();
    renderZones();
    if (state.tab === 'history') loadHistory();
  }

  function unsubscribe() {
    if (state.channel) { sb.removeChannel(state.channel); state.channel = null; }
  }

  // ---------- map panel ----------
  function renderMapPanel() {
    const tr = state.tracker;
    if (!tr || !map.m) return;
    const lost = tr.mode === 'lost';
    const loc = state.recent[0];

    $('#bag-name').textContent = tr.name || tr.device_code;
    $('#lost-label').hidden = !lost;
    $('#live-badge').hidden = !lost;
    $('#silent-note').hidden = !lost;
    $('#normal-actions').hidden = lost;
    $('#hold-help').hidden = lost;
    $('#lost-actions').hidden = !lost;

    const chip = $('#mode-chip');
    chip.classList.toggle('lost', lost);
    chip.textContent = lost ? t('mode_lost') : t('mode_normal');

    if (!loc) {
      $('#bag-zone').hidden = true;
      $('#bag-distance').textContent = '';
      $('[data-action="directions"]').disabled = true;
      $('#bag-area').textContent = '—';
      $('#nosignal-note').hidden = false;
      $('#nosignal-note').textContent = t('no_location');
      $('#stat-battery').textContent = '—';
      $('#stat-updated').textContent = '—';
      $('#stat-status').textContent = t('waiting');
      $('#battery-banner').hidden = true;
      if (map.marker) { map.m.removeLayer(map.marker); map.marker = null; }
      if (map.accuracy) { map.m.removeLayer(map.accuracy); map.accuracy = null; }
      return;
    }

    const age = ageSeconds(loc);
    const staleAfter = lost ? 60 : (CFG.stillCheckinMin + 15) * 60;
    const stale = age > staleAfter;
    // Moving = more than 30 m from where it was ~45 s+ earlier. (In lost mode points are only 5 s apart,
    // so comparing just the last two points would show a walking thief as "still".)
    const locT = new Date(loc.created_at).getTime();
    // Walk back through the last points (up to 5 min) to find a reference point. Stop at an impossible
    // jump (> 150 km/h: a GPS glitch, or the first fix after being off), so it never shows silly speeds.
    let prev = null;
    const tOf = (r) => new Date(r.created_at).getTime();
    for (let i = 1, ref = loc; i < Math.min(state.recent.length, 80); i++) {
      const p = state.recent[i];
      const dt = (tOf(ref) - tOf(p)) / 1000;
      if (dt <= 0) continue;
      if (distanceM(ref, p) / dt * 3.6 > 150) break;
      if (locT - tOf(p) > 5 * 60000) break;
      prev = p; ref = p;
      if (locT - tOf(p) >= 60000) break;          // a minute back is enough
    }
    const span = prev ? (locT - tOf(prev)) / 1000 : 0;
    const recentEnough = age < (lost ? 30 : CFG.normalIntervalMin * 60 * 2);
    // straight-line distance (not the sum of steps), so GPS jitter while still isn't counted as moving
    const moving = !stale && !!prev && span >= 20 && recentEnough && distanceM(loc, prev) > 30;
    const kmh = moving ? Math.round(distanceM(loc, prev) / span * 3.6) : 0;
    const heading = moving ? bearing(prev, loc) : null;

    // texts
    $('#nosignal-note').hidden = !stale;
    if (stale) {
      $('#nosignal-note').textContent = t('nosignal_text', { t: relTime(age) });
      if (!lost) chip.textContent = t('no_signal');
    }
    const battery = typeof loc.battery === 'number' ? loc.battery : null;
    $('#stat-battery').textContent = battery === null ? '—' : battery + '%';

    if (lost && battery !== null) {
      $('#stat-2-label').textContent = t('time_left');
      $('#stat-updated').textContent = t('hours_left', { n: Math.max(1, Math.round((battery / 100) * CFG.lostBatteryHoursAtFull)) });
    } else {
      $('#stat-2-label').textContent = stale ? t('last_seen') : t('updated');
      $('#stat-updated').textContent = relTime(age);
    }
    // moving with a known speed: label "Moving", big value "19 km/h" (fits the small box)
    const showSpeed = !stale && moving && kmh >= 2;
    $('#stat-3-label').textContent = showSpeed ? t('moving') : t('status');
    $('#stat-status').textContent = stale ? t('unknown') : (showSpeed ? kmh + (state.lang === 'en' ? ' km/h' : (state.lang === 'ar' ? ' كم/س' : ' کم/ک')) : (moving ? t('moving') : t('still')));

    // low battery banner
    const showBanner = battery !== null && battery <= CFG.lowBatteryPercent && state.bannerHiddenFor !== tr.id && state.tab === 'map' && !state.zoneEdit;
    $('#battery-banner').hidden = !showBanner;
    if (showBanner) $('#battery-banner-text').textContent = t('low_battery', { n: battery });

    // which safe zone it's in, and how far it is from you
    const inZone = zoneAt(loc);
    $('#bag-zone').hidden = !inZone;
    if (inZone) $('#bag-zone').innerHTML = kindIcon(inZone.kind) + '<span></span>', $('#bag-zone span').textContent = t('at_zone', { z: inZone.name });
    const fromMe = state.me ? distanceM(state.me, loc) : null;
    $('#bag-distance').textContent = fromMe === null ? '' : ' · ' + (fromMe < 15 ? t('with_you') : t('from_you_dir', { d: fmtDistance(fromMe), dir: t('dir_' + compass(bearing(state.me, loc))) }));
    $('[data-action="directions"]').disabled = false;

    // map layers
    const ll = L.latLng(loc.lat, loc.lng);
    const kind = stale ? 'stale' : (lost ? 'lost' : '');
    if (!map.marker) {
      map.marker = L.marker(ll, { icon: markerIcon(kind), keyboard: false, zIndexOffset: 1000 }).addTo(map.m);
      map.markerKind = kind;
      map.marker.on('click', showBagInfo);   // tap the bag: exact address, coordinates, accuracy
    }
    else {
      moveMarker(map.marker, ll);
      if (map.markerKind !== kind) { map.marker.setIcon(markerIcon(kind)); map.markerKind = kind; } // only rebuild when the look changes
    }

    // arrow around the pin pointing where it's going
    const hEl = map.marker.getElement() && map.marker.getElement().querySelector('.heading');
    if (hEl) { hEl.hidden = heading === null; if (heading !== null) hEl.style.transform = 'rotate(' + Math.round(heading) + 'deg)'; }
    state.bagInfo = { loc, kmh, heading, stale };
    if (map.info && map.m.hasLayer(map.info)) fillBagInfo();

    const accColor = lost ? cssVar('--danger') : cssVar('--accent');
    if (!map.accuracy) map.accuracy = L.circle(ll, { radius: 25, weight: 1.5, dashArray: '4 4', color: accColor, fillColor: accColor, fillOpacity: 0.1, interactive: false }).addTo(map.m);
    else { moveMarker(map.accuracy, ll); map.accuracy.setStyle({ color: accColor, fillColor: accColor }); }
    // real GPS accuracy when the point has it (test mode with phone GPS), otherwise about 25 m
    map.accuracy.setRadius(Math.max(10, Math.min(typeof loc.accuracy === 'number' ? loc.accuracy : 25, 300)));

    if (map.trail) { map.m.removeLayer(map.trail); map.trail = null; }
    if (lost) {
      const since = Date.now() - 30 * 60 * 1000;
      const pts = state.recent.filter((r) => new Date(r.created_at).getTime() >= since).map((r) => [r.lat, r.lng]);
      if (pts.length > 1) map.trail = L.polyline(pts, { color: cssVar('--danger'), weight: 4, dashArray: '2 8', lineCap: 'round', interactive: false }).addTo(map.m);
    }

    drawPath();
    const showBagLayers = state.tab !== 'history' && !state.zoneEdit;
    [map.marker, map.accuracy, map.trail, map.path].forEach((layer) => {
      if (!layer) return;
      if (showBagLayers && !map.m.hasLayer(layer)) layer.addTo(map.m);
      if (!showBagLayers && map.m.hasLayer(layer)) map.m.removeLayer(layer);
    });

    // keep the bag in the free part of the map (above the bottom card)
    if (state.followBag && state.tab === 'map' && !state.zoneEdit) {
      const z = Math.max(map.m.getZoom(), 16);
      const lift = Math.min(($('#sheet').offsetHeight - 60) / 2, 220);
      const p = map.m.project(ll, z).add([0, lift]);
      map.m.setView(map.m.unproject(p, z), z, { animate: true });
    }
    updateCenterBtn();

    updateArea(loc.lat, loc.lng, stale);
  }

  // Area name from OpenStreetMap (cached, rounded so we don't call it too often)
  async function updateArea(lat, lng, stale) {
    const key = state.lang + ':' + lat.toFixed(3) + ',' + lng.toFixed(3);
    const el = $('#bag-area');
    const show = (name) => { el.textContent = name; };
    if (state.areaCache[key]) { show(state.areaCache[key]); return; }
    if (state.areaKey === key) return;
    state.areaKey = key;
    show(t('area_unknown'));
    try {
      const lang = state.lang === 'ckb' ? 'ckb,ku,ar' : state.lang;
      const res = await fetch('https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=16&lat=' + lat + '&lon=' + lng + '&accept-language=' + lang);
      if (!res.ok) return;
      const data = await res.json();
      const a = data.address || {};
      const place = a.neighbourhood || a.suburb || a.quarter || a.road || a.village || '';
      const city = a.city || a.town || a.state || '';
      const name = [place, city].filter(Boolean).join(state.lang === 'en' ? ', ' : '، ') || t('area_unknown');
      state.areaCache[key] = name;
      if (state.areaKey === key) show(name);
    } catch (e) { /* keep the fallback text */ }
  }

  // ---------- lost mode ----------
  function setupHoldButton() {
    const btn = $('#hold-lost');
    let timer = null;
    const start = (e) => {
      if (e.button !== undefined && e.button !== 0) return;
      btn.classList.add('holding');
      timer = setTimeout(() => { stop(); openConfirm(); }, 2000);
    };
    const stop = () => { clearTimeout(timer); timer = null; btn.classList.remove('holding'); };
    btn.addEventListener('pointerdown', start);
    ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => btn.addEventListener(ev, stop));
    btn.addEventListener('contextmenu', (e) => e.preventDefault());
    // keyboard users: Enter / Space opens the confirmation directly
    btn.addEventListener('click', (e) => { if (e.detail === 0) openConfirm(); });
  }

  function openConfirm() { $('#confirm-lost').hidden = false; $('[data-action="confirm-lost"]').focus(); }
  function closeConfirm() { $('#confirm-lost').hidden = true; }

  async function setMode(mode) {
    const { error } = await sb.rpc('set_tracker_mode', { p_tracker: state.tracker.id, p_mode: mode });
    if (error) { toast(errorText(error)); return false; }
    state.tracker.mode = mode;
    state.followBag = true;
    renderMapPanel();
    return true;
  }

  async function shareLocation() {
    const loc = state.recent[0];
    if (!loc) return;
    const url = 'https://maps.google.com/?q=' + loc.lat.toFixed(6) + ',' + loc.lng.toFixed(6);
    try {
      if (navigator.share) { await navigator.share({ title: 'Trackly', text: t('share_text'), url }); return; }
      await navigator.clipboard.writeText(url);
      toast(t('toast_link_copied'));
    } catch (e) { /* user closed the share sheet */ }
  }

  // ---------- tabs ----------
  function switchTab(tab) {
    state.tab = tab;
    $$('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    $('#panel-map').hidden = tab !== 'map';
    $('#panel-history').hidden = tab !== 'history';
    $('#panel-zones').hidden = tab !== 'zones';
    $('#panel-account').hidden = tab !== 'account';
    $('#history-days').hidden = tab !== 'history';

    if (map.history) { map.m.removeLayer(map.history); map.history = null; }
    map.zones.clearLayers();
    map.m.closePopup();
    stopReplay();
    $('#style-picker').hidden = true;

    if (tab === 'history') loadHistory();
    if (tab === 'zones') drawZones(true);
    if (tab === 'map') { state.followBag = true; drawZones(false); }
    $('#map-controls').hidden = tab === 'history' || tab === 'account';
    renderMapPanel();
  }

  // ---------- history ----------
  function historyRange() {
    let start;
    if (state.historyDate) {
      const [y, m, d] = state.historyDate.split('-').map(Number);
      start = new Date(y, m - 1, d);
    } else {
      start = new Date();
      start.setHours(0, 0, 0, 0);
      start.setDate(start.getDate() - state.historyDay);
    }
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    return [start, end];
  }

  async function loadHistory() {
    if (!state.tracker) return;
    const [start, end] = historyRange();
    const { data, error } = await sb.from('locations')
      .select('lat, lng, battery, created_at')
      .eq('tracker_id', state.tracker.id)
      .gte('created_at', start.toISOString())
      .lt('created_at', end.toISOString())
      .order('created_at', { ascending: true })
      .limit(3000);
    if (state.tab !== 'history') return;
    if (map.history) { map.m.removeLayer(map.history); map.history = null; }
    const list = $('#timeline');
    list.innerHTML = '';
    if (error) { toast(errorText(error)); return; }
    const pts = data || [];
    state.historyPts = pts;
    stopReplay();
    $('#replay').hidden = pts.length < 2;
    if (!pts.length) {
      $('#history-summary').textContent = t('history_empty');
      return;
    }

    let meters = 0;
    for (let i = 1; i < pts.length; i++) meters += distanceM(pts[i - 1], pts[i]);
    $('#history-summary').textContent = t('history_summary', { n: pts.length, km: (meters / 1000).toFixed(1) });

    const accent = cssVar('--accent');
    const group = L.layerGroup();
    const line = L.polyline(pts.map((p) => [p.lat, p.lng]), { color: accent, weight: 4, lineJoin: 'round' }).addTo(group);
    L.circleMarker([pts[0].lat, pts[0].lng], { radius: 7, color: accent, weight: 3, fillColor: cssVar('--bg'), fillOpacity: 1 }).addTo(group);
    L.circleMarker([pts[pts.length - 1].lat, pts[pts.length - 1].lng], { radius: 9, color: cssVar('--bg'), weight: 3, fillColor: cssVar('--primary'), fillOpacity: 1 }).addTo(group);
    // replay dot: drag the slider (or press play) to see where the bag was at each moment
    map.replayDot = L.circleMarker([pts[0].lat, pts[0].lng], { radius: 9, color: '#FFFFFF', weight: 3, fillColor: cssVar('--danger'), fillOpacity: 1, interactive: false }).addTo(group);
    map.history = group.addTo(map.m);
    const range = $('#replay-range');
    range.max = pts.length - 1; range.value = 0;
    setReplay(0);
    // leave room for the top bar and the bottom card, so the whole route stays visible
    const sheetH = $('#sheet') ? $('#sheet').getBoundingClientRect().height : 0;
    map.m.fitBounds(line.getBounds(), { paddingTopLeft: [32, 140], paddingBottomRight: [32, sheetH + 24], maxZoom: 16 });

    // timeline: first point, safe-zone changes, last point
    const events = [{ time: pts[0].created_at, title: t('started'), sub: '' }];
    const zones = state.zones;
    let inside = zones.map((z) => distanceM(pts[0], z) <= z.radius_m);
    for (let i = 1; i < pts.length; i++) {
      zones.forEach((z, zi) => {
        const now = distanceM(pts[i], z) <= z.radius_m;
        if (now !== inside[zi]) {
          events.push({ time: pts[i].created_at, title: now ? t('arrived_zone', { z: z.name }) : t('left_zone', { z: z.name }), sub: '' });
          inside[zi] = now;
        }
      });
    }
    const last = pts[pts.length - 1];
    if (pts.length > 1) events.push({ time: last.created_at, title: t('last_point'), sub: typeof last.battery === 'number' ? t('battery') + ' ' + last.battery + '%' : '' });

    events.forEach((ev) => {
      const li = document.createElement('li');
      const time = document.createElement('time');
      time.textContent = clockTime(ev.time);
      const box = document.createElement('div');
      const strong = document.createElement('strong');
      strong.textContent = ev.title;
      box.appendChild(strong);
      if (ev.sub) { const span = document.createElement('span'); span.textContent = ev.sub; box.appendChild(span); }
      li.append(time, box);
      list.appendChild(li);
    });
  }

  // ---------- history replay ----------
  let replayTimer = null;
  function setReplay(i) {
    const pts = state.historyPts;
    if (!pts.length || !map.replayDot) return;
    const p = pts[Math.max(0, Math.min(pts.length - 1, i))];
    map.replayDot.setLatLng([p.lat, p.lng]);
    $('#replay-time').textContent = clockTime(p.created_at) + (typeof p.battery === 'number' ? ' · ' + p.battery + '%' : '');
  }
  function stopReplay() {
    clearInterval(replayTimer); replayTimer = null;
    if ($('#replay-play')) $('#replay-play').classList.remove('playing');
  }
  function toggleReplay() {
    if (replayTimer) { stopReplay(); return; }
    const range = $('#replay-range');
    if (Number(range.value) >= Number(range.max)) range.value = 0;
    // the whole day plays in about 12 seconds
    const stepBy = Math.max(1, Math.round(state.historyPts.length / 150));
    $('#replay-play').classList.add('playing');
    replayTimer = setInterval(() => {
      const v = Math.min(Number(range.max), Number(range.value) + stepBy);
      range.value = v; setReplay(v);
      const p = state.historyPts[v];
      if (p && !map.m.getBounds().pad(-0.15).contains([p.lat, p.lng])) map.m.panTo([p.lat, p.lng], { animate: true });
      if (v >= Number(range.max)) stopReplay();
    }, 80);
  }

  // ---------- safe zones ----------
  function zoneMeta(z) {
    const n = !z.enabled ? t('alerts_off') : t('notify_' + z.notify_on);
    return t('zone_meta', { r: fmtDistance(z.radius_m), n });
  }

  function renderZones() {
    const list = $('#zone-list');
    list.innerHTML = '';
    if (!state.zones.length) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = t('no_zones');
      list.appendChild(li);
    }
    state.zones.forEach((z) => {
      const li = document.createElement('li');
      li.className = 'zone-item' + (z.enabled ? '' : ' off');

      // tap the zone to edit it (move, resize, rename)
      const info = document.createElement('button');
      info.type = 'button';
      info.className = 'info';
      info.setAttribute('aria-label', t('edit_zone') + ': ' + z.name);
      const icon = document.createElement('span');
      icon.className = 'zone-icon';
      icon.innerHTML = kindIcon(z.kind);
      const text = document.createElement('span');
      text.className = 'zone-text';
      const strong = document.createElement('strong');
      strong.textContent = z.name;
      const span = document.createElement('span');
      span.textContent = zoneMeta(z);
      text.append(strong, span);
      info.append(icon, text);
      info.addEventListener('click', () => startZoneEdit(z));

      const sw = document.createElement('button');
      sw.type = 'button';
      sw.className = 'switch';
      sw.setAttribute('role', 'switch');
      sw.setAttribute('aria-checked', String(z.enabled));
      sw.setAttribute('aria-label', z.name);
      sw.addEventListener('click', () => toggleZone(z));

      li.append(info, sw);
      list.appendChild(li);
    });
    if ((state.tab === 'zones' || state.tab === 'map') && !state.zoneEdit) drawZones(false);
  }

  function drawZones(fit) {
    map.zones.clearLayers();
    const accent = cssVar('--accent');
    state.zones.forEach((z) => {
      L.circle([z.lat, z.lng], {
        radius: z.radius_m, color: accent, weight: 1.5, dashArray: z.enabled ? null : '4 6',
        fillColor: accent, fillOpacity: z.enabled ? 0.1 : 0.03, interactive: false
      }).addTo(map.zones);
      // small icon + name in the middle of each zone
      // label on the top edge of the circle, so it never covers the bag in the middle
      L.marker([z.lat + z.radius_m / 111320, z.lng], {
        interactive: state.tab === 'zones', keyboard: false,
        icon: L.divIcon({ className: '', html: '<div class="zone-tag' + (z.enabled ? '' : ' off') + '">' + kindIcon(z.kind) + '<span></span></div>', iconSize: null, iconAnchor: [0, 0] })
      }).on('add', function () { const el = this.getElement(); el.querySelector('span').textContent = z.name; })
        .on('click', () => { if (state.tab === 'zones') startZoneEdit(z); })
        .addTo(map.zones);
    });
    if (fit && state.zones.length) {
      const b = L.latLngBounds([]);
      state.zones.forEach((z) => b.extend(L.latLng(z.lat, z.lng).toBounds(z.radius_m * 2)));
      map.m.fitBounds(b, { paddingTopLeft: [32, 120], paddingBottomRight: [32, $('#sheet').offsetHeight + 24], maxZoom: 16 });
    }
  }

  async function toggleZone(z) {
    const { error } = await sb.from('safe_zones').update({ enabled: !z.enabled }).eq('id', z.id);
    if (error) { toast(errorText(error)); return; }
    z.enabled = !z.enabled;
    renderZones();
  }

  async function deleteZone(z, fromEditor) {
    if (!z || !window.confirm(t('delete_zone_q', { n: z.name }))) return;
    const { error } = await sb.from('safe_zones').delete().eq('id', z.id);
    if (error) { toast(errorText(error)); return; }
    state.zones = state.zones.filter((x) => x.id !== z.id);
    if (fromEditor) endZoneEdit();
    renderZones();
    toast(t('toast_zone_deleted'));
  }

  // ---- zone editor: new zone, or edit an existing one (z) ----
  function setKind(kind) {
    const old = state.zoneEdit.kind;
    state.zoneEdit.kind = kind;
    $$('#zone-kinds .kind').forEach((b) => b.classList.toggle('active', b.dataset.kind === kind));
    // fill the name with the type ("Home"), unless the user already typed their own name
    const name = $('#zone-name');
    if (!name.value.trim() || name.value.trim() === t('kind_' + old)) name.value = kind === 'other' ? '' : t('kind_' + kind);
    $('#zone-pin').innerHTML = kindIcon(kind);
  }

  function setRadius(r) {
    $('#zone-radius').value = r;
    $('#zone-radius-value').textContent = fmtDistance(r);
    if (map.editCircle) map.editCircle.setRadius(r);
  }

  function startZoneEdit(z) {
    state.zoneEdit = { id: z ? z.id : null, notify: z ? z.notify_on : 'leave', kind: (z && z.kind) || 'home' };
    $('#panel-zones').hidden = true;
    $('#panel-zone-edit').hidden = false;
    $('#sheet').classList.add('editing');
    $('#sheet').scrollTop = 0;
    $('.tabbar').hidden = true;
    $('#map-controls').hidden = true;
    $('#zone-hint').hidden = false;
    $('#zone-pin').hidden = false;
    $('#zone-search-bar').hidden = false;
    $('#battery-banner').hidden = true;
    $('#zone-error').textContent = '';
    $('#panel-zone-edit').reset();
    $('#zone-results').hidden = true;
    $('#zone-edit-title').textContent = z ? t('edit_zone') : t('new_zone');
    $('#zone-save').textContent = z ? t('save_changes') : t('save_zone');
    $('#zone-delete').hidden = !z;
    $('#zone-name').value = z ? z.name : '';
    setKind(state.zoneEdit.kind);
    if (z) $('#zone-name').value = z.name;
    $$('#zone-notify .seg').forEach((b) => b.classList.toggle('active', b.dataset.notify === state.zoneEdit.notify));
    map.zones.clearLayers();
    renderMapPanel();

    // start at the zone itself, or at the bag's location
    const loc = state.recent[0];
    const start = z ? [z.lat, z.lng] : (loc ? [loc.lat, loc.lng] : null);
    if (start) map.m.setView(start, z && z.radius_m > 400 ? 15 : 16, { animate: false });
    const color = cssVar('--accent');
    map.editCircle = L.circle(map.m.getCenter(), { radius: 200, color, weight: 2, dashArray: '6 6', fillColor: color, fillOpacity: 0.12, interactive: false }).addTo(map.m);
    setRadius(z ? z.radius_m : 200);
    positionPin();
  }

  // keep the pin visible above the bottom sheet, and move the map center to match
  function positionPin() {
    const sheetTop = $('#sheet').getBoundingClientRect().top;
    const topSafe = 150;
    const y = Math.max(topSafe + 40, (topSafe + sheetTop) / 2);
    document.documentElement.style.setProperty('--pin-y', y + 'px');
    const mapH = $('#map').clientHeight;
    const offset = y - mapH / 2; // pixels between visual pin and real map center
    map.pinOffset = offset;
    map.m.panBy([0, -offset], { animate: false });
    syncEditCircle();
  }

  function pinLatLng() {
    const size = map.m.getSize();
    const point = L.point(size.x / 2, size.y / 2 + (map.pinOffset || 0));
    return map.m.containerPointToLatLng(point);
  }

  // Move the map so the pin sits on this spot (used by tap on map, search, My location, Bag's location)
  function placePinAt(latlng) {
    const size = map.m.getSize();
    const pinPoint = L.point(size.x / 2, size.y / 2 + (map.pinOffset || 0));
    map.m.panBy(map.m.latLngToContainerPoint(latlng).subtract(pinPoint), { animate: true, duration: 0.35 });
  }

  function endZoneEdit() {
    state.zoneEdit = null;
    if (map.editCircle) { map.m.removeLayer(map.editCircle); map.editCircle = null; }
    map.pinOffset = 0;
    $('#panel-zone-edit').hidden = true;
    $('#sheet').classList.remove('editing');
    $('.tabbar').hidden = false;
    $('#zone-hint').hidden = true;
    $('#zone-pin').hidden = true;
    $('#zone-search-bar').hidden = true;
    $('#zone-results').hidden = true;
    switchTab('zones');
  }

  async function saveZone(e) {
    e.preventDefault();
    const name = $('#zone-name').value.trim();
    if (!name) { $('#zone-error').textContent = t('err_zone_name'); $('#zone-name').focus(); return; }
    const c = pinLatLng();
    const values = {
      name: name.slice(0, 40),
      kind: state.zoneEdit.kind,
      lat: +c.lat.toFixed(6),
      lng: +c.lng.toFixed(6),
      radius_m: Number($('#zone-radius').value),
      notify_on: state.zoneEdit.notify
    };
    const btn = $('#zone-save');
    btn.disabled = true;
    const editingId = state.zoneEdit.id;
    const res = editingId
      ? await sb.from('safe_zones').update(values).eq('id', editingId).select()
      : await sb.from('safe_zones').insert(Object.assign({ tracker_id: state.tracker.id }, values)).select().single();
    btn.disabled = false;
    if (res.error) { $('#zone-error').textContent = errorText(res.error); return; }
    if (editingId) Object.assign(state.zones.find((z) => z.id === editingId), values);
    else state.zones.push(res.data);
    endZoneEdit();
    renderZones();
    toast(editingId ? t('toast_zone_updated') : t('toast_zone_saved'));
  }

  // Search a place by name (OpenStreetMap / Nominatim), nearest to Erbil first
  let searchTimer = null, searchSeq = 0;
  function onZoneSearch(e) {
    clearTimeout(searchTimer);
    const q = e.target.value.trim();
    const box = $('#zone-results');
    if (q.length < 3) { box.hidden = true; return; }
    searchTimer = setTimeout(async () => {
      const seq = ++searchSeq;
      const c = map.m.getCenter();
      const lang = state.lang === 'ckb' ? 'ckb,ku,ar,en' : state.lang + ',en';
      const url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&countrycodes=iq&accept-language=' + lang +
        '&viewbox=' + [c.lng - 0.4, c.lat + 0.3, c.lng + 0.4, c.lat - 0.3].join(',') + '&q=' + encodeURIComponent(q);
      let rows = [];
      try { const r = await fetch(url); if (r.ok) rows = await r.json(); } catch (err) { /* offline */ }
      if (seq !== searchSeq) return; // a newer search is running
      box.innerHTML = '';
      if (!rows.length) {
        const li = document.createElement('li');
        li.className = 'empty';
        li.textContent = t('no_results');
        box.appendChild(li);
      }
      rows.forEach((row) => {
        const li = document.createElement('li');
        const b = document.createElement('button');
        b.type = 'button';
        const parts = String(row.display_name || '').split(',');
        const strong = document.createElement('strong');
        strong.textContent = parts[0];
        const span = document.createElement('span');
        span.textContent = parts.slice(1, 3).join(',').trim();
        b.append(strong, span);
        b.addEventListener('click', () => {
          box.hidden = true;
          $('#zone-search').value = parts[0];
          $('#zone-search').blur();
          map.m.setView([+row.lat, +row.lon], 16, { animate: false });
          map.m.panBy([0, -(map.pinOffset || 0)], { animate: false });
          syncEditCircle();
        });
        li.appendChild(b);
        box.appendChild(li);
      });
      box.hidden = false;
    }, 450); // wait until the user stops typing (Nominatim allows ~1 request per second)
  }

  // the edit circle follows the visual pin, not the map's real center
  function syncEditCircle() {
    if (state.zoneEdit && map.editCircle) map.editCircle.setLatLng(pinLatLng());
  }

  // ---------- events ----------
  function bindEvents() {
    document.addEventListener('click', async (e) => {
      const el = e.target.closest('[data-action]');
      if (!el) return;
      const a = el.dataset.action;
      if (a === 'lang') cycleLang();
      else if (a === 'logout') logout();
      else if (a === 'pair-back') openApp();
      else if (a === 'allow-notif') allowNotifications();
      else if (a === 'setup-done') finishSetup();
      else if (a === 'hide-banner') { state.bannerHiddenFor = state.tracker && state.tracker.id; $('#battery-banner').hidden = true; }
      else if (a === 'find-nearby') toast(t('toast_nearby_soon'));
      else if (a === 'confirm-lost') { closeConfirm(); if (await setMode('lost')) toast(t('toast_lost_on')); }
      else if (a === 'cancel-lost') closeConfirm();
      else if (a === 'found') { if (await setMode('normal')) toast(t('toast_found')); }
      else if (a === 'share') shareLocation();
      else if (a === 'add-zone') startZoneEdit();
      else if (a === 'cancel-zone') endZoneEdit();
      else if (a === 'add-tracker') { $('[data-action="pair-back"]').hidden = false; renderSavedTrackers(); showView('view-pair'); }
      else if (a === 'center-bag') centerOnBag();
      else if (a === 'locate-me') locateMe(true);
      else if (a === 'map-style') toggleMapStyle();
      else if (a === 'pick-style') pickStyle(el.dataset.style);
      else if (a === 'toggle-path') togglePath();
      else if (a === 'replay') toggleReplay();
      else if (a === 'directions') openDirections();
      else if (a === 'zone-me') locateMe(false, true);
      else if (a === 'zone-bag') { const l = state.recent[0]; if (l) placePinAt(L.latLng(l.lat, l.lng)); }
      else if (a === 'delete-zone') { if (state.zoneEdit && state.zoneEdit.id) deleteZone(state.zones.find((z) => z.id === state.zoneEdit.id), true); }
      else if (a === 'show-setup') showView('view-setup');
    });

    $$('[data-auth-tab]').forEach((b) => b.addEventListener('click', () => {
      state.authMode = b.dataset.authTab;
      $$('[data-auth-tab]').forEach((x) => x.classList.toggle('active', x === b));
      $('#auth-error').textContent = '';
      updateAuthButton();
    }));
    $('#auth-form').addEventListener('submit', onAuthSubmit);
    $('#pair-form').addEventListener('submit', onPairSubmit);

    $$('[data-os]').forEach((b) => b.addEventListener('click', () => {
      $$('[data-os]').forEach((x) => x.classList.toggle('active', x === b));
      $('#steps-ios').hidden = b.dataset.os !== 'ios';
      $('#steps-android').hidden = b.dataset.os !== 'android';
    }));

    $$('.tab').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));
    $('#tracker-select').addEventListener('change', (e) => selectTracker(e.target.value));

    $$('#history-days [data-day]').forEach((b) => b.addEventListener('click', () => {
      state.historyDay = Number(b.dataset.day);
      state.historyDate = null;
      $('#history-date').value = '';
      $$('#history-days .chip').forEach((x) => x.classList.toggle('active', x === b));
      loadHistory();
    }));
    $('#history-date').addEventListener('change', (e) => {
      if (!e.target.value) return;
      state.historyDate = e.target.value;
      $$('#history-days .chip').forEach((x) => x.classList.toggle('active', x.classList.contains('chip-date')));
      loadHistory();
    });

    $('#zone-radius').addEventListener('input', (e) => setRadius(Number(e.target.value)));
    $('#replay-range').addEventListener('input', (e) => { stopReplay(); setReplay(Number(e.target.value)); });
    $$('#zone-kinds .kind').forEach((b) => b.addEventListener('click', () => setKind(b.dataset.kind)));
    $('#zone-search').addEventListener('input', onZoneSearch);
    $('#zone-search').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.preventDefault(); });
    $$('#zone-notify .seg').forEach((b) => b.addEventListener('click', () => {
      state.zoneEdit.notify = b.dataset.notify;
      $$('#zone-notify .seg').forEach((x) => x.classList.toggle('active', x === b));
    }));
    $('#panel-zone-edit').addEventListener('submit', saveZone);

    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#confirm-lost').hidden) closeConfirm(); });

    setupHoldButton();

    // keep "updated X min ago" fresh
    setInterval(() => { if (state.tab === 'map' && !document.hidden) renderMapPanel(); }, 15000);

    sb.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_OUT') { unsubscribe(); showView('view-auth'); }
    });
  }

  // ---------- start ----------
  function start() {
    $$('[data-kind-icon]').forEach((el) => { el.innerHTML = kindIcon(el.dataset.kindIcon); });
    bindEvents();
    applyLang();
    // remembered email: only the password is left to type (or the phone fills it in)
    const lastEmail = localStorage.getItem('trackly-last-email');
    if (lastEmail) $('#auth-email').value = lastEmail;
    initMap();
    map.m.on('move', syncEditCircle);
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
    route().catch(() => { showView('view-auth'); toast(t('err_generic')); });
  }

  start();
})();
