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
    mapStyle: (() => { const v = localStorage.getItem('trackly-map-style'); return ['clean', 'detailed', 'sat', 'hybrid'].includes(v) ? v : (v === 'sat' ? 'sat' : 'detailed'); })(),
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
    if (msg.includes('too_many')) return t('err_too_many');
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
    if (map.m) { renderPlacesBar(); renderPlaces(); renderAlerts(); }
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
    $('#terms-row').hidden = state.authMode !== 'signup';
    $('[data-action="forgot"]').hidden = state.authMode !== 'login';
  }

  async function onAuthSubmit(e) {
    e.preventDefault();
    const email = $('#auth-email').value.trim();
    const password = $('#auth-password').value;
    const err = $('#auth-error');
    err.textContent = '';
    if (!email || password.length < 6) { err.textContent = t('err_fill'); return; }
    if (state.authMode === 'signup' && !$('#terms-check').checked) { err.textContent = t('err_terms'); return; }
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
    if (sessionStorage.getItem('trackly-pending-join')) { await applyPendingJoin(); return; }
    if (!state.trackers.length) { renderSavedTrackers(); applyPendingPair(); showView('view-pair'); $('[data-action="pair-back"]').hidden = true; return; }
    if (!localStorage.getItem('trackly-setup-done')) { showView('view-setup'); return; }
    openApp();
  }

  async function loadTrackers() {
    const { data, error } = await sb.from('trackers').select(CFG.fakeBackend ? '*' : 'id, device_code, owner_id, name, mode, color, parked_at, parked_lat, parked_lng, parked_alerted').order('created_at');
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
    renderBags();
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
      if (!data) throw new Error('invalid_code');
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
    renderPlacesBar();
    let placesTimer = null;
    map.m.on('moveend zoomend', () => { clearTimeout(placesTimer); placesTimer = setTimeout(loadPlaces, 400); });
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
      renderFind();
      checkLeftBehind();
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
    if ($('#btn-path')) $('#btn-path').setAttribute('aria-checked', String(state.showPath));
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
        const before = state.recent[0];
        state.recent.unshift(payload.new);
        if (state.recent.length > 200) state.recent.length = 200;
        checkAlerts(before, payload.new);
        renderMapPanel();
        renderFind();
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'trackers', filter: 'id=eq.' + id }, (payload) => {
        Object.assign(state.tracker, { mode: payload.new.mode, name: payload.new.name });
        renderMapPanel();
      })
      .subscribe();

    renderMapPanel();
    renderZones();
    if (state.tab === 'history') loadHistory();
    estimateBattery();
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
    $('#lost-report').hidden = !lost;

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
    $('#stat-battery-sub').textContent = lost ? '' : batteryLeftText(battery, false);
    $('#stat-battery').parentElement.classList.toggle('low', battery !== null && battery <= CFG.lowBatteryPercent);
    $('#pill-dot').style.background = bagColor(tr);

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
    updateNear(loc);
    renderParked();
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
    if (tab === 'account') { renderAlerts(); renderBags(); renderPushSwitch(); }
    renderPlaces();
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

    const stops = findStops(pts);
    stops.forEach((s, k) => {
      events.push({ time: s.from, title: t('stop'), sub: fmtDuration(s.mins) + ' · ' + clockTime(s.from) + '–' + clockTime(s.to), stop: s, n: k + 1 });
      L.marker([s.lat, s.lng], { interactive: false, keyboard: false, icon: L.divIcon({ className: '', iconSize: [26, 26], iconAnchor: [13, 13], html: '<div class="stop-pin">' + (k + 1) + '</div>' }) }).addTo(group);
    });
    events.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
    if (stops.length) $('#history-summary').textContent += ' · ' + t('stops_n', { n: stops.length });
    events.forEach((ev) => {
      const li = document.createElement('li');
      if (ev.stop) { li.className = 'is-stop'; li.dataset.n = ev.n; }
      const time = document.createElement('time');
      time.textContent = clockTime(ev.time);
      const box = document.createElement('div');
      const strong = document.createElement('strong');
      strong.textContent = ev.title;
      box.appendChild(strong);
      if (ev.sub) { const span = document.createElement('span'); span.textContent = ev.sub; box.appendChild(span); }
      if (ev.stop) stopName(ev.stop).then((nm) => { strong.textContent = ev.n + '. ' + nm; });
      if (ev.stop) li.addEventListener('click', () => map.m.setView([ev.stop.lat, ev.stop.lng], 17));
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

  // =====================================================================
  // PLACES — shops, restaurants, pharmacies, banks… from OpenStreetMap (free).
  // Loaded for the part of the map you're looking at (zoom 15+), cached in ~1 km squares.
  // =====================================================================
  const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter'];
  const PLACE_GROUPS = {
    food: { color: '#F97316', icon: 'M7 3v7a2 2 0 0 0 2 2v9M5 3v5a2 2 0 0 0 4 0V3M17 21V3c-2 1-3 3-3 6v5h3' },
    shop: { color: '#8B5CF6', icon: 'M6 8h12l1 12H5L6 8zM9 8V6a3 3 0 0 1 6 0v2' },
    health: { color: '#EC4899', icon: 'M12 5v14M5 12h14' },
    money: { color: '#0284C7', icon: 'M3 7h18v10H3zM12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z' },
    fuel: { color: '#475569', icon: 'M5 20V5a1 1 0 0 1 1-1h7a1 1 0 0 1 1 1v15M4 20h11M14 9h2l2 2v6a1.5 1.5 0 0 0 3 0V8l-3-3M7 8h5' },
    worship: { color: '#65A30D', icon: 'M12 3c-3 2-5 4-5 7h10c0-3-2-5-5-7zM6 10v10h12V10M10 20v-4a2 2 0 0 1 4 0v4' },
    edu: { color: '#CA8A04', icon: 'M2 9l10-5 10 5-10 5zM6 11v5c3 2 9 2 12 0v-5' },
    hotel: { color: '#6366F1', icon: 'M3 18V7M3 14h18v4M21 14v-2a3 3 0 0 0-3-3h-7v5M7 10a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3z' },
    park: { color: '#16A34A', icon: 'M12 3l5 7h-3l4 6H6l4-6H7zM12 16v5' },
    other: { color: '#64748B', icon: 'M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21zM12 7.5a2 2 0 1 0 0 4 2 2 0 0 0 0-4z' }
  };
  const placeIcon = (g) => '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="' + PLACE_GROUPS[g].icon + '"/></svg>';
  function placeGroup(tags) {
    const a = tags.amenity, tt = tags.tourism, l = tags.leisure;
    if (/^(restaurant|cafe|fast_food|ice_cream|food_court|bar)$/.test(a)) return 'food';
    if (tags.shop) return 'shop';
    if (/^(pharmacy|hospital|clinic|doctors|dentist)$/.test(a)) return 'health';
    if (/^(bank|atm|bureau_de_change)$/.test(a)) return 'money';
    if (a === 'fuel') return 'fuel';
    if (a === 'place_of_worship') return 'worship';
    if (/^(school|university|college|kindergarten)$/.test(a)) return 'edu';
    if (/^(hotel|guest_house|hostel)$/.test(tt)) return 'hotel';
    if (/^(park|garden)$/.test(l)) return 'park';
    return 'other';
  }
  // the name in the app's language when OpenStreetMap has it
  function placeName(tags) {
    const keys = state.lang === 'ckb' ? ['name:ckb', 'name:ku'] : (state.lang === 'ar' ? ['name:ar'] : ['name:en']);
    for (const k of keys) if (tags[k]) return tags[k];
    return tags.name || '';
  }
  // The places servers allow ~2 requests at a time per phone, so requests wait in line (one at a time),
  // and a failed one is tried again once after 3 s.
  let ovpLine = Promise.resolve();
  function overpass(query) {
    const job = ovpLine.then(async () => (await overpassOnce(query)) || (await new Promise((r) => setTimeout(r, 3000)), await overpassOnce(query)));
    ovpLine = job.catch(() => null);
    return job;
  }
  async function overpassOnce(query) {
    for (const url of OVERPASS) {
      // give each server 12 s, then try the next one
      const ctrl = window.AbortController ? new AbortController() : null;
      const timer = ctrl && setTimeout(() => ctrl.abort(), 12000);
      try {
        const r = await fetch(url + '?data=' + encodeURIComponent(query), ctrl ? { signal: ctrl.signal } : {});
        if (r.ok) return (await r.json()).elements || [];
      } catch (e) { /* try the next server */ } finally { clearTimeout(timer); }
    }
    return null;
  }
  const PLACE_FILTER = '["name"]["amenity"~"^(restaurant|cafe|fast_food|ice_cream|food_court|pharmacy|hospital|clinic|doctors|dentist|bank|atm|bureau_de_change|fuel|place_of_worship|school|university|college|kindergarten|police|post_office|cinema|marketplace)$"]';
  function placesQuery(area, limit) {
    return '[out:json][timeout:20];(' +
      'nwr' + PLACE_FILTER + area + ';' +
      'nwr["name"]["shop"]' + area + ';' +
      'nwr["name"]["tourism"~"^(hotel|guest_house|hostel|attraction|museum|viewpoint)$"]' + area + ';' +
      'nwr["name"]["leisure"~"^(park|garden|stadium|sports_centre|fitness_centre)$"]' + area + ';' +
      ');out center ' + limit + ';';
  }
  const places = { all: new Map(), cells: new Set(), loading: false, on: localStorage.getItem('trackly-places') !== '0', filter: new Set(Object.keys(PLACE_GROUPS).filter((g) => g !== 'other')) };
  function toPlace(el) {
    const lat = el.lat ?? (el.center && el.center.lat), lng = el.lon ?? (el.center && el.center.lon);
    if (lat == null || !el.tags) return null;
    return { id: el.type + el.id, lat, lng, tags: el.tags, group: placeGroup(el.tags) };
  }

  // Fast path: the vector map (OpenFreeMap) already carries shops, cafés, pharmacies… for the tiles on screen.
  // Reading them from there is instant and needs no extra server. Satellite view falls back to Overpass.
  function vectorGroup(cls, sub) {
    const s = sub || '', c = cls || '';
    if (/^(restaurant|fast_food|cafe|bar|ice_cream|food_court|pub|beer)$/.test(c) || /^(restaurant|fast_food|cafe|ice_cream|food_court)$/.test(s)) return 'food';
    if (/^(pharmacy|hospital|clinic|doctors|dentist)$/.test(c) || /^(pharmacy|hospital|clinic|doctors|dentist)$/.test(s)) return 'health';
    if (/^(bank|atm|bureau_de_change)$/.test(s) || c === 'bank') return 'money';
    if (c === 'fuel' || s === 'fuel') return 'fuel';
    if (c === 'place_of_worship' || s === 'place_of_worship' || /^(mosque|church)$/.test(s)) return 'worship';
    if (/^(school|college|university|kindergarten)$/.test(c) || /^(school|college|university|kindergarten)$/.test(s)) return 'edu';
    if (c === 'lodging' || /^(hotel|guest_house|hostel)$/.test(s)) return 'hotel';
    if (/^(park|garden)$/.test(c) || /^(park|garden)$/.test(s)) return 'park';
    if (c === 'shop' || /_store$|_shop$/.test(c) || /^(grocery|bakery|mall|supermarket|clothes|convenience|electronics|mobile_phone|jewelry|shoes|butcher|greengrocer|department_store)$/.test(c + '|' + s) || c === 'grocery') return 'shop';
    return 'other';
  }
  function harvestVectorPlaces() {
    const gl = map.tiles && map.tiles.getMaplibreMap && map.tiles.getMaplibreMap();
    if (!gl || !gl.isStyleLoaded || !gl.getSource('openmaptiles')) return 0;
    let n = 0;
    let feats = [];
    try { feats = gl.querySourceFeatures('openmaptiles', { sourceLayer: 'poi' }); } catch (e) { return 0; }
    for (const f of feats) {
      const p = f.properties || {};
      if (!p.name || !f.geometry || f.geometry.type !== 'Point') continue;
      const [lng, lat] = f.geometry.coordinates;
      const id = 'v' + (f.id != null ? f.id : p.name + lat.toFixed(5) + lng.toFixed(5));
      if (places.all.has(id)) continue;
      const tags = { name: p.name, 'name:en': p.name_en || p['name:en'], 'name:ar': p['name:ar'], 'name:ckb': p['name:ckb'] || p['name:ku'], kind: p.subclass || p.class };
      places.all.set(id, { id, lat, lng, tags, group: vectorGroup(p.class, p.subclass) });
      n++;
    }
    return n;
  }

  async function loadPlaces() {
    if (!places.on || !map.m || state.tab === 'history' || state.zoneEdit) return;
    if (map.m.getZoom() < 15) { renderPlaces(); return; }
    const gl = map.tiles && map.tiles.getMaplibreMap && map.tiles.getMaplibreMap();
    if (gl) {
      // vector map: read places when its tiles have loaded (and again after each move)
      if (!gl._tracklyHooked) { gl._tracklyHooked = true; gl.on('idle', () => { if (harvestVectorPlaces()) { renderPlaces(); if (state.recent[0]) updateNear(state.recent[0]); } }); }
      harvestVectorPlaces();
      renderPlaces();
      return;
    }
    // which ~1 km squares are on screen and not loaded yet
    const b = map.m.getBounds().pad(0.2), C = 0.01;
    const need = [];
    for (let la = Math.floor(b.getSouth() / C); la <= Math.floor(b.getNorth() / C); la++)
      for (let ln = Math.floor(b.getWest() / C); ln <= Math.floor(b.getEast() / C); ln++)
        if (!places.cells.has(la + ':' + ln)) need.push([la, ln]);
    if (!need.length || places.loading) { renderPlaces(); return; }
    if (need.length > 16) { renderPlaces(); return; } // zoomed out too far for one request
    places.loading = true;
    $('#btn-places').classList.add('loading');
    const s = Math.min(...need.map((c) => c[0])) * C, w = Math.min(...need.map((c) => c[1])) * C;
    const n = (Math.max(...need.map((c) => c[0])) + 1) * C, e = (Math.max(...need.map((c) => c[1])) + 1) * C;
    const els = await overpass(placesQuery('(' + [s, w, n, e].map((x) => x.toFixed(4)).join(',') + ')', 1500));
    places.loading = false;
    $('#btn-places').classList.remove('loading');
    if (els) {
      need.forEach((c) => places.cells.add(c[0] + ':' + c[1]));
      els.forEach((el) => { const p = toPlace(el); if (p) places.all.set(p.id, p); });
    }
    renderPlaces();
    if (state.recent[0]) updateNear(state.recent[0]);
    if (els) loadPlaces(); // the map may have moved while loading
  }

  function renderPlaces() {
    if (!map.places) map.places = L.layerGroup().addTo(map.m);
    map.places.clearLayers();
    $('#btn-places').classList.toggle('active', places.on);
    $('#places-bar').hidden = !places.on || state.tab !== 'map' || !!state.zoneEdit;
    if (!places.on || state.tab === 'history' || state.zoneEdit) return;
    const zoom = map.m.getZoom();
    $('#places-hint').hidden = zoom >= 16 || state.tab !== 'map';
    if (zoom < 16) return;
    map.m.getContainer().classList.toggle('show-place-names', zoom >= 17);
    const b = map.m.getBounds().pad(0.1);
    const max = zoom >= 18 ? 300 : (zoom >= 17 ? 140 : 60);
    let shown = 0;
    for (const p of places.all.values()) {
      if (shown >= max) break;
      if (!places.filter.has(p.group) || !b.contains([p.lat, p.lng])) continue;
      const g = PLACE_GROUPS[p.group];
      const m = L.marker([p.lat, p.lng], {
        keyboard: false, riseOnHover: true,
        icon: L.divIcon({ className: '', iconSize: [26, 26], iconAnchor: [13, 13],
          html: '<div class="place" style="--c:' + g.color + '"><span class="place-dot">' + placeIcon(p.group) + '</span><span class="place-name"></span></div>' })
      });
      m.on('add', function () { this.getElement().querySelector('.place-name').textContent = placeName(p.tags); });
      m.on('click', () => showPlace(p));
      m.addTo(map.places);
      shown++;
    }
  }

  function renderPlacesBar() {
    const bar = $('#places-bar');
    bar.innerHTML = '';
    Object.keys(PLACE_GROUPS).filter((g) => g !== 'other').forEach((g) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'pchip' + (places.filter.has(g) ? ' on' : '');
      b.style.setProperty('--c', PLACE_GROUPS[g].color);
      b.innerHTML = placeIcon(g) + '<span></span>';
      b.querySelector('span').textContent = t('pg_' + g);
      b.addEventListener('click', () => {
        // first tap on a full filter shows only that group; then taps add / remove groups
        const all = places.filter.size >= Object.keys(PLACE_GROUPS).length - 1;
        if (all) { places.filter = new Set([g]); }
        else if (places.filter.has(g)) { places.filter.delete(g); if (!places.filter.size) places.filter = new Set(Object.keys(PLACE_GROUPS).filter((x) => x !== 'other')); }
        else places.filter.add(g);
        renderPlacesBar(); renderPlaces();
      });
      bar.appendChild(b);
    });
  }

  function togglePlaces() {
    places.on = !places.on;
    localStorage.setItem('trackly-places', places.on ? '1' : '0');
    if (places.on && map.m.getZoom() < 16) toast(t('places_zoom'));
    renderPlaces(); loadPlaces();
  }

  // Tap a place: name, type, address, hours, phone + Directions / Safe zone here
  function showPlace(p) {
    const box = document.createElement('div');
    box.className = 'bi';
    const g = PLACE_GROUPS[p.group];
    box.innerHTML = '<div class="pl-head"><span class="place-dot big" style="--c:' + g.color + '">' + placeIcon(p.group) + '</span>' +
      '<div><strong class="bi-title"></strong><span class="pl-type"></span></div></div><dl class="bi-grid"></dl>' +
      '<div class="bi-actions"><button type="button" class="btn btn-secondary" data-pa="zone"></button><button type="button" class="btn btn-primary" data-pa="go"></button></div>';
    box.querySelector('.bi-title').textContent = placeName(p.tags);
    const tagType = p.tags.shop || p.tags.amenity || p.tags.tourism || p.tags.leisure || p.tags.kind || '';
    box.querySelector('.pl-type').textContent = t('pg_' + p.group) + (tagType && p.group !== 'other' ? '' : (tagType ? ' · ' + tagType.replace(/_/g, ' ') : ''));
    const dl = box.querySelector('dl');
    const row = (k, v, href) => {
      if (!v) return;
      const dt = document.createElement('dt'); dt.textContent = t(k);
      const dd = document.createElement('dd');
      if (href) { const a = document.createElement('a'); a.href = href; a.textContent = v; a.dir = 'ltr'; dd.appendChild(a); } else dd.textContent = v;
      dl.append(dt, dd);
    };
    const addr = [p.tags['addr:street'], p.tags['addr:housenumber']].filter(Boolean).join(' ');
    row('address', addr);
    row('open_hours', p.tags.opening_hours);
    const phone = p.tags.phone || p.tags['contact:phone'];
    row('phone', phone, phone ? 'tel:' + phone.replace(/\s/g, '') : null);
    const loc = state.recent[0];
    if (loc) row('from_bag', fmtDistance(distanceM(loc, p)));
    box.querySelector('[data-pa="zone"]').textContent = t('zone_here');
    box.querySelector('[data-pa="go"]').textContent = t('directions');
    box.querySelector('[data-pa="go"]').addEventListener('click', () => window.open('https://www.google.com/maps/dir/?api=1&destination=' + p.lat + ',' + p.lng, '_blank', 'noopener'));
    box.querySelector('[data-pa="zone"]').addEventListener('click', () => {
      map.m.closePopup();
      switchTab('zones');
      startZoneEdit();
      $('#zone-name').value = placeName(p.tags).slice(0, 40);
      map.m.setView([p.lat, p.lng], 17, { animate: false });
      map.m.panBy([0, -(map.pinOffset || 0)], { animate: false });
      syncEditCircle();
    });
    L.popup({ className: 'bag-popup', maxWidth: 300, offset: [0, -8], autoPanPaddingTopLeft: [16, 130] }).setLatLng([p.lat, p.lng]).setContent(box).openOn(map.m);
  }

  // "Near Family Mall · 40 m" on the bag card: the closest named place around the bag
  const nearCache = {};
  async function updateNear(loc) {
    const el = $('#bag-near');
    const key = loc.lat.toFixed(3) + ',' + loc.lng.toFixed(3);
    const show = (p) => {
      if (!p) { el.hidden = true; return; }
      el.hidden = false;
      el.innerHTML = '<span class="place-dot tiny" style="--c:' + PLACE_GROUPS[p.group].color + '">' + placeIcon(p.group) + '</span><span></span>';
      el.querySelector('span:last-child').textContent = t('near_place', { p: placeName(p.tags) }) + ' · ' + fmtDistance(distanceM(loc, p));
    };
    const pick = (list) => list.filter((p) => p.group !== 'other' || p.tags.tourism)
      .map((p) => ({ p, d: distanceM(loc, p) })).filter((x) => x.d <= 250).sort((a, b) => a.d - b.d)[0];
    // places already on the map are enough most of the time
    const local = pick([...places.all.values()]);
    if (local) { show(local.p); return; }
    if (key in nearCache) { show(nearCache[key]); return; }
    // the vector map / places layer will bring them (no extra server request)
    if (places.on && (map.m.getZoom() >= 15 || (map.tiles && map.tiles.getMaplibreMap))) { el.hidden = true; return; }
    nearCache[key] = null;
    const els = await overpass(placesQuery('(around:250,' + loc.lat.toFixed(5) + ',' + loc.lng.toFixed(5) + ')', 60));
    const found = pick((els || []).map(toPlace).filter(Boolean));
    nearCache[key] = found ? found.p : null;
    if (state.recent[0] === loc) show(nearCache[key]);
  }

  // =====================================================================
  // SEARCH the map: any street, mall, area or shop (OpenStreetMap)
  // =====================================================================
  let mapSearchTimer = null, mapSearchSeq = 0;
  function openSearch() {
    $('#search-panel').hidden = false;
    $('#map-search').value = '';
    $('#map-search-results').innerHTML = '';
    setTimeout(() => $('#map-search').focus(), 50);
  }
  function closeSearch() { $('#search-panel').hidden = true; $('#map-search').blur(); }
  function onMapSearch(e) {
    clearTimeout(mapSearchTimer);
    const q = e.target.value.trim();
    const list = $('#map-search-results');
    if (q.length < 2) { list.innerHTML = ''; return; }
    mapSearchTimer = setTimeout(async () => {
      const seq = ++mapSearchSeq;
      // 1) places already loaded on the map (instant), 2) OpenStreetMap search
      const low = q.toLowerCase();
      const local = [...places.all.values()].filter((p) => Object.keys(p.tags).some((k) => k.startsWith('name') && String(p.tags[k]).toLowerCase().includes(low))).slice(0, 5)
        .map((p) => ({ name: placeName(p.tags), sub: t('pg_' + p.group), lat: p.lat, lng: p.lng, group: p.group }));
      const c = map.m.getCenter();
      const lang = state.lang === 'ckb' ? 'ckb,ku,ar,en' : state.lang + ',en';
      let rows = [];
      try {
        const r = await fetch('https://nominatim.openstreetmap.org/search?format=jsonv2&limit=8&countrycodes=iq&accept-language=' + lang +
          '&viewbox=' + [c.lng - 0.5, c.lat + 0.4, c.lng + 0.5, c.lat - 0.4].join(',') + '&q=' + encodeURIComponent(q));
        if (r.ok) rows = await r.json();
      } catch (err) { /* offline */ }
      if (seq !== mapSearchSeq) return;
      const all = local.concat(rows.map((row) => {
        const parts = String(row.display_name || '').split(',');
        return { name: parts[0], sub: parts.slice(1, 3).join(',').trim(), lat: +row.lat, lng: +row.lon, group: null };
      }));
      list.innerHTML = '';
      if (!all.length) { const li = document.createElement('li'); li.className = 'empty'; li.textContent = t('no_results'); list.appendChild(li); return; }
      all.forEach((r) => {
        const li = document.createElement('li');
        const b = document.createElement('button');
        b.type = 'button';
        b.innerHTML = '<span class="place-dot" style="--c:' + (r.group ? PLACE_GROUPS[r.group].color : '#64748B') + '">' + placeIcon(r.group || 'other') + '</span><span class="sr-text"><strong></strong><span></span></span>';
        b.querySelector('strong').textContent = r.name;
        b.querySelector('.sr-text span').textContent = r.sub + (state.recent[0] ? ' · ' + fmtDistance(distanceM(state.recent[0], r)) : '');
        b.addEventListener('click', () => {
          closeSearch();
          state.followBag = false; updateCenterBtn();
          map.m.setView([r.lat, r.lng], 17);
          if (map.searchPin) map.m.removeLayer(map.searchPin);
          map.searchPin = L.marker([r.lat, r.lng], { icon: L.divIcon({ className: '', iconSize: [34, 42], iconAnchor: [17, 40], html: '<div class="search-pin"></div>' }) }).addTo(map.m);
          showPlace({ id: 'search', lat: r.lat, lng: r.lng, group: r.group || 'other', tags: { name: r.name } });
        });
        li.appendChild(b);
        list.appendChild(li);
      });
    }, 350);
  }

  // =====================================================================
  // FIND MODE — a big arrow that points to the bag (phone compass + GPS)
  // =====================================================================
  const find = { on: false, heading: null, lastDist: null, handler: null };
  function openFind() {
    if (!state.recent[0]) { toast(t('no_location')); return; }
    find.on = true; find.lastDist = null;
    $('#find-view').hidden = false;
    locateMe(false);                      // live position of the phone
    startCompass(false);
    renderFind();
  }
  function closeFind() {
    find.on = false;
    $('#find-view').hidden = true;
    if (find.handler) { window.removeEventListener('deviceorientationabsolute', find.handler); window.removeEventListener('deviceorientation', find.handler); find.handler = null; }
  }
  // iPhone needs a tap before it shares the compass; Android just works
  async function startCompass(fromTap) {
    const D = window.DeviceOrientationEvent;
    if (!D) { renderFind(); return; }
    if (typeof D.requestPermission === 'function') {
      if (!fromTap) { $('#find-compass').hidden = false; return; }
      try { if ((await D.requestPermission()) !== 'granted') return; } catch (e) { return; }
    }
    $('#find-compass').hidden = true;
    if (find.handler) return;
    find.handler = (e) => {
      let h = null;
      if (typeof e.webkitCompassHeading === 'number') h = e.webkitCompassHeading;          // iPhone
      else if (e.absolute && typeof e.alpha === 'number') h = (360 - e.alpha) % 360;     // Android
      if (h !== null) { find.heading = h; renderFind(); }
    };
    window.addEventListener('ontouchstart' in window && 'ondeviceorientationabsolute' in window ? 'deviceorientationabsolute' : 'deviceorientation', find.handler);
  }
  function renderFind() {
    if (!find.on) return;
    const loc = state.recent[0];
    const me = state.me;
    $('#find-name').textContent = state.tracker ? (state.tracker.name || state.tracker.device_code) : '';
    if (!me || !loc) { $('#find-dist').textContent = '…'; $('#find-dir').textContent = t('waiting'); return; }
    const d = distanceM(me, loc), br = bearing(me, loc);
    $('#find-dist').textContent = d < 8 ? t('find_here') : fmtDistance(d);
    $('#find-dist').classList.toggle('text', d < 8);
    $('#find-dir').textContent = d < 8 ? '' : t('dir_' + compass(br)) + (find.heading === null ? ' · ' + t('find_no_compass') : '');
    // arrow: relative to where the phone points (compass), or to north when there's no compass
    const rot = find.heading === null ? br : br - find.heading;
    $('#find-arrow').style.transform = 'rotate(' + Math.round(rot) + 'deg)';
    $('#find-ring').classList.toggle('near', d < 30);
    if (find.lastDist !== null && Math.abs(d - find.lastDist) > 3) {
      $('#find-trend').textContent = d < find.lastDist ? t('find_closer') : t('find_farther');
      $('#find-trend').className = 'find-trend ' + (d < find.lastDist ? 'good' : 'bad');
      find.lastDist = d;
    } else if (find.lastDist === null) find.lastDist = d;
  }

  // =====================================================================
  // ALERTS — safe zone leave / arrive and low battery, as they happen
  // (in the real app these also come as push notifications from the server)
  // =====================================================================
  function alertList() { try { return JSON.parse(localStorage.getItem('trackly-alerts')) || []; } catch (e) { return []; } }
  function addAlert(kind, text) {
    const list = alertList();
    list.unshift({ kind, text, at: new Date().toISOString() });
    localStorage.setItem('trackly-alerts', JSON.stringify(list.slice(0, 30)));
    renderAlerts();
    toast(text);
    if (navigator.vibrate) navigator.vibrate([60, 40, 60]);
    // a phone notification too, if the user allowed them
    try {
      if (window.Notification && Notification.permission === 'granted' && navigator.serviceWorker) {
        navigator.serviceWorker.ready.then((reg) => reg.showNotification('Trackly', { body: text, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', tag: 'trackly-' + kind }));
      }
    } catch (e) { /* not supported */ }
  }
  function checkAlerts(prev, next) {
    if (!prev || !next || !state.tracker) return;
    const bag = state.tracker.name || state.tracker.device_code;
    state.zones.filter((z) => z.enabled).forEach((z) => {
      const was = distanceM(prev, z) <= z.radius_m, now = distanceM(next, z) <= z.radius_m;
      if (was && !now && (z.notify_on === 'leave' || z.notify_on === 'both')) addAlert('zone', t('alert_left', { b: bag, z: z.name }));
      if (!was && now && (z.notify_on === 'arrive' || z.notify_on === 'both')) addAlert('zone', t('alert_arrived', { b: bag, z: z.name }));
    });
    const tr = state.tracker;
    if (CFG.fakeBackend && tr.parked_at && !tr.parked_alerted && distanceM(next, { lat: tr.parked_lat, lng: tr.parked_lng }) > 60) {
      tr.parked_alerted = true; addAlert('moved', t('alert_moved', { b: bag }));
    }
    const lim = CFG.lowBatteryPercent;
    if (typeof prev.battery === 'number' && typeof next.battery === 'number' && prev.battery > lim && next.battery <= lim) addAlert('battery', t('alert_low', { b: bag, n: next.battery }));
    if (typeof prev.battery === 'number' && typeof next.battery === 'number' && prev.battery > 5 && next.battery <= 5) addAlert('battery', t('alert_critical', { b: bag }));
  }
  // real database: alerts are made by the server (saved even when the app is closed)
  const ALERT_TEXT = { zone_left: 'alert_left', zone_arrived: 'alert_arrived', battery_low: 'alert_low', battery_critical: 'alert_critical', moved: 'alert_moved' };
  async function serverAlerts() {
    const { data, error } = await sb.from('alerts').select('tracker_id, kind, zone_name, battery, created_at').order('created_at', { ascending: false }).limit(20);
    if (error || !data) return null;
    return data.map((a) => {
      const tr = state.trackers.find((x) => x.id === a.tracker_id);
      const b = tr ? (tr.name || tr.device_code) : '';
      return { kind: a.kind.startsWith('battery') ? 'battery' : (a.kind === 'moved' ? 'moved' : 'zone'), at: a.created_at, text: t(ALERT_TEXT[a.kind], { b, z: a.zone_name || '', n: a.battery }) };
    });
  }
  async function renderAlerts() {
    const ul = $('#alert-list');
    if (!ul) return;
    const list = (!CFG.fakeBackend && (await serverAlerts())) || alertList();
    ul.innerHTML = '';
    if (!list.length) { const li = document.createElement('li'); li.className = 'empty'; li.textContent = t('no_alerts'); ul.appendChild(li); return; }
    list.slice(0, 8).forEach((a) => {
      const li = document.createElement('li');
      li.className = 'alert-item ' + a.kind;
      const strong = document.createElement('strong'); strong.textContent = a.text;
      const span = document.createElement('span'); span.textContent = clockTime(a.at) + ' · ' + relTime(ageSeconds({ created_at: a.at }));
      li.append(strong, span);
      ul.appendChild(li);
    });
  }

  // =====================================================================
  // BOTTOM CARD — swipe down (or tap the handle) to see more map
  // =====================================================================
  function setupSheetDrag() {
    const sheet = $('#sheet'), handle = $('#sheet-handle');
    let y0 = null;
    const toggle = (collapse) => { sheet.classList.toggle('collapsed', collapse); handle.setAttribute('aria-expanded', String(!collapse)); };
    handle.addEventListener('click', () => toggle(!sheet.classList.contains('collapsed')));
    handle.addEventListener('pointerdown', (e) => { y0 = e.clientY; });
    window.addEventListener('pointerup', (e) => {
      if (y0 === null) return;
      const dy = e.clientY - y0; y0 = null;
      if (dy > 30) toggle(true); else if (dy < -30) toggle(false);
    });
  }

  // =====================================================================
  // BEEP — ask the tracker to play its sound (the ESP32 checks for this)
  // =====================================================================
  async function requestBuzz() {
    if (!state.tracker) return;
    const { error } = await sb.rpc('request_buzz', { p_tracker: state.tracker.id });
    if (error) { toast(errorText(error)); return; }
    if (navigator.vibrate) navigator.vibrate(80);
    toast(state.tracker.mode === 'lost' ? t('buzz_sent_lost') : t('buzz_sent'));
  }

  // =====================================================================
  // SHARE LIVE — a link family can open (no account) that ends by itself
  // =====================================================================
  async function shareLive(hours) {
    if (!state.tracker) return;
    const { data, error } = await sb.rpc('create_share_link', { p_tracker: state.tracker.id, p_hours: hours || 4 });
    if (error || !data) { shareLocation(); return; } // fall back to a one-time Google Maps point
    const url = new URL('share.html?t=' + encodeURIComponent(data), location.href).href;
    try {
      if (navigator.share) { await navigator.share({ title: 'Trackly', text: t('share_live_text', { h: hours || 4 }), url }); return; }
      await navigator.clipboard.writeText(url);
      toast(t('toast_link_copied'));
    } catch (e) { /* closed the share sheet */ }
  }

  // =====================================================================
  // REPORT — one page with everything police or friends need, ready to print / save as PDF
  // =====================================================================
  async function openReport() {
    if (!state.tracker || !state.recent[0]) { toast(t('no_location')); return; }
    const v = $('#report-view');
    v.hidden = false;
    const loc = state.recent[0], tr = state.tracker;
    $('#rp-name').textContent = tr.name || tr.device_code;
    $('#rp-code').textContent = tr.device_code;
    $('#rp-owner').textContent = state.user ? state.user.email : '';
    $('#rp-made').textContent = new Date().toLocaleString(state.lang === 'en' ? 'en-GB' : (state.lang === 'ar' ? 'ar-IQ-u-nu-latn' : 'ckb-IQ-u-nu-latn'));
    $('#rp-mode').textContent = tr.mode === 'lost' ? t('mode_lost') : t('mode_normal');
    $('#rp-last').textContent = clockTime(loc.created_at) + ' · ' + relTime(ageSeconds(loc));
    $('#rp-coords').textContent = loc.lat.toFixed(6) + ', ' + loc.lng.toFixed(6);
    $('#rp-battery').textContent = typeof loc.battery === 'number' ? loc.battery + '%' : '—';
    $('#rp-address').textContent = $('#bag-area').textContent + ($('#bag-near').hidden ? '' : ' · ' + $('#bag-near').textContent);
    $('#rp-maps').href = 'https://www.google.com/maps/search/?api=1&query=' + loc.lat.toFixed(6) + ',' + loc.lng.toFixed(6);
    $('#rp-maps').textContent = $('#rp-maps').href;
    // last 2 hours of points
    const since = Date.now() - 2 * 3600e3;
    const pts = state.recent.filter((r) => new Date(r.created_at).getTime() >= since).slice(0, 40);
    const tb = $('#rp-points');
    tb.innerHTML = '';
    pts.forEach((p) => {
      const tr2 = document.createElement('tr');
      [clockTime(p.created_at), p.lat.toFixed(5) + ', ' + p.lng.toFixed(5), typeof p.battery === 'number' ? p.battery + '%' : '—'].forEach((x) => {
        const td = document.createElement('td'); td.textContent = x; tr2.appendChild(td);
      });
      tb.appendChild(tr2);
    });
    // small map with the route
    setTimeout(() => {
      if (!map.report) {
        map.report = L.map('rp-map', { zoomControl: false, attributionControl: true, dragging: true });
        L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap', crossOrigin: true }).addTo(map.report);
      }
      map.report.invalidateSize();
      if (map.reportLayer) map.report.removeLayer(map.reportLayer);
      const g = L.layerGroup();
      const line = pts.map((p) => [p.lat, p.lng]);
      if (line.length > 1) L.polyline(line, { color: '#D93A3F', weight: 4 }).addTo(g);
      L.circleMarker([loc.lat, loc.lng], { radius: 9, color: '#fff', weight: 3, fillColor: '#D93A3F', fillOpacity: 1 }).addTo(g);
      map.reportLayer = g.addTo(map.report);
      if (line.length > 1) map.report.fitBounds(L.latLngBounds(line), { padding: [24, 24], maxZoom: 17 });
      else map.report.setView([loc.lat, loc.lng], 17);
    }, 60);
  }
  function closeReport() { $('#report-view').hidden = true; }
  async function shareReport() {
    const loc = state.recent[0];
    const text = t('report_title') + ': ' + $('#rp-name').textContent + ' (' + $('#rp-code').textContent + ')\n' +
      t('last_seen') + ': ' + $('#rp-last').textContent + '\n' + $('#rp-address').textContent + '\n' + $('#rp-maps').href;
    try {
      if (navigator.share) await navigator.share({ title: t('report_title'), text });
      else { await navigator.clipboard.writeText(text); toast(t('copied')); }
    } catch (e) { /* closed */ }
    void loc;
  }

  // =====================================================================
  // BATTERY LIFE — how long it lasts at the current use (from the last day)
  // =====================================================================
  const batt = { rate: null, for: null, at: 0 };
  async function estimateBattery() {
    if (!state.tracker || (batt.for === state.tracker.id && Date.now() - batt.at < 30 * 60e3)) return;
    batt.for = state.tracker.id; batt.at = Date.now();
    const since = new Date(Date.now() - 24 * 3600e3).toISOString();
    const { data } = await sb.from('locations').select('battery, created_at').eq('tracker_id', state.tracker.id)
      .gte('created_at', since).order('created_at', { ascending: true }).limit(3000);
    const pts = (data || []).filter((p) => typeof p.battery === 'number');
    batt.rate = null;
    if (pts.length >= 2) {
      const a = pts[0], b = pts[pts.length - 1];
      const hours = (new Date(b.created_at) - new Date(a.created_at)) / 3600e3;
      const drop = a.battery - b.battery;
      if (hours >= 1 && drop >= 2) batt.rate = drop / hours; // % per hour
    }
    renderMapPanel();
  }
  function batteryLeftText(battery, lost) {
    if (typeof battery !== 'number') return '';
    let hours;
    if (lost) hours = (battery / 100) * CFG.lostBatteryHoursAtFull;
    else if (batt.rate) hours = battery / batt.rate;
    else return '';
    return hours >= 48 ? t('days_left', { n: Math.round(hours / 24) }) : t('hours_left', { n: Math.max(1, Math.round(hours)) });
  }

  // =====================================================================
  // STOPS — "Family Mall · 2 h 10 min" in History (places it stayed 10 min+)
  // =====================================================================
  function findStops(pts) {
    const stops = [];
    let i = 0;
    while (i < pts.length) {
      let j = i;
      while (j + 1 < pts.length && distanceM(pts[i], pts[j + 1]) <= 120) j++;
      const mins = (new Date(pts[j].created_at) - new Date(pts[i].created_at)) / 60000;
      if (mins >= 10) {
        const group = pts.slice(i, j + 1);
        stops.push({ lat: group.reduce((s, p) => s + p.lat, 0) / group.length, lng: group.reduce((s, p) => s + p.lng, 0) / group.length,
          from: pts[i].created_at, to: pts[j].created_at, mins });
        i = j + 1;
      } else i++;
    }
    return stops;
  }
  function fmtDuration(mins) {
    const h = Math.floor(mins / 60), m = Math.round(mins % 60);
    if (h && m) return t('dur_hm', { h, m });
    if (h) return t('dur_h', { h });
    return t('dur_m', { m: Math.max(1, m) });
  }
  // name for a stop: a safe zone, a place we already know, or the street (OpenStreetMap)
  const stopNames = {};
  async function stopName(s) {
    const z = zoneAt(s);
    if (z) return z.name;
    const near = [...places.all.values()].map((p) => ({ p, d: distanceM(s, p) })).filter((x) => x.d < 80).sort((a, b) => a.d - b.d)[0];
    if (near) return placeName(near.p.tags);
    const key = state.lang + s.lat.toFixed(4) + s.lng.toFixed(4);
    if (stopNames[key]) return stopNames[key];
    try {
      const lang = state.lang === 'ckb' ? 'ckb,ku,ar' : state.lang;
      const r = await fetch('https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&lat=' + s.lat + '&lon=' + s.lng + '&accept-language=' + lang);
      if (r.ok) {
        const d = await r.json(), a = d.address || {};
        stopNames[key] = d.name || a.amenity || a.shop || a.road || a.neighbourhood || a.suburb || '';
      }
    } catch (e) { /* offline */ }
    return stopNames[key] || t('stop');
  }

  // =====================================================================
  // YOUR BAGS — name + colour for each bag (Account tab)
  // =====================================================================
  const BAG_COLORS = ['#E8B86D', '#3DDBB4', '#E8A0A8', '#5B8CFF', '#B38CFF', '#F97316'];
  function bagColor(tr) { return (tr && tr.color) || BAG_COLORS[Math.max(0, state.trackers.indexOf(tr)) % BAG_COLORS.length]; }
  function renderBags() {
    const ul = $('#bag-list');
    if (!ul) return;
    ul.innerHTML = '';
    state.trackers.forEach((tr) => {
      const li = document.createElement('li');
      li.className = 'bag-item';
      const dot = document.createElement('span'); dot.className = 'bag-dot'; dot.style.background = bagColor(tr);
      const name = document.createElement('input'); name.value = tr.name || ''; name.placeholder = tr.device_code; name.maxLength = 40;
      name.setAttribute('aria-label', t('give_name'));
      name.addEventListener('change', () => saveBag(tr, { name: name.value.trim() || tr.device_code }));
      const colors = document.createElement('div'); colors.className = 'bag-colors';
      BAG_COLORS.forEach((c) => {
        const b = document.createElement('button');
        b.type = 'button'; b.style.background = c; b.setAttribute('aria-label', c);
        if (bagColor(tr) === c) b.className = 'on';
        b.addEventListener('click', () => saveBag(tr, { color: c }));
        colors.appendChild(b);
      });
      const code = document.createElement('span'); code.className = 'bag-code'; code.textContent = tr.device_code;
      const mine = !tr.owner_id || !state.user || tr.owner_id === state.user.id;
      name.disabled = !mine;
      const fam = document.createElement('div'); fam.className = 'bag-family';
      const famTitle = document.createElement('span'); famTitle.className = 'label'; famTitle.textContent = t('family_access');
      const members = document.createElement('div'); members.className = 'members';
      fam.append(famTitle, members);
      const acts = document.createElement('div'); acts.className = 'bag-acts';
      if (mine) {
        const inv = document.createElement('button'); inv.type = 'button'; inv.className = 'btn btn-secondary'; inv.textContent = t('invite_family');
        inv.addEventListener('click', () => inviteFamily(tr));
        const un = document.createElement('button'); un.type = 'button'; un.className = 'btn btn-ghost danger-text'; un.textContent = t('unpair');
        un.addEventListener('click', () => unpair(tr));
        acts.append(inv, un);
      }
      li.append(dot, name, code, colors, fam, acts);
      renderMembers(tr, members);
      if (!mine) colors.hidden = true;
      ul.appendChild(li);
    });
  }
  async function saveBag(tr, values) {
    const { error } = await sb.rpc('set_tracker_info', { p_tracker: tr.id, p_name: values.name ?? tr.name, p_color: values.color ?? tr.color ?? null });
    if (error) { toast(errorText(error)); return; }
    Object.assign(tr, values);
    const opt = [...$('#tracker-select').options].find((o) => o.value === tr.id);
    if (opt) opt.textContent = tr.name || tr.device_code;
    renderBags(); renderMapPanel();
    toast(t('saved'));
  }

  // =====================================================================
  // COLOUR THEMES (Account tab) — Gold is the default
  // =====================================================================
  const THEMES = ['gold', 'mint', 'rose', 'ocean'];
  function applyTheme(name) {
    const th = THEMES.includes(name) ? name : 'gold';
    document.documentElement.dataset.theme = th;
    localStorage.setItem('trackly-theme', th);
    $$('#theme-list [data-theme-pick]').forEach((b) => b.classList.toggle('on', b.dataset.themePick === th));
    const meta = document.querySelectorAll('meta[name="theme-color"]');
    meta.forEach((m) => { m.content = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(); });
    if (map.m) { renderMapPanel(); renderZones(); }
  }

  // =====================================================================
  // DATABASE SWITCH — test mode (pretend data) or the real Supabase
  // =====================================================================
  function setBackend(real) {
    localStorage.setItem('trackly-backend', real ? 'real' : 'test');
    location.reload();
  }

  // =====================================================================
  // PHONE NOTIFICATIONS (real database): subscribe this phone to the send-alerts function
  // =====================================================================
  const PUSH_URL = CFG.supabaseUrl + '/functions/v1/send-alerts';
  function b64ToBytes(b64) {
    const pad = '='.repeat((4 - (b64.length % 4)) % 4);
    const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(raw, (c) => c.charCodeAt(0));
  }
  async function pushState() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !window.isSecureContext) return 'unsupported';
    if (window.Notification && Notification.permission === 'denied') return 'blocked';
    const reg = await navigator.serviceWorker.ready;
    return (await reg.pushManager.getSubscription()) ? 'on' : 'off';
  }
  async function renderPushSwitch() {
    const sw = $('#push-switch');
    if (!sw) return;
    const st = await pushState();
    sw.setAttribute('aria-checked', String(st === 'on'));
    sw.disabled = st === 'unsupported';
    const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
    const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
    $('#push-state').textContent = st === 'unsupported' ? (ios && !standalone ? t('push_ios_install') : t('push_unsupported'))
      : st === 'blocked' ? t('push_blocked') : (st === 'on' ? t('push_on') : t('push_off'));
  }
  async function togglePush() {
    const st = await pushState();
    if (st === 'unsupported') { renderPushSwitch(); return; }
    const reg = await navigator.serviceWorker.ready;
    if (st === 'on') {
      const sub = await reg.pushManager.getSubscription();
      if (sub) { await sb.rpc('delete_push_subscription', { p_endpoint: sub.endpoint }); await sub.unsubscribe(); }
      renderPushSwitch(); return;
    }
    if ((await Notification.requestPermission()) !== 'granted') { renderPushSwitch(); toast(t('push_blocked')); return; }
    if (CFG.fakeBackend) { toast(t('push_test_mode')); renderPushSwitch(); return; } // test mode: in-app alerts only
    try {
      const { publicKey } = await (await fetch(PUSH_URL)).json();
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(publicKey) });
      const { error } = await sb.rpc('save_push_subscription', { p_sub: sub.toJSON(), p_lang: state.lang });
      if (error) throw error;
      toast(t('push_on'));
    } catch (e) { toast(t('err_generic')); reportError(e); }
    renderPushSwitch();
  }

  // =====================================================================
  // QR PAIRING — scan the card with the camera, or open a pairing link (…#pair=CODE.SECRET)
  // =====================================================================
  // accepted: "TRACKLY:SB-0001:secret", a link with #pair=SB-0001.secret, or {"code":"…","secret":"…"}
  function parsePairText(text) {
    const s = String(text || '').trim();
    let m = /^TRACKLY:([A-Z0-9-]+):(.+)$/i.exec(s);
    if (m) return { code: m[1].toUpperCase(), secret: m[2] };
    m = /[#&?]pair=([A-Z0-9-]+)\.([^&#\s]+)/i.exec(s);
    if (m) return { code: m[1].toUpperCase(), secret: decodeURIComponent(m[2]) };
    try { const j = JSON.parse(s); if (j.code && j.secret) return { code: String(j.code).toUpperCase(), secret: String(j.secret) }; } catch (e) { /* not JSON */ }
    return null;
  }
  const scan = { stream: null, timer: null, detector: null };
  async function openScanner() {
    if (!navigator.mediaDevices || !window.isSecureContext) { toast(t('scan_https')); return; }
    $('#scan-view').hidden = false;
    $('#scan-msg').textContent = t('scan_hint');
    try {
      scan.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
    } catch (e) { $('#scan-msg').textContent = t('scan_denied'); return; }
    const video = $('#scan-video');
    video.srcObject = scan.stream;
    await video.play().catch(() => {});
    if ('BarcodeDetector' in window) { try { scan.detector = new window.BarcodeDetector({ formats: ['qr_code'] }); } catch (e) { scan.detector = null; } }
    const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d', { willReadFrequently: true });
    scan.timer = setInterval(async () => {
      if (video.readyState < 2) return;
      let text = null;
      if (scan.detector) { try { const r = await scan.detector.detect(video); if (r[0]) text = r[0].rawValue; } catch (e) { scan.detector = null; } }
      else if (window.jsQR) {
        canvas.width = video.videoWidth; canvas.height = video.videoHeight;
        ctx.drawImage(video, 0, 0);
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const r = window.jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
        if (r) text = r.data;
      }
      if (!text) return;
      const p = parsePairText(text);
      if (!p) { $('#scan-msg').textContent = t('scan_not_trackly'); return; }
      if (navigator.vibrate) navigator.vibrate(60);
      closeScanner();
      $('#pair-code').value = p.code; $('#pair-secret').value = p.secret;
      $('#pair-name').focus();
      toast(t('scan_ok'));
    }, 250);
  }
  function closeScanner() {
    clearInterval(scan.timer); scan.timer = null;
    if (scan.stream) scan.stream.getTracks().forEach((tr) => tr.stop());
    scan.stream = null;
    $('#scan-view').hidden = true;
  }
  // links opened from the phone camera: #pair=CODE.SECRET or #join=INVITE
  function takeLinkAction() {
    const h = location.hash;
    const p = parsePairText(h);
    const j = /[#&]join=([A-Z0-9]{6,12})/i.exec(h);
    if (p) sessionStorage.setItem('trackly-pending-pair', JSON.stringify(p));
    if (j) sessionStorage.setItem('trackly-pending-join', j[1].toUpperCase());
    if (p || j) history.replaceState(null, '', location.pathname + location.search);
  }
  function applyPendingPair() {
    try {
      const p = JSON.parse(sessionStorage.getItem('trackly-pending-pair') || 'null');
      if (!p) return false;
      sessionStorage.removeItem('trackly-pending-pair');
      $('#pair-code').value = p.code; $('#pair-secret').value = p.secret;
      return true;
    } catch (e) { return false; }
  }
  async function applyPendingJoin() {
    const code = sessionStorage.getItem('trackly-pending-join');
    if (!code || !state.user) return;
    sessionStorage.removeItem('trackly-pending-join');
    await joinFamily(code);
  }

  // =====================================================================
  // PASSWORD RESET + GOOGLE
  // =====================================================================
  async function forgotPassword() {
    const email = $('#auth-email').value.trim();
    if (!email) { $('#auth-error').textContent = t('err_email_first'); $('#auth-email').focus(); return; }
    const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
    if (error) { $('#auth-error').textContent = errorText(error); return; }
    toast(t('reset_sent'));
  }
  async function saveNewPassword(e) {
    e.preventDefault();
    const pw = $('#newpw-input').value;
    if (pw.length < 6) { $('#newpw-error').textContent = t('err_fill'); return; }
    const { error } = await sb.auth.updateUser({ password: pw });
    if (error) { $('#newpw-error').textContent = errorText(error); return; }
    $('#newpw-view').hidden = true;
    toast(t('pw_changed'));
    route();
  }
  async function googleLogin() {
    if (CFG.fakeBackend) { toast(t('google_test_mode')); return; }
    const { error } = await sb.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: location.origin + location.pathname } });
    if (error) $('#auth-error').textContent = errorText(error);
  }

  // =====================================================================
  // LEFT BEHIND — you walked away from your bag (works while Trackly is open)
  // =====================================================================
  const behind = { together: false, alerted: false };
  function leftBehindOn() { return localStorage.getItem('trackly-left-behind') !== '0'; }
  function checkLeftBehind() {
    if (!leftBehindOn() || !state.me || !state.recent[0] || !state.tracker) return;
    const loc = state.recent[0];
    if (ageSeconds(loc) > 15 * 60 || state.tracker.mode === 'lost') return;
    const d = distanceM(state.me, loc);
    if (d < 60) { behind.together = true; behind.alerted = false; return; }
    // only after you were together, the bag is still, you're 120 m+ away, and it isn't at home / in a safe zone
    const z = zoneAt(loc);
    if (behind.together && !behind.alerted && d > 120 && !(z && z.kind === 'home') && !z) {
      behind.alerted = true; behind.together = false;
      addAlert('behind', t('alert_left_behind', { b: state.tracker.name || state.tracker.device_code, d: fmtDistance(d) }));
    }
  }
  function toggleLeftBehind() {
    localStorage.setItem('trackly-left-behind', leftBehindOn() ? '0' : '1');
    $('#behind-switch').setAttribute('aria-checked', String(leftBehindOn()));
    if (leftBehindOn()) locateMe(false);
  }

  // =====================================================================
  // PARK — movement alarm: alert if the parked bag moves 60 m+
  // =====================================================================
  async function togglePark() {
    const tr = state.tracker;
    if (!tr) return;
    const on = !tr.parked_at;
    const { data, error } = await sb.rpc('set_parked', { p_tracker: tr.id, p_on: on });
    if (error) { toast(errorText(error)); return; }
    if (on && data) Object.assign(tr, { parked_at: data.parked_at, parked_lat: data.lat, parked_lng: data.lng, parked_alerted: false });
    else Object.assign(tr, { parked_at: null, parked_lat: null, parked_lng: null, parked_alerted: false });
    toast(on ? t('park_on') : t('park_off'));
    renderMapPanel();
  }
  function renderParked() {
    const tr = state.tracker, on = !!(tr && tr.parked_at);
    $('#park-btn').classList.toggle('on', on);
    $('#park-btn span').textContent = on ? t('park_btn_on') : t('park_btn');
    $('#parked-chip').hidden = !on;
    if (map.parkCircle) { map.m.removeLayer(map.parkCircle); map.parkCircle = null; }
    if (on && tr.parked_lat != null && state.tab === 'map' && !state.zoneEdit) {
      map.parkCircle = L.circle([tr.parked_lat, tr.parked_lng], { radius: 60, color: cssVar('--warn'), weight: 2, dashArray: '3 6', fillOpacity: 0.05, interactive: false }).addTo(map.m);
    }
  }

  // =====================================================================
  // FAMILY — invite family accounts to a bag, see who has access, leave / remove
  // =====================================================================
  async function inviteFamily(tr) {
    const { data, error } = await sb.rpc('create_member_invite', { p_tracker: tr.id });
    if (error || !data) { toast(errorText(error || {})); return; }
    const url = new URL('#join=' + data, location.href).href;
    const text = t('invite_text', { b: tr.name || tr.device_code, c: data });
    try {
      if (navigator.share) { await navigator.share({ title: 'Trackly', text, url }); return; }
      await navigator.clipboard.writeText(text + '\n' + url);
      toast(t('invite_copied', { c: data }));
    } catch (e) { toast(t('invite_copied', { c: data })); }
  }
  async function joinFamily(code) {
    const { data, error } = await sb.rpc('join_tracker', { p_code: code });
    if (error) { toast(errorText(error)); return; }
    if (!data) { toast(t('err_invite')); return; }
    toast(t('joined'));
    await loadTrackers();
    localStorage.setItem('trackly-tracker', data);
    if (!localStorage.getItem('trackly-setup-done')) localStorage.setItem('trackly-setup-done', '1');
    openApp();
  }
  async function renderMembers(tr, box) {
    const { data } = await sb.rpc('list_members', { p_tracker: tr.id });
    box.innerHTML = '';
    (data || []).forEach((m) => {
      const row = document.createElement('div');
      row.className = 'member';
      const who = document.createElement('span');
      who.textContent = m.email + (m.owner ? ' · ' + t('owner') : '') + (m.me ? ' · ' + t('you') : '');
      row.appendChild(who);
      const iAmOwner = tr.owner_id === (state.user && state.user.id);
      if (!m.owner && (iAmOwner || m.me)) {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'link-btn danger-text';
        b.textContent = m.me ? t('leave') : t('remove');
        b.addEventListener('click', async () => {
          if (!confirm(m.me ? t('leave_q') : t('remove_q', { e: m.email }))) return;
          const { error } = await sb.rpc('remove_member', { p_tracker: tr.id, p_user: m.user_id });
          if (error) { toast(errorText(error)); return; }
          if (m.me) { await loadTrackers(); route(); } else renderMembers(tr, box);
        });
        row.appendChild(b);
      }
      box.appendChild(row);
    });
  }
  async function unpair(tr) {
    if (!confirm(t('unpair_q', { b: tr.name || tr.device_code }))) return;
    const { error } = await sb.rpc('unpair_tracker', { p_tracker: tr.id });
    if (error) { toast(errorText(error)); return; }
    toast(t('unpaired'));
    localStorage.removeItem('trackly-tracker');
    await loadTrackers();
    route();
  }

  // =====================================================================
  // ERRORS + VISITS (real database only; no personal data in the counter)
  // =====================================================================
  function reportError(e) {
    if (CFG.fakeBackend) return;
    try { sb.rpc('log_client_error', { p_message: String((e && (e.stack || e.message)) || e).slice(0, 500), p_page: 'app' }); } catch (x) { /* ignore */ }
  }
  function countVisit() {
    if (CFG.fakeBackend || sessionStorage.getItem('trackly-counted')) return;
    sessionStorage.setItem('trackly-counted', '1');
    sb.rpc('count_visit', { p_page: 'app' });
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
      else if (a === 'find-nearby') openFind();
      else if (a === 'close-find') closeFind();
      else if (a === 'find-compass') startCompass(true);
      else if (a === 'find-sound') requestBuzz();
      else if (a === 'toggle-places') togglePlaces();
      else if (a === 'open-search') openSearch();
      else if (a === 'scan-qr') openScanner();
      else if (a === 'close-scan') closeScanner();
      else if (a === 'forgot') forgotPassword();
      else if (a === 'google') googleLogin();
      else if (a === 'push') togglePush();
      else if (a === 'left-behind') toggleLeftBehind();
      else if (a === 'park') togglePark();
      else if (a === 'join-family') { const c = $('#join-code').value.trim(); if (c) joinFamily(c); }
      else if (a === 'close-search') closeSearch();
      else if (a === 'confirm-lost') { closeConfirm(); if (await setMode('lost')) toast(t('toast_lost_on')); }
      else if (a === 'cancel-lost') closeConfirm();
      else if (a === 'found') { if (await setMode('normal')) toast(t('toast_found')); }
      else if (a === 'share') shareLive(4);
      else if (a === 'share-live') shareLive(Number(el.dataset.hours) || 4);
      else if (a === 'report') openReport();
      else if (a === 'close-report') closeReport();
      else if (a === 'print-report') window.print();
      else if (a === 'share-report') shareReport();
      else if (a === 'theme') applyTheme(el.dataset.themePick);
      else if (a === 'backend') setBackend(!CFG.fakeBackend ? false : true);
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
    $('#newpw-form').addEventListener('submit', saveNewPassword);
    $('#map-search').addEventListener('input', onMapSearch);
    $('#map-search').addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSearch(); });
    setupSheetDrag();
    $('#replay-range').addEventListener('input', (e) => { stopReplay(); setReplay(Number(e.target.value)); });
    $$('#zone-kinds .kind').forEach((b) => b.addEventListener('click', () => setKind(b.dataset.kind)));
    $('#zone-search').addEventListener('input', onZoneSearch);
    $('#zone-search').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.preventDefault(); });
    $$('#zone-notify .seg').forEach((b) => b.addEventListener('click', () => {
      state.zoneEdit.notify = b.dataset.notify;
      $$('#zone-notify .seg').forEach((x) => x.classList.toggle('active', x === b));
    }));
    $('#panel-zone-edit').addEventListener('submit', saveZone);

    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (!$('#confirm-lost').hidden) closeConfirm();
      if (!$('#find-view').hidden) closeFind();
    });

    setupHoldButton();

    // keep "updated X min ago" fresh
    setInterval(() => { if (state.tab === 'map' && !document.hidden) renderMapPanel(); }, 15000);

    sb.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_OUT') { unsubscribe(); showView('view-auth'); }
      if (event === 'PASSWORD_RECOVERY') $('#newpw-view').hidden = false;
    });
  }

  // ---------- start ----------
  function start() {
    applyTheme(localStorage.getItem('trackly-theme') || 'gold');
    takeLinkAction();
    // a card / invite link opened while Trackly is already open
    window.addEventListener('hashchange', () => {
      takeLinkAction();
      if (!state.user) return;
      if (sessionStorage.getItem('trackly-pending-join')) applyPendingJoin();
      else if (applyPendingPair()) { $('[data-action="pair-back"]').hidden = !state.trackers.length; showView('view-pair'); }
    });
    window.addEventListener('error', (e) => reportError(e.error || e.message));
    window.addEventListener('unhandledrejection', (e) => reportError(e.reason));
    $$('[data-kind-icon]').forEach((el) => { el.innerHTML = kindIcon(el.dataset.kindIcon); });
    bindEvents();
    $('#backend-state').textContent = CFG.fakeBackend ? t('backend_test') : t('backend_real');
    $('#backend-switch').setAttribute('aria-checked', String(!CFG.fakeBackend));
    applyLang();
    // remembered email: only the password is left to type (or the phone fills it in)
    const lastEmail = localStorage.getItem('trackly-last-email');
    if (lastEmail) $('#auth-email').value = lastEmail;
    initMap();
    map.m.on('move', syncEditCircle);
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
    $('#google-btn').hidden = !CFG.googleLogin;
    $('#behind-switch').setAttribute('aria-checked', String(leftBehindOn()));
    countVisit();
    route().then(() => {
      // left-behind needs the phone's location: start it quietly if the user already allowed it
      if (leftBehindOn() && navigator.permissions && state.tracker) navigator.permissions.query({ name: 'geolocation' }).then((p) => { if (p.state === 'granted') locateMe(false); }).catch(() => {});
    }).catch((e) => { reportError(e); showView('view-auth'); toast(t('err_generic')); });
  }

  start();
})();
