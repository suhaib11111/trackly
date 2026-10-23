/* Trackly web app
   Plain JavaScript, no build step. Uses Supabase (auth + database + realtime) and Leaflet (map). */
(function () {
  'use strict';

  const CFG = window.TRACKLY_CONFIG;
  // Test mode uses the pretend backend (js/fake-backend.js); otherwise the real Supabase
  const sb = CFG.fakeBackend ? window.createFakeSupabase() : window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey);
  const ERBIL = [36.1911, 44.0092];
  const LANGS = ['en', 'ckb', 'ar'];
  const APP_VERSION = '2026.10.23';

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
    el.classList.remove('has-action');
    el.hidden = false;
    requestAnimationFrame(() => el.classList.add('in'));   // pop in
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { el.classList.remove('in'); setTimeout(() => { if (!el.classList.contains('in')) el.hidden = true; }, 220); }, 3200);
  }

  // dialogs slide back down when they close
  function closeModal(el) {
    if (el.hidden || el.classList.contains('closing')) return;
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) { el.hidden = true; return; }
    el.classList.add('closing');
    setTimeout(() => { el.hidden = true; el.classList.remove('closing'); }, 220);
  }

  // numbers that change (battery %) count to the new value and pop a little
  function setStat(el, text) {
    if (el.textContent === text) return;
    const from = parseInt(el.textContent, 10), to = parseInt(text, 10);
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.classList.remove('bump'); void el.offsetWidth; if (!reduce && el.textContent !== '—' && el.textContent) el.classList.add('bump');
    if (!reduce && /^\d+%$/.test(text) && Number.isFinite(from) && from !== to && Math.abs(from - to) < 60) {
      const t0 = performance.now(), suffix = text.replace(/^\d+/, '');
      const step = (now) => { const k = Math.min(1, (now - t0) / 450); el.textContent = Math.round(from + (to - from) * k) + suffix; if (k < 1) requestAnimationFrame(step); };
      requestAnimationFrame(step);
    } else el.textContent = text;
  }

  // height of what covers the bottom of the map: the sheet + the tab bar
  function coverH() { return ($('#sheet') ? $('#sheet').offsetHeight : 0) + ($('#tabbar') && !$('#tabbar').hidden ? $('#tabbar').offsetHeight : 0); }

  function showView(id) {
    const go = () => $$('.view').forEach((v) => { v.hidden = v.id !== id; });
    const cur = $$('.view').find((v) => !v.hidden);
    if (document.startViewTransition && cur && cur.id !== id && cur.id !== 'view-loading' && !matchMedia('(prefers-reduced-motion: reduce)').matches) document.startViewTransition(go); else go();
    // the map was made while hidden: give it its real size, and let the vector map redraw all of it
    if (id === 'view-app' && map.m) [50, 400].forEach((ms) => setTimeout(() => { map.m.invalidateSize(); const gl = mapGl(); if (gl) { gl.resize(); gl.triggerRepaint(); } }, ms));
  }

  function errorText(err) {
    const msg = (err && (err.message || err.error_description)) || '';
    if (msg.includes('invalid_code')) return t('err_invalid_code');
    if (msg.includes('already_paired')) return t('err_already_paired');
    if (msg.includes('too_many')) return t('err_too_many');
    if (/rate limit|over_email_send_rate_limit/i.test(msg)) return t('err_email_limit');
    if (/email not confirmed/i.test(msg)) return t('err_not_confirmed');
    if (msg.toLowerCase().includes('invalid login')) return t('err_login');
    if (/could not find the function|does not exist|PGRST20[0-9]|schema cache/i.test(msg) || (err && /^PGRST2/.test(err.code || ''))) return t('err_needs_update');
    if (/failed to fetch|network|load failed/i.test(msg)) return t('err_offline');
    if (msg && msg.length < 100 && !/[_(){}]|sql|postgres|jwt/i.test(msg)) return msg;
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

  function isDark() {
    const s = localStorage.getItem('trackly-scheme');
    return s === 'dark' || (s !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  }
  function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

  // ---------- language ----------
  function applyLang() {
    const dict = window.I18N[state.lang];
    document.documentElement.lang = state.lang;
    document.documentElement.dir = dict._dir;
    $$('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
    $$('[data-i18n-ph]').forEach((el) => { el.placeholder = t(el.dataset.i18nPh); });
    $$('[data-i18n-aria]').forEach((el) => { el.setAttribute('aria-label', t(el.dataset.i18nAria)); });
    $$('.lang-btn').forEach((el) => { el.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z"/></svg><span></span>'; el.querySelector('span').textContent = dict._label; el.setAttribute('aria-label', t('language')); });
    $$('.lang-label').forEach((el) => { el.textContent = dict._label; });
    if ($('#acc-lang')) $('#acc-lang').textContent = { en: 'English', ckb: 'کوردی', ar: 'العربية' }[state.lang];
    updateAuthButton();
    state.areaKey = null;
    if (state.tracker) { renderMapPanel(); renderZones(); if (state.tab === 'history') loadHistory(); }
    if (map.m) { renderPlacesBar(); renderPlaces(); renderAlerts(); refreshMapLanguage(); }
  }

  const SETTING_KEYS = { theme: 'trackly-theme', lang: 'trackly-lang', mapStyle: 'trackly-map-style', showPath: 'trackly-show-path',
    places: 'trackly-places', cams: 'trackly-cams', camSound: 'trackly-cam-sound', stepsOn: 'trackly-steps-on', weight: 'trackly-weight', height: 'trackly-height', goal: 'trackly-goal',
    finder: 'trackly-finder', voice: 'trackly-voice', traffic: 'trackly-traffic', nightGuard: 'trackly-night-guard', unusual: 'trackly-unusual',
    car: 'trackly-car', reminders: 'trackly-reminders', scheme: 'trackly-scheme', size: 'trackly-size', favs: 'trackly-favs', routeMode: 'trackly-route-mode', leftBehind: 'trackly-left-behind', setupDone: 'trackly-setup-done', tracker: 'trackly-tracker' };
  function currentSettings() {
    const out = {};
    for (const [k, key] of Object.entries(SETTING_KEYS)) { const v = localStorage.getItem(key); if (v !== null) out[k] = v; }
    return out;
  }
  let settingsTimer = null, settingsLoaded = false;
  // save a moment after the last change (one request for several quick taps)
  function syncSettings() {
    if (!state.user || !settingsLoaded) return;
    clearTimeout(settingsTimer);
    settingsTimer = setTimeout(async () => {
      const s = currentSettings();
      const old = (state.user.user_metadata && state.user.user_metadata.settings) || {};
      if (JSON.stringify(s) === JSON.stringify(old)) return;
      const { data, error } = await sb.auth.updateUser({ data: { settings: s } });
      if (!error && data && data.user) state.user = data.user;
    }, 800);
  }
  // after login: the account's settings win over what this phone remembers
  function loadSettings() {
    const s = (state.user && state.user.user_metadata && state.user.user_metadata.settings) || null;
    settingsLoaded = true;
    if (!s) { syncSettings(); return; }               // first time: store this phone's settings in the account
    for (const [k, key] of Object.entries(SETTING_KEYS)) if (s[k] != null) localStorage.setItem(key, s[k]);
    if (s.theme) applyTheme(s.theme);
    if (s.lang && s.lang !== state.lang && LANGS.includes(s.lang)) { state.lang = s.lang; applyLang(); }
    if (s.mapStyle && s.mapStyle !== state.mapStyle && map.m) { state.mapStyle = s.mapStyle; setTiles(); }
    if (s.showPath != null) state.showPath = s.showPath === '1';
    if (s.places != null) places.on = s.places !== '0';
    if (s.cams != null) { cams.on = s.cams !== '0'; if (map.m) renderCams(); }
    $('#behind-switch').setAttribute('aria-checked', String(leftBehindOn()));
    renderStepsSettings(); renderCamSound(); renderFinder();
    renderVoice(); renderSmartSwitches(); renderTraffic(); drawCar(); renderReminders(); drawFavs();
    if (s.scheme) applyScheme(s.scheme, true);
    if (s.size) applySize(s.size, true);
    if (stepsOn()) startSteps(false);
  }

  function setLang(lang) {
    if (!LANGS.includes(lang)) return;
    state.lang = lang;
    localStorage.setItem('trackly-lang', lang);
    applyLang();
    syncSettings();
  }
  function openLangMenu() {
    $$('#lang-menu [data-lang]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.lang === state.lang)));
    $('#lang-menu').hidden = false;
    const cur = $('#lang-menu [aria-checked="true"]'); if (cur) cur.focus();
  }
  function closeLangMenu() { closeModal($('#lang-menu')); }

  // ---------- install the app + updates ----------
  let installEvent = null;
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvent = e; renderInstall(); });
  window.addEventListener('appinstalled', () => { installEvent = null; renderInstall(); toast(t('installed')); });
  function isInstalled() { return matchMedia('(display-mode: standalone)').matches || navigator.standalone === true; }
  function renderInstall() { const b = $('#install-btn'); if (b) b.hidden = isInstalled(); }
  async function installApp() {
    if (installEvent) { installEvent.prompt(); await installEvent.userChoice.catch(() => {}); installEvent = null; renderInstall(); return; }
    showView('view-setup');   // iPhone / no prompt: show the step-by-step guide
  }
  async function checkForUpdate() {
    toast(t('checking'));
    try {
      const reg = await navigator.serviceWorker.getRegistration(); if (reg) await reg.update();
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k.startsWith('trackly-app')).map((k) => caches.delete(k)));
    } catch (e) { /* offline */ }
    setTimeout(() => location.reload(), 600);
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
      if (await needsMfaCode()) {
        const passed = await askMfaCode();
        if (!passed) { await sb.auth.signOut(); return; }
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
    try { localStorage.removeItem(CACHE_KEY); } catch (e) { /* ignore */ }
    settingsLoaded = false;
    showView('view-auth');
  }

  // ---------- routing ----------
  async function route() {
    const { data } = await sb.auth.getSession();
    state.user = data.session ? data.session.user : null;
    if (!state.user) { showView('view-auth'); return; }
    if (await needsMfaCode()) {
      const passed = await askMfaCode();
      if (!passed) { await sb.auth.signOut(); state.user = null; showView('view-auth'); return; }
    }
    $('#account-email').textContent = state.user.email || '';
    loadSettings();
    const cached = readCache();
    if (cached && cached.trackers.length && localStorage.getItem('trackly-setup-done') && !sessionStorage.getItem('trackly-pending-join')) {
      state.trackers = cached.trackers; fillTrackerSelect();
      if ($('#view-app').hidden) openApp();
    }
    await loadTrackers();
    if (cached && state.trackers.length && !$('#view-app').hidden && state.trackers.some((x) => x.id === (state.tracker && state.tracker.id))) {
      state.tracker = state.trackers.find((x) => x.id === state.tracker.id); $('#tracker-select').value = state.tracker.id; renderMapPanel(); return;
    }
    if (sessionStorage.getItem('trackly-pending-join')) { await applyPendingJoin(); return; }
    if (!state.trackers.length) { renderSavedTrackers(); applyPendingPair(); showView('view-pair'); $('[data-action="pair-back"]').hidden = true; return; }
    if (!localStorage.getItem('trackly-setup-done')) { showView('view-setup'); return; }
    openApp();
  }

  async function loadTrackers() {
    let { data, error } = await sb.from('trackers').select(CFG.fakeBackend ? '*' : 'id, device_code, owner_id, name, mode, color, parked_at, parked_lat, parked_lng, parked_alerted, night_saver').order('created_at');
    if (error && !CFG.fakeBackend) ({ data, error } = await sb.from('trackers').select('id, device_code, owner_id, name, mode, color, parked_at, parked_lat, parked_lng, parked_alerted').order('created_at'));
    // older database (before update 003): ask only for the columns that exist there
    if (error && !CFG.fakeBackend) ({ data, error } = await sb.from('trackers').select('id, device_code, owner_id, name, mode, color').order('created_at'));
    if (error && !CFG.fakeBackend) ({ data, error } = await sb.from('trackers').select('id, device_code, owner_id, name, mode').order('created_at'));
    if (error) { toast(errorText(error)); state.trackers = []; return; }
    state.trackers = data || [];
    fillTrackerSelect();
    renderBags();
  }
  function fillTrackerSelect() {
    const sel = $('#tracker-select');
    const cur = sel.value;
    sel.innerHTML = '';
    state.trackers.forEach((tr) => {
      const o = document.createElement('option');
      o.value = tr.id;
      o.textContent = tr.name || tr.device_code;
      sel.appendChild(o);
    });
    if (cur && state.trackers.some((x) => x.id === cur)) sel.value = cur;
    document.querySelector('.bag-name-row').classList.toggle('multi', state.trackers.length > 1);
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
    localStorage.setItem('trackly-seen-version', APP_VERSION);
    syncSettings();
    if (state.trackers.length) openApp(); else showView('view-pair');
  }

  // ---------- map ----------
  function initMap() {
    if (map.m) return;
    map.m = L.map('map', { zoomControl: false, attributionControl: true, zoomSnap: 0.5, maxZoom: 20 }).setView(ERBIL, 14);
    L.control.scale({ imperial: false, position: 'bottomleft', maxWidth: 110 }).addTo(map.m);
    map.m.attributionControl.setPrefix(false);
    // Arabic / Kurdish letters on the map need this add-on to join up correctly (loaded only when needed)
    try { if (window.maplibregl && maplibregl.getRTLTextPluginStatus && maplibregl.getRTLTextPluginStatus() === 'unavailable') maplibregl.setRTLTextPlugin('https://cdn.jsdelivr.net/npm/@mapbox/mapbox-gl-rtl-text@0.2.3/mapbox-gl-rtl-text.min.js', true).catch(() => {}); } catch (e) { /* older engine */ }
    setTiles();
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (schemePref() === 'auto') { setTiles(); renderMapPanel(); } });
    map.m.on('dragstart', () => { if (!state.zoneEdit) { state.followBag = false; updateCenterBtn(); } });
    // while adding a safe zone, a tap on the map moves the pin there
    map.m.on('click', (e) => { $('#style-picker').hidden = true; if (state.zoneEdit) { placePinAt(e.latlng); return; } if (tapCam(e.latlng)) return; tapMapPlace(e.latlng); });
    map.m.on('contextmenu', (e) => { if (state.zoneEdit) return; showPlace({ id: 'pin', lat: e.latlng.lat, lng: e.latlng.lng, group: 'other', tags: { name: t('dropped_pin') } }); });
    map.zones = L.layerGroup().addTo(map.m);
    renderPlacesBar();
    let placesTimer = null;
    map.m.on('moveend zoomend', () => { clearTimeout(placesTimer); placesTimer = setTimeout(loadPlaces, 400); });
    // the floating map buttons sit just above the bottom card, whatever its height
    if (window.ResizeObserver) new ResizeObserver(() => {
      document.documentElement.style.setProperty('--sheet-h', coverH() + 'px');
      document.documentElement.style.setProperty('--tabbar-h', ($('#tabbar').hidden ? 0 : $('#tabbar').offsetHeight) + 'px');
      moveTabInk();
    }).observe($('#sheet'));
    // ...and when the tab bar shows / hides (zone editor)
    if (window.ResizeObserver) new ResizeObserver(() => {
      document.documentElement.style.setProperty('--tabbar-h', ($('#tabbar').hidden ? 0 : $('#tabbar').offsetHeight) + 'px');
      document.documentElement.style.setProperty('--sheet-h', coverH() + 'px');
    }).observe($('#tabbar'));
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
      if (st === 'detailed') {
        // start with the plain style, then swap in the tuned one as soon as it's built (a few ms after the first visit)
        const ready = libertyBase ? makeMapStyle(dark) : null;
        map.tiles = L.maplibreGL({ style: ready || 'https://tiles.openfreemap.org/styles/' + (dark ? 'dark' : 'liberty'), attribution: OFM_ATTR });
        const layer = map.tiles;
        if (!ready) buildMapStyle(dark).then((s) => { if (map.tiles === layer && layer.getMaplibreMap()) layer.getMaplibreMap().setStyle(s); }).catch(() => {});
      } else {
        map.tiles = L.maplibreGL({ style: 'https://tiles.openfreemap.org/styles/' + (dark ? 'dark' : 'positron'), attribution: OFM_ATTR });
      }
    } else {
      map.tiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 20, maxNativeZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
      });
    }
    map.tiles.addTo(map.m);
    const glNow = mapGl();
    if (glNow) { glNow.on('styledata', () => ensureCamLayers(glNow)); glNow.on('idle', () => ensureCamLayers(glNow)); }
    renderCams();
    // the CSS dark filter is only for the plain OpenStreetMap fallback
    map.m.getContainer().classList.toggle('map-dark', dark && raster && st !== 'sat' && st !== 'hybrid');
    // white text on photos needs a darker card behind the floating buttons
    map.m.getContainer().classList.toggle('map-photo', st === 'sat' || st === 'hybrid');
    map.m.getContainer().classList.toggle('map-navy', dark && !raster && st !== 'detailed');
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
    syncSettings();
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

  // the bag sits in the middle of the free part of the map (above the sheet), with a smooth flight
  function flyToBag(ll, zoomIn) {
    const z = zoomIn ? Math.max(map.m.getZoom(), 17) : Math.max(map.m.getZoom(), 16);
    const lift = Math.min(Math.max(coverH() - 90, 0) / 2, 260);
    const center = map.m.unproject(map.m.project(ll, z).add([0, lift]), z);
    const far = map.m.getCenter().distanceTo(center) > 3000 || Math.abs(map.m.getZoom() - z) > 2;
    if (far && !matchMedia('(prefers-reduced-motion: reduce)').matches) map.m.flyTo(center, z, { duration: 0.9 });
    else map.m.setView(center, z, { animate: true, duration: 0.6 });
  }
  function centerOnBag() {
    const loc = state.recent[0];
    if (!loc) { toast(t('no_location')); return; }
    state.followBag = true;
    map.followKey = null;
    updateCenterBtn();
    if (navigator.vibrate) navigator.vibrate(6);
    flyToBag(L.latLng(loc.lat, loc.lng), true);
  }
  function updateCenterBtn() {
    if ($('#btn-center')) $('#btn-center').classList.toggle('active', state.followBag);
    // the round 'Show my bag' button appears once you drag the map away
    const b = $('#back-to-bag');
    if (b) b.hidden = state.followBag || state.tab !== 'map' || !!state.zoneEdit || !state.recent[0] || rt.open;
  }

  // The phone's own location: blue dot, and "X km from you" on the card. forZone = move the zone pin there.
  // Live: after the first tap the blue dot keeps following you (watchPosition), and the
  // "X km from you" on the card updates as you walk. Tapping again shows you + the bag.
  let meWatch = null, meWaiting = null;
  function showMeAndBag() {
    state.followBag = false; updateCenterBtn();
    const loc = state.recent[0];
    if (loc) map.m.fitBounds(L.latLngBounds([[loc.lat, loc.lng], [state.me.lat, state.me.lng]]), { paddingTopLeft: [40, 120], paddingBottomRight: [40, coverH() + 40], maxZoom: 17, duration: 0.8 });
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
      const was = state.me;
      const now = { lat: pos.coords.latitude, lng: pos.coords.longitude, acc: pos.coords.accuracy };
      const h = pos.coords.heading;
      if (h != null && !isNaN(h) && (pos.coords.speed || 0) > 0.7) now.heading = h;
      else if (was && distanceM(was, now) > 8) now.heading = bearing(was, now);
      else now.heading = was ? was.heading : null;
      state.me = now;
      drawMe();
      if (meWaiting) {                            // first fix after a tap
        const w = meWaiting; meWaiting = null;
        if (w.forZone) placePinAt(L.latLng(state.me.lat, state.me.lng)); else if (w.fly) showMeAndBag();
      }
      if (!state.zoneEdit) renderMapPanel();
      renderFind();
      checkLeftBehind();
      checkCamAhead(pos);
      onDriveFix(pos);
      updateNav();
      checkMyZones();
    };
    // a quick first answer (the phone's last known spot), then live updates as you move
    navigator.geolocation.getCurrentPosition(onFix, () => {}, { maximumAge: 60000, timeout: 8000 });
    // no timeout: standing still for a while isn't an error. Only "not allowed" stops it.
    meWatch = navigator.geolocation.watchPosition(onFix, (err) => {
      if (err.code !== 1) return;
      toast(t('toast_no_gps'));
      navigator.geolocation.clearWatch(meWatch); meWatch = null; meWaiting = null;
      $('[data-action="locate-me"]').classList.remove('active');
    }, { enableHighAccuracy: true, maximumAge: 5000 });
  }
  // you on the map: a blue person pin that glides as you move, with an arrow for the way you're going
  function drawMe() {
    if (!state.me || !map.m) return;
    const ll = L.latLng(state.me.lat, state.me.lng);
    const r = Math.min(state.me.acc || 30, 300);
    if (!map.meDot) {
      map.meCircle = L.circle(ll, { radius: r, weight: 0, fillColor: '#3B82F6', fillOpacity: 0.12, interactive: false }).addTo(map.m);
      map.meDot = L.marker(ll, { keyboard: false, zIndexOffset: 950, title: t('me_title'), icon: L.divIcon({ className: '', iconSize: [40, 40], iconAnchor: [20, 20],
        html: '<div class="me-marker"><span class="me-heading" hidden></span><span class="me-core"><svg viewBox="0 0 24 24"><circle cx="12" cy="7.5" r="3.5"/><path d="M5 20a7 7 0 0 1 14 0"/></svg></span></div>' }) }).on('click', showMeCard).addTo(map.m);
    } else { moveMarker(map.meDot, ll); moveMarker(map.meCircle, ll); map.meCircle.setRadius(r); }
    const el = map.meDot.getElement() && map.meDot.getElement().querySelector('.me-heading');
    if (el) { el.hidden = state.me.heading == null; if (state.me.heading != null) el.style.transform = 'rotate(' + Math.round(state.me.heading) + 'deg)'; }
  }
  function showMeCard() {
    if (!state.me) return;
    const box = document.createElement('div');
    box.className = 'bi';
    box.innerHTML = '<div class="pl-head"><span class="place-dot big" style="--c:#3B82F6"><svg viewBox="0 0 24 24"><circle cx="12" cy="7.5" r="3.5"/><path d="M5 20a7 7 0 0 1 14 0"/></svg></span><div><strong class="bi-title"></strong><span class="pl-type"></span></div></div>' +
      '<div class="bi-actions"><button type="button" class="btn btn-secondary" data-m="car"></button><button type="button" class="btn btn-primary" data-m="both"></button></div>';
    box.querySelector('.bi-title').textContent = t('me_title');
    const loc = state.recent[0];
    box.querySelector('.pl-type').textContent = '± ' + fmtDistance(state.me.acc || 0) + (loc ? ' · ' + (distanceM(state.me, loc) < 15 ? t('with_you') : t('me_bag', { d: fmtDistance(distanceM(state.me, loc)) })) : '');
    box.querySelector('[data-m="car"]').textContent = t('me_park');
    box.querySelector('[data-m="both"]').textContent = t('me_both');
    box.querySelector('[data-m="car"]').addEventListener('click', () => { map.m.closePopup(); saveCar(state.me, false); });
    box.querySelector('[data-m="both"]').addEventListener('click', () => { map.m.closePopup(); showMeAndBag(); });
    L.popup({ className: 'bag-popup', maxWidth: 280, offset: [0, -14], autoPanPaddingTopLeft: [16, 130] }).setLatLng([state.me.lat, state.me.lng]).setContent(box).openOn(map.m);
  }

  function openDirections() {
    const loc = state.recent[0];
    if (!loc) return;
    openRoute(loc, state.tracker.name || state.tracker.device_code);
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
      '<dt data-k="battery_left"></dt><dd id="bi-batt"></dd>' +
      '</dl>' +
      '<div class="bi-actions"><button type="button" class="btn btn-secondary" id="bi-copy"></button><button type="button" class="btn btn-primary" id="bi-maps"></button></div>';
    box.querySelectorAll('[data-k]').forEach((x) => { x.textContent = t(x.dataset.k); });
    box.querySelector('.bi-title').textContent = state.tracker ? (state.tracker.name || state.tracker.device_code) : '';
    box.querySelector('#bi-address').textContent = $('#bag-area').textContent;
    box.querySelector('#bi-copy').textContent = t('copy');
    box.querySelector('#bi-maps').textContent = t('directions');
    const copy = async () => {
      const l = state.bagInfo.loc;
      const text = l.lat.toFixed(6) + ', ' + l.lng.toFixed(6);
      try { await navigator.clipboard.writeText(text); toast(t('copied')); } catch (e) { toast(text); }
    };
    box.querySelector('#bi-copy').addEventListener('click', copy);
    box.querySelector('#bi-coords').addEventListener('click', copy);
    box.querySelector('#bi-maps').addEventListener('click', () => openRoute(state.bagInfo.loc, state.tracker ? (state.tracker.name || state.tracker.device_code) : ''));
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
    document.getElementById('bi-batt').textContent = batteryLeftText(i.loc.battery, state.tracker && state.tracker.mode === 'lost') || '—';
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
    syncSettings();
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
    requestAnimationFrame(moveTabInk);
    if (!openApp.labelled) { openApp.labelled = true; setTimeout(showFabLabels, 900); }
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
    syncSettings();
    state.followBag = true;
    state.areaKey = null;
    const cached = readCache();
    if (cached && cached.trackerId === id && cached.recent.length) { state.recent = cached.recent; state.zones = cached.zones || []; renderMapPanel(); renderZones(); }
    else { state.recent = []; $('#panel-map').classList.add('loading'); }

    const [locs, zones] = await Promise.all([
      sb.from('locations').select('lat, lng, battery, created_at').eq('tracker_id', id).order('created_at', { ascending: false }).limit(60),
      sb.from('safe_zones').select('*').eq('tracker_id', id).order('created_at')
    ]);
    if (locs.error) toast(errorText(locs.error));
    $('#panel-map').classList.remove('loading');
    if (!locs.error) state.recent = locs.data || [];
    if (!zones.error) state.zones = zones.data || [];
    saveCache();

    state.channel = sb.channel('tracker-' + id)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'locations', filter: 'tracker_id=eq.' + id }, (payload) => {
        const before = state.recent[0];
        state.recent.unshift(payload.new);
        if (state.recent.length > 200) state.recent.length = 200;
        checkAlerts(before, payload.new);
        renderMapPanel();
        saveCacheSoon();
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
    updateBadge(tr, loc);

    $('#bag-name').textContent = tr.name || tr.device_code;
    $('#lost-label').hidden = !lost;
    $('#live-badge').hidden = !lost;
    $('#silent-note').hidden = !lost;
    $('#normal-actions').hidden = lost;
    $('#hold-help').hidden = lost;
    $('#hold-lost').hidden = lost;
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
      renderHealth(null);
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
    checkNightMove(tr, loc, moving);
    checkUnusual(tr, loc, moving, stale);
    loadWeather();

    // texts
    $('#nosignal-note').hidden = !stale;
    if (stale) {
      $('#nosignal-note').textContent = t('nosignal_text', { t: relTime(age) });
      if (!lost) chip.textContent = t('no_signal');
    }
    const battery = typeof loc.battery === 'number' ? loc.battery : null;
    setStat($('#stat-battery'), battery === null ? '—' : battery + '%');
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
    renderHealth(loc, { lost, stale, age, battery, inZone, moving, kmh });
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
    const followKey = loc.lat.toFixed(5) + ',' + loc.lng.toFixed(5) + ':' + state.snap + ':' + state.tab;
    if (state.followBag && state.tab === 'map' && !state.zoneEdit && map.followKey !== followKey) {
      map.followKey = followKey;
      flyToBag(ll, false);
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
      if (navigator.vibrate) navigator.vibrate(15);
      timer = setTimeout(() => { stop(); if (navigator.vibrate) navigator.vibrate(50); openConfirm(); }, 2000);
    };
    const stop = () => { clearTimeout(timer); timer = null; btn.classList.remove('holding'); };
    btn.addEventListener('pointerdown', start);
    ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => btn.addEventListener(ev, stop));
    btn.addEventListener('contextmenu', (e) => e.preventDefault());
    // keyboard users: Enter / Space opens the confirmation directly
    btn.addEventListener('click', (e) => { if (e.detail === 0) openConfirm(); });
  }

  function openConfirm() { $('#confirm-lost').hidden = false; $('[data-action="confirm-lost"]').focus(); }
  function closeConfirm() { closeModal($('#confirm-lost')); }

  async function setMode(mode) {
    const before = state.tracker.mode;
    state.tracker.mode = mode;       // show it right away
    state.followBag = true;
    renderMapPanel();
    const { error } = await sb.rpc('set_tracker_mode', { p_tracker: state.tracker.id, p_mode: mode });
    if (error) { state.tracker.mode = before; renderMapPanel(); toast(errorText(error)); return false; }   // undo
    return true;
  }

  // a Trackly link for a spot: opens place.html (map + directions), never another map app
  function placeLink(lat, lng, name) {
    return new URL('place.html#' + (+lat).toFixed(6) + ',' + (+lng).toFixed(6) + ',' + encodeURIComponent(String(name || '').slice(0, 60)), location.href).href;
  }

  async function shareLocation() {
    const loc = state.recent[0];
    if (!loc) return;
    const url = placeLink(loc.lat, loc.lng, state.tracker ? (state.tracker.name || state.tracker.device_code) : '');
    try {
      if (navigator.share) { await navigator.share({ title: 'Trackly', text: t('share_text'), url }); return; }
      await navigator.clipboard.writeText(url);
      toast(t('toast_link_copied'));
    } catch (e) { /* user closed the share sheet */ }
  }

  // ---------- tabs ----------
  const TAB_ORDER = ['map', 'history', 'zones', 'account'];
  function switchTab(tab) {
    const prev = state.tab;
    const sheet = $('#sheet');
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const h0 = sheet.offsetHeight;
    doSwitchTab(tab);
    moveTabInk();
    if (prev === tab || reduce || !map.m) return;
    if (navigator.vibrate) navigator.vibrate(5);
    // slide the new panel in from the side it's on (mirrored in Arabic / Kurdish)
    let dir = TAB_ORDER.indexOf(tab) > TAB_ORDER.indexOf(prev) ? 1 : -1;
    if (document.documentElement.dir === 'rtl') dir = -dir;
    const panel = $('#panel-' + tab);
    if (panel) { panel.classList.remove('slide-fwd', 'slide-back'); void panel.offsetWidth; panel.classList.add(dir > 0 ? 'slide-fwd' : 'slide-back'); }
    // the sheet grows / shrinks smoothly to the new content
    const h1 = sheet.offsetHeight;
    if (Math.abs(h1 - h0) > 4) {
      sheet.style.height = h0 + 'px'; void sheet.offsetHeight;
      sheet.classList.add('resizing'); sheet.style.height = h1 + 'px';
      clearTimeout(switchTab._t);
      switchTab._t = setTimeout(() => { sheet.classList.remove('resizing'); sheet.style.height = ''; }, 320);
    }
  }
  // the highlight behind the active tab glides to it (spring)
  function moveTabInk() {
    const ink = document.querySelector('.tab-ink'), active = document.querySelector('.tab.active');
    if (!ink || !active) return;
    const bar = $('#tabbar').getBoundingClientRect(), r = active.getBoundingClientRect();
    if (!bar.width) return;
    ink.style.width = r.width + 'px';
    ink.style.transform = 'translateX(' + (r.left - bar.left) + 'px)';
  }
  window.addEventListener('resize', () => moveTabInk());
  function doSwitchTab(tab) {
    if (tab !== 'map' && rt.open && !rt.nav) { rt.open = false; rt.seq++; clearRouteLayer(); }
    state.tab = tab;
    $$('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    $('#panel-map').hidden = tab !== 'map' || rt.open;
    $('#panel-route').hidden = tab !== 'map' || !rt.open;
    $('#panel-history').hidden = tab !== 'history';
    $('#panel-zones').hidden = tab !== 'zones';
    $('#panel-account').hidden = tab !== 'account';
    $('#history-days').hidden = tab !== 'history';

    if (map.history) { map.m.removeLayer(map.history); map.history = null; }
    map.zones.clearLayers();
    map.m.closePopup();
    stopReplay();
    $('#style-picker').hidden = true;

    if (tab === 'history') { loadHistory(); loadWeekly(); }
    if (tab !== 'map') $('#speedo').hidden = true;
    if (tab === 'zones') drawZones(true);
    if (tab === 'map') { state.followBag = !rt.open; drawZones(false); }
    if (tab === 'zones') renderReminders();
    renderWeather();
    $('#map-controls').hidden = tab === 'history' || tab === 'account';
    if (tab === 'account') { renderAlerts(); renderBags(); renderPushSwitch(); renderMfa(); renderAdminLink(); }
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
    renderActivity();
    await loadCams();
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
    Object.assign(act.bag, bagActivity(pts));
    renderActivity();
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
    const sheetH = coverH();
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
    const drives = findDrives(pts);
    drives.forEach((dr) => events.push({ time: dr.from, title: t('drive'), sub: driveText(dr) + ' · ' + clockTime(dr.from) + '–' + clockTime(dr.to), drive: dr }));
    events.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
    if (stops.length) $('#history-summary').textContent += ' · ' + t('stops_n', { n: stops.length });
    if (drives.length) $('#history-summary').textContent += ' · ' + t('drives_n', { n: drives.length });
    events.forEach((ev) => {
      const li = document.createElement('li');
      if (ev.stop) { li.className = 'is-stop'; li.dataset.n = ev.n; }
      if (ev.drive) { li.className = 'is-drive'; li.addEventListener('click', () => map.m.fitBounds(L.latLngBounds(ev.drive.pts.map((q) => [q.lat, q.lng])), { paddingTopLeft: [32, 140], paddingBottomRight: [32, coverH() + 24], maxZoom: 16 })); }
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
    renderReminders();
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
      map.m.flyToBounds(b, { paddingTopLeft: [32, 120], paddingBottomRight: [32, coverH() + 24], maxZoom: 16, duration: 0.8 });
    }
  }

  async function toggleZone(z) {
    z.enabled = !z.enabled;          // show it right away
    renderZones();
    if (navigator.vibrate) navigator.vibrate(8);
    const { error } = await sb.from('safe_zones').update({ enabled: z.enabled }).eq('id', z.id);
    if (error) { z.enabled = !z.enabled; renderZones(); toast(errorText(error)); return; }   // undo
    saveCache();
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
    setSnap('half');
    $('#sheet').scrollTop = 0;
    $('#tabbar').hidden = true;
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
    $('#tabbar').hidden = false;
    requestAnimationFrame(moveTabInk);
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
  // SPEED CAMERAS — 880 cameras in Iraq + border areas (OpenStreetMap), saved in data/speed-cameras.json
  // Drawn by the map engine like small speed-limit signs; tap one for its card.
  // With "My location" on and driving, a warning comes ~400 m before a camera.
  // =====================================================================
  const cams = { list: null, on: localStorage.getItem('trackly-cams') !== '0', warned: {} };
  async function loadCams() {
    if (cams.list) return cams.list;
    try { const r = await fetch('data/speed-cameras.json'); cams.list = (await r.json()).cameras || []; } catch (e) { cams.list = []; }
    return cams.list;
  }
  function camGeoJSON() {
    return { type: 'FeatureCollection', features: (cams.list || []).map((c, i) => ({ type: 'Feature', id: i,
      geometry: { type: 'Point', coordinates: [c[1], c[0]] }, properties: { limit: c[2] ? String(c[2]) : '' } })) };
  }
  // vector map: a source + 2 layers (the sign, and the number on it); added again after every style change
  function ensureCamLayers(gl) {
    try {
      if (!cams.list || !gl.getStyle()) return;   // (adding too early simply throws and is retried on the next "idle")
      if (!gl.getSource('trackly-cams')) gl.addSource('trackly-cams', { type: 'geojson', data: camGeoJSON() });
      const vis = cams.on ? 'visible' : 'none';
      if (!gl.getLayer('trackly-cams-sign')) {
        gl.addLayer({ id: 'trackly-cams-sign', type: 'circle', source: 'trackly-cams', minzoom: 8,
          paint: { 'circle-color': '#ffffff', 'circle-stroke-color': '#D93A3F',
            'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 3, 12, 7, 16, 11],
            'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 8, 1.5, 12, 2.5, 16, 3.5] } });
        gl.addLayer({ id: 'trackly-cams-limit', type: 'symbol', source: 'trackly-cams', minzoom: 11.5,
          layout: { 'text-field': ['get', 'limit'], 'text-font': ['Noto Sans Bold'], 'text-size': ['interpolate', ['linear'], ['zoom'], 12, 9, 16, 12],
            'text-allow-overlap': true, 'text-ignore-placement': true },
          paint: { 'text-color': '#111111' } });
      }
      for (const id of ['trackly-cams-sign', 'trackly-cams-limit']) if ((gl.getLayoutProperty(id, 'visibility') || 'visible') !== vis) gl.setLayoutProperty(id, 'visibility', vis);
    } catch (e) { /* style still loading */ }
  }
  // satellite views (no vector engine): the same signs drawn by Leaflet on a canvas (fast with many points)
  function drawRasterCams() {
    if (map.camsRaster) { map.m.removeLayer(map.camsRaster); map.camsRaster = null; }
    if (!cams.on || !cams.list || mapGl() || state.tab === 'history') return;
    const r = L.canvas({ padding: 0.3 }), g = L.layerGroup();
    cams.list.forEach((c) => L.circleMarker([c[0], c[1]], { renderer: r, radius: 7, color: '#D93A3F', weight: 3, fillColor: '#fff', fillOpacity: 1 })
      .on('click', () => showCam(c[0], c[1], c[2])).addTo(g));
    map.camsRaster = g.addTo(map.m);
  }
  async function renderCams() {
    await loadCams();
    const gl = mapGl();
    if (gl) { if (map.camsRaster) { map.m.removeLayer(map.camsRaster); map.camsRaster = null; } ensureCamLayers(gl); } else drawRasterCams();
    if ($('#btn-cams')) $('#btn-cams').setAttribute('aria-checked', String(cams.on));
  }
  function toggleCams() {
    cams.on = !cams.on;
    localStorage.setItem('trackly-cams', cams.on ? '1' : '0');
    syncSettings();
    renderCams();
    toast(cams.on ? t('cams_on') : t('cams_off'));
  }
  function showCam(lat, lng, limit) {
    const box = document.createElement('div');
    box.className = 'bi';
    box.innerHTML = '<div class="pl-head"><span class="cam-sign"></span><div><strong class="bi-title"></strong><span class="pl-type"></span></div></div>';
    box.querySelector('.cam-sign').textContent = limit || '!';
    box.querySelector('.bi-title').textContent = t('cam_title');
    box.querySelector('.pl-type').textContent = limit ? t('cam_limit', { n: limit }) : t('cam_no_limit');
    L.popup({ className: 'bag-popup', maxWidth: 260, offset: [0, -6] }).setLatLng([lat, lng]).setContent(box).openOn(map.m);
  }
  function tapCam(latlng) {
    const gl = mapGl();
    if (!gl || !cams.on || !gl.getLayer('trackly-cams-sign')) return false;
    const pt = gl.project([latlng.lng, latlng.lat]);
    const f = gl.queryRenderedFeatures([[pt.x - 12, pt.y - 12], [pt.x + 12, pt.y + 12]], { layers: ['trackly-cams-sign'] })[0];
    if (!f) return false;
    const [lng, lat] = f.geometry.coordinates;
    showCam(lat, lng, f.properties.limit);
    return true;
  }
  // driving with "My location" on: warn once per camera, about 400 m before it, only while moving fast
  function checkCamAhead(pos) {
    if (!cams.on || !cams.list || !pos || !state.me) return;
    const speed = pos.coords.speed;                      // metres per second (may be unknown)
    if (speed !== null && speed !== undefined && speed < 8) return;   // under ~30 km/h: walking, not driving
    if (speed === null || speed === undefined) return;
    let best = null;
    for (const c of cams.list) {
      if (Math.abs(c[0] - state.me.lat) > 0.006 || Math.abs(c[1] - state.me.lng) > 0.008) continue;
      const d = distanceM(state.me, { lat: c[0], lng: c[1] });
      if (d < 400 && (!best || d < best.d)) best = { c, d };
    }
    if (!best) return;
    const key = best.c[0] + ',' + best.c[1];
    if (cams.warned[key] && Date.now() - cams.warned[key] < 5 * 60e3) return;
    cams.warned[key] = Date.now();
    if (navigator.vibrate) navigator.vibrate([120, 60, 120]);
    if (!voiceOn()) beep('cam');
    say((lang) => best.c[2] ? tIn(lang, 'v_cam_limit', { n: best.c[2] }) : tIn(lang, 'v_cam'), null, false, 2);
    toast(best.c[2] ? t('cam_ahead_limit', { d: fmtDistance(best.d), n: best.c[2] }) : t('cam_ahead', { d: fmtDistance(best.d) }));
  }

  // =====================================================================
  // ACTIVITY — steps, distance walked, calories and active minutes
  // Steps: this phone's motion sensor while Trackly is open (Account → Count my steps), and all day,
  // without the phone, an estimate from the bag's walks (its walking-speed parts ÷ a 0.75 m step).
  // The day shows whichever is higher, so steps are never counted twice.
  // =====================================================================
  // step length from your height (about 41.5 % of it), 0.75 m if it isn't set
  const heightCm = () => { const h = Number(localStorage.getItem('trackly-height')); return h >= 100 && h <= 230 ? h : 0; };
  const stepLen = () => (heightCm() ? heightCm() * 0.415 / 100 : 0.75);
  const act = { bag: {}, sensor: false, gotEvent: false, needTap: false, lastPeak: 0, run: 0, pending: 0, smooth: 9.8, mean: 9.8, dev: 0.8, above: false, today: null, saveTimer: null, drawTimer: null };
  const dayKey = (d) => { const x = new Date(d); return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0'); };
  const weightKg = () => Math.min(250, Math.max(25, Number(localStorage.getItem('trackly-weight')) || 70));
  const stepGoal = () => Math.min(50000, Math.max(1000, Number(localStorage.getItem('trackly-goal')) || 8000));
  const stepsOn = () => localStorage.getItem('trackly-steps-on') === '1';
  const fmtNum = (n) => Math.round(n).toLocaleString('en-US');
  const zeros = () => new Array(24).fill(0);
  // how hard walking is at a speed (MET): a stroll ~2.3, normal ~3.5, brisk ~5
  const walkMet = (kmh) => (kmh < 3.2 ? 2.3 : kmh < 4.5 ? 3 : kmh < 5.5 ? 3.6 : kmh < 6.5 ? 4.3 : 5);
  function phoneSteps() { try { return JSON.parse(localStorage.getItem('trackly-steps')) || {}; } catch (e) { return {}; } }
  function savePhoneSteps() {
    const all = phoneSteps();
    if (act.today) all[act.today.k] = { s: act.today.s, m: act.today.m, h: act.today.h };
    const keys = Object.keys(all).sort();
    while (keys.length > 60) delete all[keys.shift()];
    try { localStorage.setItem('trackly-steps', JSON.stringify(all)); } catch (e) { /* storage full */ }
  }
  function addSteps(n) {
    const now = new Date(), k = dayKey(now), minute = Math.floor(now.getTime() / 60000);
    if (!act.today || act.today.k !== k) { const d = phoneSteps()[k] || { s: 0, m: 0 }; act.today = { k, s: d.s, m: d.m, h: d.h || zeros(), lm: 0 }; }
    const before = act.today.s;
    act.today.s += n;
    act.today.h[now.getHours()] += n;
    if (act.today.lm !== minute) { act.today.lm = minute; act.today.m++; }
    if (before < stepGoal() && act.today.s >= stepGoal()) { toast(t('goal_done')); if (navigator.vibrate) navigator.vibrate([80, 60, 80, 60, 160]); }
    clearTimeout(act.saveTimer); act.saveTimer = setTimeout(savePhoneSteps, 3000);
    if (state.tab === 'history' && !act.drawTimer) act.drawTimer = setTimeout(() => { act.drawTimer = null; renderActivity(); }, 1000);
  }
  // a step = a peak in the phone's movement. The level adapts to how the phone is carried (hand, pocket, bag),
  // and only runs of 6+ steps count, so picking the phone up or a bumpy car isn't walking.
  function onMotion(e) {
    const a = e.accelerationIncludingGravity;
    if (!a || a.x == null) return;
    act.gotEvent = true;
    const mag = Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
    act.smooth = act.smooth * 0.7 + mag * 0.3;
    act.mean = act.mean * 0.98 + act.smooth * 0.02;
    act.dev = act.dev * 0.98 + Math.abs(act.smooth - act.mean) * 0.02;
    const hi = act.mean + Math.max(0.9, act.dev * 1.1), lo = act.mean + 0.25;
    if (act.above) { if (act.smooth < lo) act.above = false; return; }
    if (act.smooth < hi) return;
    act.above = true;
    const now = Date.now(), gap = now - act.lastPeak;
    if (gap < 300) return;                       // too fast to be a step: shaking
    act.lastPeak = now;
    if (gap > 2000) { act.run = 1; act.pending = 1; return; }
    act.run++; act.pending++;
    if (act.run >= 6) { addSteps(act.pending); act.pending = 0; }
  }
  async function startSteps(fromTap) {
    if (act.sensor) return true;
    if (!('DeviceMotionEvent' in window)) return false;
    // iPhone asks for permission, and only after a tap
    if (fromTap && typeof DeviceMotionEvent.requestPermission === 'function') {
      try { if ((await DeviceMotionEvent.requestPermission()) !== 'granted') return false; } catch (e) { return false; }
    }
    window.addEventListener('devicemotion', onMotion);
    act.sensor = true;
    setTimeout(() => {                          // no readings: an iPhone that needs a tap again
      if (act.sensor && !act.gotEvent && typeof DeviceMotionEvent.requestPermission === 'function') { stopSteps(); act.needTap = true; renderActivity(); }
    }, 2500);
    return true;
  }
  function stopSteps() {
    window.removeEventListener('devicemotion', onMotion);
    act.sensor = false;
    if (act.today) savePhoneSteps();
  }
  async function toggleSteps() {
    if (stepsOn()) { localStorage.setItem('trackly-steps-on', '0'); stopSteps(); act.needTap = false; }
    else if (await startSteps(true)) {
      localStorage.setItem('trackly-steps-on', '1');
      act.needTap = false;
      setTimeout(() => { if (stepsOn() && !act.gotEvent) toast(t('steps_no')); }, 3000);
    } else toast(t('steps_no'));
    syncSettings(); renderStepsSettings(); renderActivity();
  }
  async function resumeSteps() { if (await startSteps(true)) { act.needTap = false; renderActivity(); } }
  function renderStepsSettings() {
    if ($('#steps-switch')) $('#steps-switch').setAttribute('aria-checked', String(stepsOn()));
    for (const [id, key] of [['#act-weight', 'trackly-weight'], ['#act-height', 'trackly-height'], ['#act-goal', 'trackly-goal']]) {
      if ($(id) && document.activeElement !== $(id)) $(id).value = localStorage.getItem(key) || '';
    }
  }
  // the bag's walking parts (1.5–7 km/h) per day and per hour, with the calories at that speed
  function bagActivity(pts) {
    const out = {}, kg = weightKg();
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      const s = (new Date(b.created_at) - new Date(a.created_at)) / 1000;
      if (s <= 0 || s > 6 * 60) continue;
      const d = distanceM(a, b), kmh = d / s * 3.6;
      if (d < 15 || kmh < 1.5 || kmh > 7) continue;
      const k = dayKey(b.created_at);
      const o = out[k] || (out[k] = { walkM: 0, walkS: 0, kcal: 0, h: zeros() });
      o.walkM += d; o.walkS += s;
      o.kcal += (walkMet(kmh) - 1) * kg * s / 3600;             // active calories (above resting)
      o.h[new Date(b.created_at).getHours()] += d;
    }
    return out;
  }
  function dayActivity(k) {
    const p = (act.today && act.today.k === k) ? act.today : phoneSteps()[k];
    const b = act.bag[k], L = stepLen();
    const phone = p ? p.s : 0, bagSteps = b ? Math.round(b.walkM / L) : 0;
    const usePhone = phone > 0 && phone >= bagSteps;
    const steps = Math.max(phone, bagSteps);
    const km = usePhone ? phone * L / 1000 : (b ? b.walkM / 1000 : 0);
    const mins = usePhone ? p.m : (b ? Math.round(b.walkS / 60) : 0);
    let kcal = 0;
    if (usePhone) { const hrs = Math.max(1, p.m) / 60; kcal = (walkMet(km / hrs) - 1) * weightKg() * hrs; }
    else if (b) kcal = b.kcal != null ? b.kcal : km * weightKg() * 0.5;
    const hours = usePhone ? (p.h || zeros()) : (b && b.h ? b.h.map((m) => m / L) : zeros());
    return { steps, km, mins, kcal: Math.round(kcal), hours, src: steps ? (usePhone ? 'phone' : 'bag') : '' };
  }
  function renderActivity() {
    const card = $('#act-card');
    if (!card) return;
    const [start] = historyRange();
    const k = dayKey(start), isToday = k === dayKey(Date.now());
    const d = dayActivity(k), goal = stepGoal();
    $('#act-title').textContent = isToday ? t('act_today') : start.toLocaleDateString(state.lang === 'en' ? 'en-GB' : (state.lang === 'ar' ? 'ar-IQ-u-nu-latn' : 'ckb-IQ-u-nu-latn'), { weekday: 'long', day: 'numeric', month: 'short' });
    $('#act-steps').textContent = fmtNum(d.steps);
    $('#act-goal-txt').textContent = t('act_goal', { n: fmtNum(goal) });
    $('#act-km').textContent = d.km ? fmtDistance(d.km * 1000) : '—';
    $('#act-kcal').textContent = d.kcal ? fmtNum(d.kcal) : '—';
    $('#act-min').textContent = d.mins ? fmtDuration(d.mins) : '—';
    const ring = $('#act-ring-fg'), len = 2 * Math.PI * 52;
    ring.style.strokeDasharray = len;
    ring.style.strokeDashoffset = len * (1 - Math.min(1, d.steps / goal));
    card.classList.toggle('done', d.steps >= goal);
    $('#act-src').textContent = d.src === 'phone' ? t('act_src_phone') : (d.src === 'bag' ? t('act_src_bag') : (stepsOn() ? t('act_src_wait') : t('act_src_none')));
    $('#act-resume').hidden = !(act.needTap && stepsOn() && isToday);
    // when you walked: 24 small bars, one per hour
    const hb = $('#act-hours'), maxH = Math.max(...d.hours);
    hb.hidden = !d.steps;
    if (d.steps) {
      hb.querySelector('.act-hbars').innerHTML = d.hours.map((v, h) => '<i style="height:' + (v ? Math.max(8, v / maxH * 100) : 3) + '%"' + (v ? ' class="on"' : '') + ' title="' + String(h).padStart(2, '0') + ':00 · ' + fmtNum(v) + '"></i>').join('');
      const peak = d.hours.indexOf(maxH);
      hb.querySelector('.act-hpeak').textContent = t('act_peak', { t: String(peak).padStart(2, '0') + ':00' });
    }
    // the last 7 days as bars, the dashed line is the goal
    const days = [];
    for (let i = 6; i >= 0; i--) { const x = new Date(); x.setHours(12, 0, 0, 0); x.setDate(x.getDate() - i); days.push(x); }
    const vals = days.map((x) => dayActivity(dayKey(x)).steps);
    const top = Math.max(goal * 1.15, ...vals);
    const wk = $('#act-week');
    wk.innerHTML = '';
    wk.style.setProperty('--goal', (goal / top).toFixed(3));
    days.forEach((x, i) => {
      const col = document.createElement('div');
      col.className = 'act-bar' + (dayKey(x) === k ? ' sel' : '') + (vals[i] >= goal ? ' hit' : '');
      col.innerHTML = '<span class="bar"><i></i></span><b></b>';
      col.querySelector('i').style.height = Math.max(vals[i] ? 4 : 0, vals[i] / top * 100) + '%';
      col.querySelector('b').textContent = state.lang === 'ckb' ? 'یدسچپهش'[x.getDay()] : x.toLocaleDateString(state.lang === 'en' ? 'en-GB' : 'ar', { weekday: 'narrow' });
      col.title = fmtNum(vals[i]) + ' ' + t('steps');
      wk.appendChild(col);
    });
    const avg = vals.reduce((a, b) => a + b, 0) / 7;
    if ($('#week-steps')) $('#week-steps').textContent = avg ? fmtNum(avg) : '—';
  }

  // =====================================================================
  // DRIVES — parts of the bag's path faster than 15 km/h (a stop of 5 min+ ends one),
  // with distance, time, top speed and the speed cameras on the way
  // =====================================================================
  function segDist(c, a, b, kx, ky) {
    const ax = (a.lng - c[1]) * kx, ay = (a.lat - c[0]) * ky, bx = (b.lng - c[1]) * kx, by = (b.lat - c[0]) * ky;
    const dx = bx - ax, dy = by - ay, len = dx * dx + dy * dy;
    const u = len ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len)) : 0;
    return Math.hypot(ax + u * dx, ay + u * dy);
  }
  function camsOnPath(pts) {
    if (!cams.list || pts.length < 2) return 0;
    let minLat = 90, maxLat = -90, minLng = 180, maxLng = -180;
    for (const p of pts) { minLat = Math.min(minLat, p.lat); maxLat = Math.max(maxLat, p.lat); minLng = Math.min(minLng, p.lng); maxLng = Math.max(maxLng, p.lng); }
    const kx = 111320 * Math.cos(minLat * Math.PI / 180), ky = 110540;
    let n = 0;
    for (const c of cams.list) {
      if (c[0] < minLat - 0.001 || c[0] > maxLat + 0.001 || c[1] < minLng - 0.001 || c[1] > maxLng + 0.001) continue;
      for (let i = 1; i < pts.length; i++) if (segDist(c, pts[i - 1], pts[i], kx, ky) < 40) { n++; break; }
    }
    return n;
  }
  function findDrives(pts) {
    const out = [];
    let cur = null, lastFast = 0;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      const ta = new Date(a.created_at).getTime(), tb = new Date(b.created_at).getTime(), s = (tb - ta) / 1000;
      if (s <= 0 || s > 10 * 60) continue;
      const d = distanceM(a, b), kmh = d / s * 3.6;
      if (kmh < 15 || kmh > 160) continue;
      if (!cur || ta - lastFast > 5 * 60e3) { if (cur) out.push(cur); cur = { from: a.created_at, to: b.created_at, m: 0, top: 0, pts: [a] }; }
      cur.m += d; cur.top = Math.max(cur.top, kmh); cur.to = b.created_at; cur.pts.push(b); lastFast = tb;
    }
    if (cur) out.push(cur);
    return out.filter((x) => x.m >= 1000).map((x) => Object.assign(x, { mins: (new Date(x.to) - new Date(x.from)) / 60000, cams: camsOnPath(x.pts) }));
  }
  function driveText(dr) {
    return t('drive_sub', { km: fmtDistance(dr.m), t: fmtDuration(Math.max(1, Math.round(dr.mins))), s: Math.round(dr.top) }) + (dr.cams ? ' · ' + t('cams_n', { n: dr.cams }) : '');
  }

  // =====================================================================
  // DRIVING WITH THIS PHONE ("My location" on): speedometer, the limit of the camera ahead,
  // a warning when too fast, and a trip summary when the drive ends
  // =====================================================================
  const drive = { trip: null, slowSince: 0, last: null, overBeep: 0, overSaid: {}, hideTimer: null };
  function camAhead(p, heading) {
    const known = heading != null && !isNaN(heading);
    const range = known ? 800 : 300;
    let best = null;
    for (const c of cams.list || []) {
      if (!c[2] || Math.abs(c[0] - p.lat) > 0.008 || Math.abs(c[1] - p.lng) > 0.01) continue;
      const cp = { lat: c[0], lng: c[1] }, d = distanceM(p, cp);
      if (d > range) continue;
      if (known && d > 60) { let diff = Math.abs(bearing(p, cp) - heading) % 360; if (diff > 180) diff = 360 - diff; if (diff > 40) continue; }
      if (!best || d < best.d) best = { d, limit: c[2], key: c[0] + ',' + c[1] };
    }
    return best;
  }
  function onDriveFix(pos) {
    const c = pos.coords, now = pos.timestamp || Date.now();
    const p = { lat: c.latitude, lng: c.longitude };
    const prev = drive.last;
    drive.last = { lat: p.lat, lng: p.lng, t: now };
    if (drive.trip && now - drive.trip.end > 10 * 60e3) endTrip();      // the app was closed for a while
    let kmh = (c.speed != null && c.speed >= 0) ? c.speed * 3.6 : null;
    if (kmh === null && prev) { const s = (now - prev.t) / 1000; if (s >= 1 && s <= 30) kmh = distanceM(prev, p) / s * 3.6; }
    if (kmh === null || kmh > 250) return;
    if (kmh >= 15 && !drive.trip) drive.trip = { start: now, end: now, m: 0, top: 0, cams: new Set(), over: new Set() };
    const tr = drive.trip;
    if (tr) {
      if (prev && c.accuracy < 60 && kmh >= 3) tr.m += distanceM(prev, p);
      tr.top = Math.max(tr.top, kmh);
      for (const cm of cams.list || []) if (Math.abs(cm[0] - p.lat) < 0.0008 && Math.abs(cm[1] - p.lng) < 0.001 && distanceM(p, { lat: cm[0], lng: cm[1] }) < 50) tr.cams.add(cm[0] + ',' + cm[1]);
      if (kmh < 5) { if (!drive.slowSince) { drive.slowSince = now; drive.slowPos = p; } else if (now - drive.slowSince > 3 * 60e3) { tr.end = drive.slowSince; endTrip(); } }
      else { drive.slowSince = 0; tr.end = now; }
    }
    renderSpeedo(kmh, p, c.heading);
  }
  function renderSpeedo(kmh, p, heading) {
    const el = $('#speedo');
    clearTimeout(drive.hideTimer);
    if (kmh < 10 && !drive.trip) { el.hidden = true; return; }
    el.hidden = state.tab !== 'map' || !!state.zoneEdit;
    $('#speedo-val').textContent = Math.round(kmh);
    const ahead = cams.on ? camAhead(p, heading) : null;
    $('#speedo-limit').hidden = !ahead;
    if (ahead) $('#speedo-limit').textContent = ahead.limit;
    const over = !!ahead && kmh > ahead.limit + 3;
    el.classList.toggle('over', over);
    if (over) {
      if (drive.trip) drive.trip.over.add(ahead.key);
      const o = drive.overSaid[ahead.key] || (drive.overSaid[ahead.key] = { n: 0, at: 0 });
      if (o.n < 2 && Date.now() - o.at > 20000) { o.n++; o.at = Date.now(); if (voiceOn()) say('v_slow', { n: ahead.limit }, false, 2); else beep('over'); if (navigator.vibrate) navigator.vibrate(200); }
    }
    drive.hideTimer = setTimeout(() => { el.hidden = true; }, 15000);   // no news from the GPS: hide it
  }
  function endTrip() {
    const tr = drive.trip;
    drive.trip = null; drive.slowSince = 0;
    $('#speedo').hidden = true;
    if (!tr) return;
    const mins = (tr.end - tr.start) / 60000;
    if (tr.m < 1000 || mins < 2) return;
    const trip = { at: new Date(tr.start).toISOString(), m: Math.round(tr.m), mins: Math.round(mins), top: Math.round(tr.top), cams: tr.cams.size, over: tr.over.size };
    let list = [];
    try { list = JSON.parse(localStorage.getItem('trackly-trips')) || []; } catch (e) { /* none */ }
    list.unshift(trip);
    try { localStorage.setItem('trackly-trips', JSON.stringify(list.slice(0, 30))); } catch (e) { /* full */ }
    showTrip(trip);
    if (drive.slowPos) saveCar(drive.slowPos, true);
  }
  function showTrip(trip) {
    $('#trip-km').textContent = fmtDistance(trip.m);
    $('#trip-time').textContent = fmtDuration(Math.max(1, trip.mins));
    $('#trip-avg').textContent = Math.round(trip.m / 1000 / Math.max(1, trip.mins) * 60) + ' ' + t('kmh');
    $('#trip-top').textContent = trip.top + ' ' + t('kmh');
    $('#trip-cams').textContent = String(trip.cams);
    $('#trip-over').textContent = String(trip.over);
    $('#trip-over').parentElement.classList.toggle('bad', trip.over > 0);
    $('#trip-view').hidden = false;
  }

  // ---- short beeps (speed camera ahead / too fast); phones only play sound after the first tap ----
  let audioCtx = null;
  function unlockAudio() {
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
    } catch (e) { /* no sound on this phone */ }
  }
  const camSoundOn = () => localStorage.getItem('trackly-cam-sound') !== '0';
  function beep(kind) {
    if (!camSoundOn() || !audioCtx) return;
    const tones = kind === 'over' ? [[784, 0], [784, 0.22]] : [[659, 0], [988, 0.18]];
    const t0 = audioCtx.currentTime;
    for (const [f, at] of tones) {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.type = 'sine'; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t0 + at);
      g.gain.exponentialRampToValueAtTime(0.2, t0 + at + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + at + 0.32);
      o.connect(g); g.connect(audioCtx.destination);
      o.start(t0 + at); o.stop(t0 + at + 0.34);
    }
  }
  function toggleCamSound() {
    localStorage.setItem('trackly-cam-sound', camSoundOn() ? '0' : '1');
    syncSettings();
    renderCamSound();
    if (camSoundOn()) { unlockAudio(); beep('cam'); }
    toast(camSoundOn() ? t('cam_sound_on') : t('cam_sound_off'));
  }
  function renderCamSound() { if ($('#btn-cam-sound')) $('#btn-cam-sound').setAttribute('aria-checked', String(camSoundOn())); }

  // =====================================================================
  // OPEN NOW? — reads OpenStreetMap opening hours. The common forms only ("24/7",
  // "Mo-Fr 08:00-22:00; Sa 10:00-14:00", "Mo-Su 09:00-13:00,16:00-02:00", "Fr off"); anything else → null
  // =====================================================================
  const OH_DAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
  function openNow(oh, when) {
    if (!oh) return null;
    const s = oh.trim();
    if (s === '24/7' || /^Mo-Su 00:00-24:00$/.test(s)) return true;
    const now = when || new Date();
    const day = (now.getDay() + 6) % 7, yday = (day + 6) % 7, mins = now.getHours() * 60 + now.getMinutes();
    let result = false, known = false;
    for (const raw of s.split(';')) {
      const r = raw.trim();
      if (!r || /^(PH|SH)\b/.test(r)) continue;
      const m = r.match(/^((?:Mo|Tu|We|Th|Fr|Sa|Su)(?:\s*-\s*(?:Mo|Tu|We|Th|Fr|Sa|Su))?(?:\s*,\s*(?:Mo|Tu|We|Th|Fr|Sa|Su)(?:\s*-\s*(?:Mo|Tu|We|Th|Fr|Sa|Su))?)*)?\s*(.*)$/);
      const days = new Set();
      if (m[1]) for (const piece of m[1].split(',')) {
        const [a, b] = piece.split('-').map((x) => OH_DAYS.indexOf(x.trim()));
        if (b === undefined) days.add(a); else for (let i = a; ; i = (i + 1) % 7) { days.add(i); if (i === b) break; }
      } else for (let i = 0; i < 7; i++) days.add(i);
      const times = m[2].trim();
      if (/^(off|closed)$/i.test(times)) { if (days.has(day)) { result = false; known = true; } continue; }
      const ranges = [];
      for (const part of times.split(',')) {
        const x = part.trim().match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\+?$/);
        if (!x) return null;
        ranges.push([+x[1] * 60 + +x[2], +x[3] * 60 + +x[4]]);
      }
      if (days.has(day)) { known = true; result = ranges.some(([a, b]) => (b > a ? mins >= a && mins < b : mins >= a)); }
      if (days.has(yday) && ranges.some(([a, b]) => b <= a && mins < b)) { known = true; result = true; }   // open past midnight
    }
    return known ? result : null;
  }
  async function findOpenPharmacy() {
    const from = state.me || state.recent[0] || null;
    if (!from) { toast(t('no_location')); return; }
    toast(t('ph_searching'));
    const els = await overpassOnce('[out:json][timeout:20];nwr["amenity"="pharmacy"](around:4000,' + from.lat + ',' + from.lng + ');out center tags 100;').catch(() => null);
    let list;
    if (els) list = els.map(toPlace).filter(Boolean);
    else {                                         // place server busy: the pharmacies the map already has (hours unknown)
      harvestVectorPlaces();
      list = [...places.all.values()].filter((p) => p.tags.kind === 'pharmacy' || p.tags.amenity === 'pharmacy');
      if (!list.length) { toast(t('err_offline')); return; }
    }
    list = list.map((p) => Object.assign(p, { d: distanceM(from, p), open: openNow(p.tags.opening_hours) }));
    const near = (arr) => arr.sort((a, b) => a.d - b.d)[0];
    const pick = near(list.filter((p) => p.open === true)) || near(list.filter((p) => p.open === null));
    if (!pick) { toast(t('ph_none')); return; }
    state.followBag = false; updateCenterBtn();
    if (state.tab !== 'map') switchTab('map');
    map.m.setView([pick.lat, pick.lng], 17);
    showPlace(pick);
    toast((pick.open ? t('ph_open') : t('ph_maybe')) + ' · ' + fmtDistance(pick.d));
  }

  // =====================================================================
  // FINDER TAG — a page with your phone number: print the QR and put it inside the bag.
  // Whoever finds the bag scans it and can call you, message you or send you where they are.
  // The details are in the link itself (after #), so they're never stored on a server.
  // =====================================================================
  function finderData() { try { return JSON.parse(localStorage.getItem('trackly-finder')) || {}; } catch (e) { return {}; } }
  function saveFinder() {
    const d = { p: $('#finder-phone').value.trim().slice(0, 30), m: $('#finder-msg').value.trim().slice(0, 140) };
    localStorage.setItem('trackly-finder', JSON.stringify(d));
    syncSettings();
  }
  function renderFinder() {
    const d = finderData();
    if (document.activeElement !== $('#finder-phone')) $('#finder-phone').value = d.p || '';
    if (document.activeElement !== $('#finder-msg')) $('#finder-msg').value = d.m || '';
  }
  function finderLink() {
    const d = finderData();
    if (!d.p) { toast(t('finder_need_phone')); $('#finder-phone').focus(); return null; }
    const name = state.tracker ? (state.tracker.name || '') : '';
    const json = JSON.stringify({ n: name, p: d.p, m: d.m || '', l: state.lang });
    const b64 = btoa(unescape(encodeURIComponent(json))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return new URL('found.html#' + b64, location.href).href;
  }
  function loadQrLib() {
    if (window.qrcode) return Promise.resolve();
    return new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.min.js';
      s.onload = res; s.onerror = rej;
      document.head.appendChild(s);
    });
  }
  async function showFinderQr() {
    saveFinder();
    const link = finderLink();
    if (!link) return;
    try { await loadQrLib(); } catch (e) { toast(t('err_offline')); return; }
    const qr = window.qrcode(0, 'M'); qr.addData(link); qr.make();
    $('#finder-qr').innerHTML = qr.createSvgTag({ scalable: true, margin: 2 });
    $('#finder-view').hidden = false;
  }
  async function shareFinder() {
    saveFinder();
    const link = finderLink();
    if (!link) return;
    try {
      if (navigator.share) await navigator.share({ title: 'Trackly', url: link });
      else { await navigator.clipboard.writeText(link); toast(t('copied')); }
    } catch (e) { /* closed */ }
  }
  function printFinder() {
    const svg = $('#finder-qr').innerHTML;
    const w = window.open('', '_blank');
    if (!w) return;
    w.document.write('<!doctype html><meta charset="utf-8"><title>Trackly</title><style>body{font-family:system-ui,sans-serif;display:flex;justify-content:center;padding:10mm}' +
      '.tag{width:60mm;border:0.4mm solid #222;border-radius:4mm;padding:5mm;text-align:center}.tag svg{width:44mm;height:44mm}' +
      'h1{font-size:5mm;margin:0 0 2mm}p{font-size:3mm;margin:2mm 0 0;line-height:1.4}</style><div class="tag"><h1>Found this bag?</h1>' + svg +
      '<p>Scan to contact the owner.<br>سکانی بکە بۆ پەیوەندی بە خاوەنەکەی · امسح للتواصل مع صاحبها</p></div><script>onload=()=>print()<\/script>');
    w.document.close();
  }

  // =====================================================================
  // HOME SCREEN — the app icon's badge (lost mode / low battery), the tab title, and the
  // long-press shortcuts from manifest.json (?go=bag | find | pharmacy | activity)
  // =====================================================================
  let badgeOn = null;
  function updateBadge(tr, loc) {
    const lost = tr.mode === 'lost', low = loc && typeof loc.battery === 'number' && loc.battery <= CFG.lowBatteryPercent;
    const on = !!(lost || low);
    document.title = 'Trackly · ' + (tr.name || tr.device_code) + (loc && typeof loc.battery === 'number' ? ' · ' + loc.battery + '%' : '');
    if (on === badgeOn || !navigator.setAppBadge) return;
    badgeOn = on;
    (on ? navigator.setAppBadge(1) : navigator.clearAppBadge()).catch(() => {});
  }
  function takeShortcut() {
    const go = new URLSearchParams(location.search).get('go');
    if (!go || !state.tracker) return;
    history.replaceState(null, '', location.pathname + location.hash);
    setTimeout(() => {
      if (go === 'find') openFind();
      else if (go === 'pharmacy') findOpenPharmacy();
      else if (go === 'activity') switchTab('history');
      else centerOnBag();
    }, 700);
  }

  // =====================================================================
  // VOICE — spoken alerts and turn-by-turn directions, with the phone's own voices.
  // Phones rarely have a Kurdish voice: then the Arabic voice reads the Arabic text (or English).
  // =====================================================================
  const voiceOn = () => localStorage.getItem('trackly-voice') !== '0';
  let voiceReady = false;
  function tIn(lang, key, vars) { const cur = state.lang; state.lang = lang; try { return t(key, vars); } finally { state.lang = cur; } }
  // the most natural voice the phone has: the new "Natural / Neural / Enhanced / Premium" ones first
  function voiceScore(v) {
    let n = 0;
    if (/natural|neural|enhanced|premium|siri|wavenet/i.test(v.name)) n += 50;
    if (/google/i.test(v.name)) n += 25;
    if (/online/i.test(v.name)) n += 15;
    if (/compact|espeak|robot/i.test(v.name)) n -= 40;
    if (/^en-(GB|US)|^ar-(IQ|SA|AE|EG)/i.test(v.lang)) n += 5;
    return n;
  }
  function pickVoice() {
    const vs = window.speechSynthesis ? speechSynthesis.getVoices() : [];
    const find = (re) => vs.filter((v) => re.test(v.lang)).sort((a, b) => voiceScore(b) - voiceScore(a))[0];
    const order = state.lang === 'ckb' ? [['ckb', /^(ckb|ku)/i], ['ar', /^ar/i]] : state.lang === 'ar' ? [['ar', /^ar/i]] : [];
    for (const [lang, re] of order) { const v = find(re); if (v) return { v, lang }; }
    return { v: find(/^en/i) || null, lang: 'en' };
  }
  function spokenDist(m, lang) {
    if (m >= 1000) return tIn(lang, 'v_km', { n: (Math.round(m / 100) / 10).toString() });
    return tIn(lang, 'v_m', { n: m >= 100 ? Math.round(m / 50) * 50 : Math.max(10, Math.round(m / 10) * 10) });
  }
  // say('v_key', vars) or say((lang) => text)
  // pri: 1 info, 2 warning, 3 directions. Something less important never cuts off something more important.
  let sayPri = 0;
  function say(what, vars, force, pri) {
    if ((!voiceOn() && !force) || !window.speechSynthesis) return;
    pri = pri || 1;
    if (speechSynthesis.speaking && pri < sayPri) return;
    const { v, lang } = pickVoice();
    const u = new SpeechSynthesisUtterance(typeof what === 'function' ? what(lang) : tIn(lang, what, vars));
    if (v) { u.voice = v; u.lang = v.lang; }
    u.rate = lang === 'en' ? 0.97 : 0.92;          // a little slower than the default: calmer, clearer
    u.pitch = 1; u.volume = 1;
    u.onend = u.onerror = () => { sayPri = 0; };
    sayPri = pri;
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  }
  if (window.speechSynthesis && speechSynthesis.addEventListener) speechSynthesis.addEventListener('voiceschanged', () => { /* pickVoice reads the new list */ });
  function unlockVoice() {           // iPhone: speech only works after it was started from a tap once
    if (voiceReady || !window.speechSynthesis) return;
    voiceReady = true;
    try { speechSynthesis.speak(new SpeechSynthesisUtterance('')); } catch (e) { /* no voice */ }
  }
  function toggleVoice() {
    localStorage.setItem('trackly-voice', voiceOn() ? '0' : '1');
    syncSettings(); renderVoice();
    if (voiceOn()) say('v_test', null, true);
    toast(voiceOn() ? t('voice_on') : t('voice_off'));
  }
  function renderVoice() { if ($('#btn-voice')) $('#btn-voice').setAttribute('aria-checked', String(voiceOn())); }

  // =====================================================================
  // ROUTES — directions inside Trackly (free OpenStreetMap routing): every way there,
  // shortest first, by car, on foot or by bike; then turn-by-turn with voice and re-routing
  // =====================================================================
  const ROUTER = 'https://routing.openstreetmap.de/';
  const ROUTE_MODES = { car: 'routed-car/route/v1/driving/', foot: 'routed-foot/route/v1/foot/', bike: 'routed-bike/route/v1/bike/' };
  const ROUTE_COLORS = ['#2F7BF6', '#8B5CF6', '#F97316', '#64748B'];
  const rt = { open: false, to: null, mode: 'car', list: [], sel: 0, layer: null, nav: null, seq: 0, eta: {} };
  const llOf = (c) => ({ lat: c[0], lng: c[1] });
  const fmtSecs = (s) => fmtDuration(Math.max(1, Math.round(s / 60)));
  async function getRoutes(from, to, mode, full) {
    const url = ROUTER + ROUTE_MODES[mode] + from.lng.toFixed(6) + ',' + from.lat.toFixed(6) + ';' + to.lng.toFixed(6) + ',' + to.lat.toFixed(6) +
      (full ? '?alternatives=3&steps=true&overview=full&geometries=geojson' : '?overview=false');
    const ctrl = window.AbortController ? new AbortController() : null;
    const timer = ctrl && setTimeout(() => ctrl.abort(), 15000);
    try {
      const r = await fetch(url, ctrl ? { signal: ctrl.signal } : {});
      if (!r.ok) return null;
      const j = await r.json();
      if (j.code !== 'Ok') return [];
      return j.routes.map((x) => ({ m: x.distance, s: x.duration,
        coords: full ? x.geometry.coordinates.map((c) => [c[1], c[0]]) : null,
        steps: full ? x.legs[0].steps.map((st) => ({ type: st.maneuver.type, mod: st.maneuver.modifier || '', exit: st.maneuver.exit,
          name: st.name || st.ref || '', loc: [st.maneuver.location[1], st.maneuver.location[0]] })) : null }));
    } catch (e) { return null; } finally { clearTimeout(timer); }
  }
  function routeFrom() { return state.me || state.recent[0] || null; }
  function waitForMe(ms) {
    return new Promise((res) => { const t0 = Date.now(); const iv = setInterval(() => { if (state.me || Date.now() - t0 > ms) { clearInterval(iv); res(); } }, 250); });
  }
  // "12 min by car · 50 min walking · 4.3 km from you" on a place card
  async function fillEta(el, to) {
    const from = routeFrom();
    if (!from) { el.textContent = '—'; return; }
    const key = [from.lat.toFixed(3), from.lng.toFixed(3), to.lat.toFixed(4), to.lng.toFixed(4)].join(',');
    let c = rt.eta[key];
    if (!c) {
      el.textContent = '…';
      const [car, foot] = await Promise.all([getRoutes(from, to, 'car', false), getRoutes(from, to, 'foot', false)]);
      c = { car: car && car[0], foot: foot && foot[0] };
      if (car && foot) rt.eta[key] = c;
    }
    const parts = [];
    if (c.car) parts.push(t('by_car', { t: fmtSecs(c.car.s) }));
    if (c.foot && c.foot.s < 3 * 3600) parts.push(t('on_foot', { t: fmtSecs(c.foot.s) }));
    const any = c.car || c.foot;
    el.textContent = any ? parts.join(' · ') + ' · ' + fmtDistance(any.m) + ' ' + (state.me ? t('from_you_short') : t('from_bag_short')) : '—';
  }
  async function openRoute(to, name, mode) {
    map.m.closePopup();
    if (state.tab !== 'map') switchTab('map');
    rt.to = { lat: to.lat, lng: to.lng, name: name || t('dropped_pin') };
    rt.open = true;
    state.followBag = false; updateCenterBtn();
    $('#rp-to').textContent = rt.to.name;
    $('#panel-map').hidden = true;
    $('#panel-route').hidden = false;
    $('#panel-route').classList.remove('navigating');
    if (!state.me && navigator.geolocation && window.isSecureContext) { locateMe(false); await waitForMe(4000); }
    const from = routeFrom();
    rt.mode = mode || (from && distanceM(from, to) < 1200 ? 'foot' : (localStorage.getItem('trackly-route-mode') || 'car'));
    loadRoutes();
  }
  function setRouteMode(m) { rt.mode = m; if (m !== 'foot') localStorage.setItem('trackly-route-mode', m); loadRoutes(); }
  async function loadRoutes() {
    $$('#rp-modes [data-mode]').forEach((b) => b.classList.toggle('active', b.dataset.mode === rt.mode));
    $('#rp-from').textContent = state.me ? t('route_from_me') : t('route_from_bag');
    const list = $('#rp-list');
    const note = (txt) => { list.innerHTML = ''; const li = document.createElement('li'); li.className = 'rp-note'; li.textContent = txt; list.appendChild(li); };
    note(t('route_loading'));
    $('#rp-start').disabled = true;
    clearRouteLayer();
    const from = routeFrom();
    if (!from) { note(t('no_location')); return; }
    if (distanceM(from, rt.to) < 25) { note(t('with_you')); return; }
    const seq = ++rt.seq;
    const routes = await getRoutes(from, rt.to, rt.mode, true);
    if (seq !== rt.seq || !rt.open) return;
    if (!routes) { note(t('err_offline')); return; }
    if (!routes.length) { note(t('route_none')); return; }
    routes.sort((a, b) => a.m - b.m);                         // the shortest way first
    const fastest = routes.reduce((a, b) => (b.s < a.s ? b : a));
    routes.forEach((r, i) => {
      r.tag = routes.length === 1 ? 'route_best' : i === 0 ? (r === fastest ? 'route_short_fast' : 'route_shortest')
        : r === fastest ? 'route_fastest' : i === routes.length - 1 ? 'route_longest' : 'route_other';
    });
    rt.list = routes; rt.sel = 0;
    renderRouteList();
    drawRoutes(true);
    $('#rp-start').disabled = false;
  }
  function renderRouteList() {
    const list = $('#rp-list');
    list.innerHTML = '';
    const arrive = (s) => clockTime(new Date(Date.now() + s * 1000).toISOString());
    rt.list.forEach((r, i) => {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'rp-opt' + (i === rt.sel ? ' on' : '');
      b.style.setProperty('--c', ROUTE_COLORS[i] || ROUTE_COLORS[3]);
      b.innerHTML = '<span class="rp-dot"></span><span class="rp-txt"><strong></strong><span></span></span><span class="rp-time"><strong></strong><span></span></span>';
      b.querySelector('.rp-txt strong').textContent = t(r.tag);
      b.querySelector('.rp-txt span').textContent = fmtDistance(r.m) + (i ? ' · +' + fmtDistance(r.m - rt.list[0].m) : '');
      b.querySelector('.rp-time strong').textContent = fmtSecs(r.s);
      b.querySelector('.rp-time span').textContent = t('arrive_at', { t: arrive(r.s) });
      b.addEventListener('click', () => { rt.sel = i; renderRouteList(); drawRoutes(false); });
      li.appendChild(b);
      list.appendChild(li);
    });
  }
  function clearRouteLayer() { if (rt.layer) { map.m.removeLayer(rt.layer); rt.layer = null; } }
  function drawRoutes(fit) {
    clearRouteLayer();
    const g = L.layerGroup();
    const dash = rt.mode === 'foot' ? '1 9' : null;
    rt.list.forEach((r, i) => {
      if (i === rt.sel || (rt.nav && i !== rt.sel)) return;
      L.polyline(r.coords, { color: isDark() ? '#5b6474' : '#9aa3b2', weight: 6, opacity: 0.85, lineCap: 'round', dashArray: dash })
        .on('click', () => { rt.sel = i; renderRouteList(); drawRoutes(false); }).addTo(g);
    });
    const r = rt.list[rt.sel];
    if (r) {
      L.polyline(r.coords, { color: '#ffffff', weight: 11, opacity: 0.95, lineCap: 'round', interactive: false }).addTo(g);
      L.polyline(r.coords, { color: ROUTE_COLORS[rt.sel] || ROUTE_COLORS[0], weight: 6.5, lineCap: 'round', lineJoin: 'round', dashArray: dash, interactive: false }).addTo(g);
      L.marker([rt.to.lat, rt.to.lng], { keyboard: false, interactive: false, icon: L.divIcon({ className: '', iconSize: [34, 42], iconAnchor: [17, 40], html: '<div class="search-pin"></div>' }) }).addTo(g);
    }
    rt.layer = g.addTo(map.m);
    if (fit && rt.list.length) {
      const b = L.latLngBounds([]);
      rt.list.forEach((x) => b.extend(L.latLngBounds(x.coords)));
      map.m.fitBounds(b, { paddingTopLeft: [32, 140], paddingBottomRight: [32, coverH() + 24], maxZoom: 17 });
    }
  }
  function closeRoute() {
    stopNav();
    rt.open = false; rt.list = []; rt.seq++;
    clearRouteLayer();
    $('#panel-route').hidden = true;
    $('#panel-map').hidden = state.tab !== 'map';
    state.followBag = true;
    renderMapPanel();
  }
  // ---- turn-by-turn ----
  function projOnSeg(p, a, b) {
    const kx = 111320 * Math.cos(p.lat * Math.PI / 180), ky = 110540;
    const ax = (a.lng - p.lng) * kx, ay = (a.lat - p.lat) * ky, bx = (b.lng - p.lng) * kx, by = (b.lat - p.lat) * ky;
    const dx = bx - ax, dy = by - ay, len = dx * dx + dy * dy;
    const u = len ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len)) : 0;
    return { d: Math.hypot(ax + u * dx, ay + u * dy), u };
  }
  function navAct(st, lang) {
    const L1 = (k, v) => tIn(lang, k, v);
    if (st.type === 'arrive') return L1('nav_arrive');
    let a;
    if (/roundabout|rotary/.test(st.type)) a = st.exit ? L1('nav_round', { n: st.exit }) : L1('nav_round_any');
    else if (st.type === 'depart') a = L1('nav_depart');
    else if (st.mod === 'uturn') a = L1('nav_uturn');
    else if (/fork|ramp/.test(st.type)) a = L1(/left/.test(st.mod) ? 'nav_keep_left' : /right/.test(st.mod) ? 'nav_keep_right' : 'nav_straight');
    else if (st.type === 'merge') a = L1('nav_merge');
    else if (!st.mod || st.mod === 'straight') a = L1('nav_straight');
    else a = L1('nav_' + st.mod.replace(' ', '_'));
    return st.name ? L1('nav_onto', { a, road: st.name }) : a;
  }
  function navRotation(st) {
    if (st.type === 'arrive') return null;
    return { 'sharp left': -135, left: -90, 'slight left': -45, straight: 0, 'slight right': 45, right: 90, 'sharp right': 135, uturn: 180 }[st.mod] || 0;
  }
  async function startNav(quiet) {
    const r = rt.list[rt.sel];
    if (!r) return;
    unlockAudio(); unlockVoice();
    if (!state.me) { locateMe(false); toast(t('nav_need_gps')); }
    // how far along the route each point and each turn is
    const cum = [0];
    for (let i = 1; i < r.coords.length; i++) cum.push(cum[i - 1] + distanceM(llOf(r.coords[i - 1]), llOf(r.coords[i])));
    r.cum = cum; r.len = cum[cum.length - 1] || r.m;
    r.stepAt = r.steps.map((st) => {
      let bi = 0, bd = Infinity;
      r.coords.forEach((c, i) => { const d = Math.abs(c[0] - st.loc[0]) + Math.abs(c[1] - st.loc[1]); if (d < bd) { bd = d; bi = i; } });
      return cum[bi];
    });
    rt.list = [r]; rt.sel = 0;
    rt.nav = { r, said: {}, off: 0, idx: 0, rerouteAt: rt.nav ? rt.nav.rerouteAt : 0 };
    $('#panel-route').classList.add('navigating');
    $('#nav-banner').hidden = false;
    drawRoutes(false);
    if (navigator.wakeLock && !rt.wake) navigator.wakeLock.request('screen').then((w) => { rt.wake = w; }).catch(() => {});
    if (!quiet) say((lang) => tIn(lang, 'v_start', { d: spokenDist(r.m, lang) }), null, false, 3);
    updateNav();
  }
  function stopNav() {
    if (!rt.nav) return;
    rt.nav = null;
    $('#nav-banner').hidden = true;
    $('#panel-route').classList.remove('navigating');
    if (rt.wake) { rt.wake.release().catch(() => {}); rt.wake = null; }
  }
  function updateNav() {
    const nav = rt.nav;
    if (!nav) return;
    const r = nav.r;
    const remainAll = (prog) => Math.max(0, r.len - prog);
    if (!state.me) { $('#nav-dist').textContent = '…'; $('#nav-text').textContent = t('nav_need_gps'); return; }
    const me = state.me;
    // where am I on the route? (search near the last place, so a road that comes back doesn't confuse it)
    let best = nav.idx, bd = Infinity, bu = 0;
    for (let i = Math.max(0, nav.idx - 10); i < Math.min(r.coords.length - 1, nav.idx + 600); i++) {
      const p = projOnSeg(me, llOf(r.coords[i]), llOf(r.coords[i + 1]));
      if (p.d < bd) { bd = p.d; best = i; bu = p.u; }
    }
    const offLimit = (rt.mode === 'car' ? 45 : 30) + Math.min(me.acc || 0, 40);
    if (bd > offLimit) { if (++nav.off >= 3) reroute(); } else nav.off = 0;
    nav.idx = best;
    const prog = r.cum[best] + bu * ((r.cum[best + 1] || r.cum[best]) - r.cum[best]);
    const left = remainAll(prog);
    if (left < 25) { say('nav_arrive', null, false, 3); toast(t('nav_arrive')); stopNav(); closeRoute(); return; }
    let k = r.stepAt.findIndex((a, i) => i > 0 && a > prog + 5);
    if (k < 0) k = r.steps.length - 1;
    const st = r.steps[k], toTurn = Math.max(0, r.stepAt[k] - prog);
    $('#nav-dist').textContent = fmtDistance(toTurn);
    $('#nav-text').textContent = navAct(st, state.lang);
    const rot = navRotation(st);
    $('#nav-icon').innerHTML = rot === null ? '<svg viewBox="0 0 24 24"><path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/></svg>'
      : (/roundabout|rotary/.test(st.type) ? '<svg viewBox="0 0 24 24"><circle cx="12" cy="14" r="4"/><path d="M12 10V3M9 6l3-3 3 3M12 18v3"/></svg>'
        : '<svg viewBox="0 0 24 24" style="transform:rotate(' + rot + 'deg)"><path d="M12 20V5M6 11l6-6 6 6"/></svg>');
    const secsLeft = r.s * left / r.len;
    $('#rp-left').textContent = fmtSecs(secsLeft) + ' · ' + fmtDistance(left) + ' · ' + t('arrive_at', { t: clockTime(new Date(Date.now() + secsLeft * 1000).toISOString()) });
    // voice: once well before the turn, once right at it
    const far = rt.mode === 'car' ? 400 : 80, near = rt.mode === 'car' ? 70 : 20;
    const talk = st.type === 'arrive' || /roundabout|rotary|fork|ramp|merge/.test(st.type) || (st.mod && st.mod !== 'straight' && st.type !== 'new name');
    if (talk && toTurn <= near && !nav.said[k + 'n']) { nav.said[k + 'n'] = nav.said[k + 'f'] = 1; say((lang) => navAct(st, lang), null, false, 3); }
    else if (talk && toTurn <= far && toTurn > near * 1.5 && !nav.said[k + 'f']) { nav.said[k + 'f'] = 1; say((lang) => tIn(lang, 'v_in', { d: spokenDist(toTurn, lang), a: navAct(st, lang) }), null, false, 3); }
    // keep me in the free part of the map, above the card
    const z = Math.max(map.m.getZoom(), rt.mode === 'car' ? 16 : 17);
    const pt = map.m.project([me.lat, me.lng], z).add([0, Math.min(coverH() / 2 - 60, 220)]);
    map.m.setView(map.m.unproject(pt, z), z, { animate: true });
  }
  async function reroute() {
    const nav = rt.nav;
    if (!nav || nav.busy || Date.now() - (nav.rerouteAt || 0) < 15000 || !state.me) return;
    nav.busy = true; nav.rerouteAt = Date.now();
    say('v_reroute', null, false, 3);
    const routes = await getRoutes(state.me, rt.to, rt.mode, true);
    if (!rt.nav) return;
    nav.busy = false;
    if (!routes || !routes.length) return;
    routes.sort((a, b) => a.m - b.m);
    rt.list = routes; rt.sel = 0;
    startNav(true);
  }

  // =====================================================================
  // MY CAR — save where you parked (or it saves itself when a drive ends), then walk back
  // =====================================================================
  const CAR_SVG = '<svg viewBox="0 0 24 24"><path d="M5 16V11l2-5h10l2 5v5M3 16h18v3h-3v-1H6v1H3zM7.5 13.5h.01M16.5 13.5h.01"/></svg>';
  function carSpot() { try { return JSON.parse(localStorage.getItem('trackly-car')); } catch (e) { return null; } }
  function drawCar() {
    if (!map.m) return;
    if (map.car) { map.m.removeLayer(map.car); map.car = null; }
    const c = carSpot();
    if (!c) return;
    map.car = L.marker([c.lat, c.lng], { keyboard: false, zIndexOffset: 900, icon: L.divIcon({ className: '', iconSize: [36, 36], iconAnchor: [18, 18], html: '<div class="car-pin">' + CAR_SVG + '</div>' }) })
      .on('click', showCar).addTo(map.m);
  }
  function saveCar(p, auto) {
    localStorage.setItem('trackly-car', JSON.stringify({ lat: +p.lat.toFixed(6), lng: +p.lng.toFixed(6), at: new Date().toISOString() }));
    syncSettings(); drawCar();
    toast(auto ? t('car_saved_auto') : t('car_saved'));
  }
  async function carAction() {
    if (carSpot()) { showCar(); return; }
    if (!state.me) { locateMe(false); await waitForMe(8000); }
    if (!state.me) { toast(t('toast_no_gps')); return; }
    saveCar(state.me, false);
  }
  function showCar() {
    const c = carSpot();
    if (!c) return;
    const box = document.createElement('div');
    box.className = 'bi';
    box.innerHTML = '<div class="pl-head"><span class="place-dot big" style="--c:#0F766E">' + CAR_SVG + '</span><div><strong class="bi-title"></strong><span class="pl-type"></span></div></div>' +
      '<div class="bi-actions"><button type="button" class="btn btn-secondary" data-c="clear"></button><button type="button" class="btn btn-primary" data-c="go"></button></div>';
    box.querySelector('.bi-title').textContent = t('car_title');
    box.querySelector('.pl-type').textContent = t('car_parked', { t: relTime((Date.now() - new Date(c.at)) / 1000) }) + (state.me ? ' · ' + fmtDistance(distanceM(state.me, c)) : '');
    box.querySelector('[data-c="clear"]').textContent = t('car_clear');
    box.querySelector('[data-c="go"]').textContent = t('car_go');
    box.querySelector('[data-c="go"]').addEventListener('click', () => openRoute(c, t('car_title'), 'foot'));
    box.querySelector('[data-c="clear"]').addEventListener('click', () => {
      const old = localStorage.getItem('trackly-car');
      localStorage.removeItem('trackly-car'); syncSettings(); map.m.closePopup(); drawCar();
      toastUndo(t('car_cleared'), () => { localStorage.setItem('trackly-car', old); syncSettings(); drawCar(); });
    });
    state.followBag = false; updateCenterBtn();
    map.m.setView([c.lat, c.lng], Math.max(map.m.getZoom(), 16));
    L.popup({ className: 'bag-popup', maxWidth: 280, offset: [0, -14], autoPanPaddingTopLeft: [16, 130] }).setLatLng([c.lat, c.lng]).setContent(box).openOn(map.m);
  }

  // =====================================================================
  // REMINDERS — "When I leave Home: take the charger". Fires when this phone (while Trackly is open)
  // or the bag leaves / arrives at the safe zone.
  // =====================================================================
  function reminders() { try { return JSON.parse(localStorage.getItem('trackly-reminders')) || []; } catch (e) { return []; } }
  function saveReminders(list) { localStorage.setItem('trackly-reminders', JSON.stringify(list.slice(0, 40))); syncSettings(); renderReminders(); }
  function renderReminders() {
    const ul = $('#rem-list');
    if (!ul) return;
    ul.innerHTML = '';
    const list = reminders().filter((r) => state.zones.some((z) => z.id === r.z));
    if (!list.length) { const li = document.createElement('li'); li.className = 'muted small rem-empty'; li.textContent = t('rem_empty'); ul.appendChild(li); return; }
    for (const r of list) {
      const z = state.zones.find((x) => x.id === r.z);
      const li = document.createElement('li');
      li.className = 'rem-item';
      li.innerHTML = '<span class="rem-ic">' + kindIcon(z.kind) + '</span><span class="rem-txt"><strong></strong><span></span></span><button type="button" class="icon-btn small" aria-label="Delete"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>';
      li.querySelector('strong').textContent = r.text;
      li.querySelector('.rem-txt span').textContent = t(r.when === 'leave' ? 'rem_when_leave' : 'rem_when_arrive', { z: z.name });
      li.querySelector('button').addEventListener('click', () => { const before = reminders(); saveReminders(before.filter((x) => x.id !== r.id)); toastUndo(t('rem_deleted'), () => saveReminders(before)); });
      ul.appendChild(li);
    }
  }
  function openReminderForm() {
    if (!state.zones.length) { toast(t('rem_need_zone')); return; }
    const sel = $('#rem-zone');
    sel.innerHTML = '';
    for (const z of state.zones) { const o = document.createElement('option'); o.value = z.id; o.textContent = z.name; sel.appendChild(o); }
    $('#rem-text').value = '';
    $$('#rem-when .seg').forEach((b) => b.classList.toggle('active', b.dataset.when === 'leave'));
    $('#rem-view').hidden = false;
    setTimeout(() => $('#rem-text').focus(), 250);
  }
  function submitReminder(e) {
    e.preventDefault();
    const text = $('#rem-text').value.trim();
    if (!text) { $('#rem-text').focus(); return; }
    const when = ($('#rem-when .seg.active') || {}).dataset.when || 'leave';
    saveReminders(reminders().concat({ id: Date.now().toString(36), z: $('#rem-zone').value, when, text: text.slice(0, 80) }));
    closeModal($('#rem-view'));
    toast(t('rem_saved'));
  }
  const remFired = {};
  function fireReminders(zone, when) {
    for (const r of reminders()) {
      if (r.z !== zone.id || r.when !== when) continue;
      const k = r.id + when;
      if (remFired[k] && Date.now() - remFired[k] < 30 * 60e3) continue;     // the phone and the bag both crossing: once
      remFired[k] = Date.now();
      addAlert('reminder', t('rem_alert', { z: zone.name, x: r.text }));
      say((lang) => tIn(lang, 'v_reminder', { x: r.text }));
    }
  }
  let meZones = null;
  function checkMyZones() {
    if (!state.me || !state.zones.length) return;
    const first = !meZones;
    if (first) meZones = {};
    for (const z of state.zones) {
      const d = distanceM(state.me, z), was = meZones[z.id];
      if (first || was === undefined) { meZones[z.id] = d <= z.radius_m; continue; }
      if (was && d > z.radius_m + 30) { meZones[z.id] = false; fireReminders(z, 'leave'); }
      else if (!was && d <= z.radius_m) { meZones[z.id] = true; fireReminders(z, 'arrive'); }
    }
  }

  // =====================================================================
  // SMART ALERTS (while Trackly is open or in the background)
  // 1. Night guard: the bag moves at night and isn't with you → "Is this you?"; no answer in 2 min → lost mode
  // 2. Unusual place: the bag stays somewhere it has never been in the last 30 days
  // =====================================================================
  const nightOn = () => localStorage.getItem('trackly-night-guard') !== '0';
  const unusualOn = () => localStorage.getItem('trackly-unusual') !== '0';
  const ng = { okUntil: 0, tick: null };
  function checkNightMove(tr, loc, moving) {
    if (!nightOn() || tr.mode === 'lost' || !moving || !$('#night-view').hidden || Date.now() < ng.okUntil) return;
    const h = new Date().getHours();
    if (h >= 6 && h < 23) return;
    if (state.me && distanceM(state.me, loc) < 150) return;          // it's with you
    ng.okUntil = Date.now() + 10 * 60e3;
    let left = 120;
    const show = () => { $('#night-count').textContent = Math.floor(left / 60) + ':' + String(left % 60).padStart(2, '0'); };
    $('#night-text').textContent = t('night_q', { b: tr.name || tr.device_code });
    show();
    $('#night-view').hidden = false;
    addAlert('night', t('night_alert', { b: tr.name || tr.device_code }));
    beep('over'); say('v_night');
    if (navigator.vibrate) navigator.vibrate([300, 100, 300, 100, 300]);
    clearInterval(ng.tick);
    ng.tick = setInterval(() => { left--; show(); if (left <= 0) nightAnswer(false, true); }, 1000);
  }
  async function nightAnswer(isMe, auto) {
    clearInterval(ng.tick);
    closeModal($('#night-view'));
    if (isMe) { ng.okUntil = Date.now() + 3 * 3600e3; toast(t('night_ok')); return; }
    ng.okUntil = Date.now() + 3600e3;
    if (await setMode('lost')) toast(auto ? t('night_auto') : t('night_lost'));
  }
  const usual = { list: null, days: 0, for: null, loading: false };
  async function loadUsual() {
    const tr = state.tracker;
    if (!tr || usual.loading) return;
    const key = 'trackly-usual-' + tr.id;
    let c = null;
    try { c = JSON.parse(localStorage.getItem(key)); } catch (e) { /* none */ }
    if (c && Date.now() - c.at < 12 * 3600e3) { Object.assign(usual, { list: c.list, days: c.days, for: tr.id }); return; }
    usual.loading = true;
    try {
      const since = new Date(Date.now() - 30 * 86400e3).toISOString();
      const { data } = await sb.from('locations').select('lat, lng, created_at').eq('tracker_id', tr.id).gte('created_at', since)
        .order('created_at', { ascending: true }).limit(20000);
      const pts = data || [];
      const until = Date.now() - 12 * 3600e3;           // the last 12 hours don't count: today's new place must not "learn" itself
      const list = [];
      for (const s of findStops(pts.filter((p) => new Date(p.created_at).getTime() < until))) if (!list.some((x) => distanceM(x, s) < 150)) list.push({ lat: s.lat, lng: s.lng });
      const days = new Set(pts.map((p) => new Date(p.created_at).toDateString())).size;
      Object.assign(usual, { list, days, for: tr.id });
      try { localStorage.setItem(key, JSON.stringify({ at: Date.now(), list, days })); } catch (e) { /* full */ }
    } finally { usual.loading = false; }
  }
  function checkUnusual(tr, loc, moving, stale) {
    if (!unusualOn() || moving || stale) return;
    if (usual.for !== tr.id) { loadUsual(); return; }
    if (!usual.list || usual.days < 5) return;                   // still learning your places
    let since = new Date(loc.created_at).getTime();
    for (const p of state.recent) { if (distanceM(p, loc) > 80) break; since = new Date(p.created_at).getTime(); }
    if (Date.now() - since < 10 * 60e3) return;                  // there for 10 min+
    if (zoneAt(loc) || usual.list.some((u) => distanceM(u, loc) < 300)) return;
    const k = tr.id + ':' + loc.lat.toFixed(3) + ',' + loc.lng.toFixed(3);
    let done = [];
    try { done = JSON.parse(localStorage.getItem('trackly-unusual-done')) || []; } catch (e) { /* none */ }
    if (done.includes(k)) return;
    localStorage.setItem('trackly-unusual-done', JSON.stringify(done.concat(k).slice(-50)));
    addAlert('unusual', t('alert_unusual', { b: tr.name || tr.device_code, p: $('#bag-area').textContent }));
  }
  function renderSmartSwitches() {
    if ($('#night-switch')) $('#night-switch').setAttribute('aria-checked', String(nightOn()));
    if ($('#unusual-switch')) $('#unusual-switch').setAttribute('aria-checked', String(unusualOn()));
  }
  function toggleSmart(key, on) { localStorage.setItem(key, on() ? '0' : '1'); syncSettings(); renderSmartSwitches(); }

  // =====================================================================
  // WEATHER — temperature on the map, with heat and dust-storm warnings (Open-Meteo, free)
  // =====================================================================
  const WX_ICON = {
    sun: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
    moon: '<svg viewBox="0 0 24 24"><path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/></svg>',
    cloud: '<svg viewBox="0 0 24 24"><path d="M7 18h10a4 4 0 0 0 .5-8 6 6 0 0 0-11.6 1.5A3.3 3.3 0 0 0 7 18z"/></svg>',
    rain: '<svg viewBox="0 0 24 24"><path d="M7 14h10a4 4 0 0 0 .5-8 6 6 0 0 0-11.6 1.5A3.3 3.3 0 0 0 7 14zM8 17l-1 3M12 17l-1 3M16 17l-1 3"/></svg>',
    snow: '<svg viewBox="0 0 24 24"><path d="M7 14h10a4 4 0 0 0 .5-8 6 6 0 0 0-11.6 1.5A3.3 3.3 0 0 0 7 14zM8 18h.01M12 20h.01M16 18h.01"/></svg>',
    storm: '<svg viewBox="0 0 24 24"><path d="M7 14h10a4 4 0 0 0 .5-8 6 6 0 0 0-11.6 1.5A3.3 3.3 0 0 0 7 14zM13 14l-2 4h3l-2 4"/></svg>',
    fog: '<svg viewBox="0 0 24 24"><path d="M4 10h16M3 14h18M6 18h12M7 6h10"/></svg>',
    dust: '<svg viewBox="0 0 24 24"><path d="M3 8h11a3 3 0 1 0-3-3M3 12h15a3 3 0 1 1-3 3M3 16h7"/></svg>'
  };
  const wx = { at: 0, key: '', data: null };
  function wxKind(code, day) {
    if (code <= 1) return day ? 'sun' : 'moon';
    if (code <= 3) return 'cloud';
    if (code === 45 || code === 48) return 'fog';
    if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return 'rain';
    if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'snow';
    if (code >= 95) return 'storm';
    return 'cloud';
  }
  function wxWarn() {
    const c = wx.data && wx.data.f.current, a = wx.data && wx.data.a && wx.data.a.current;
    if (!c) return '';
    if (c.temperature_2m >= 45) return 'heat';
    if (a && ((a.dust || 0) >= 150 || (a.us_aqi || 0) >= 150)) return 'dust';
    return '';
  }
  async function loadWeather() {
    const p = state.recent[0] || state.me || { lat: ERBIL[0], lng: ERBIL[1] };
    const key = p.lat.toFixed(1) + ',' + p.lng.toFixed(1);
    if (wx.key === key && Date.now() - wx.at < 30 * 60e3) return;
    wx.key = key; wx.at = Date.now();
    const q = 'latitude=' + p.lat.toFixed(3) + '&longitude=' + p.lng.toFixed(3);
    const get = (url) => {
      const ctrl = window.AbortController ? new AbortController() : null;
      const timer = ctrl && setTimeout(() => ctrl.abort(), 20000);
      return fetch(url, ctrl ? { signal: ctrl.signal } : {}).then((r) => r.json()).finally(() => clearTimeout(timer));
    };
    try {
      const f = await get('https://api.open-meteo.com/v1/forecast?' + q + '&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m,is_day,relative_humidity_2m' +
        '&hourly=temperature_2m,weather_code,is_day&forecast_hours=13&daily=temperature_2m_max,temperature_2m_min&forecast_days=1&timezone=auto');
      if (!f || !f.current) throw new Error('no weather');
      wx.data = { f, a: wx.key === key && wx.data ? wx.data.a : null };
      renderWeather();
    } catch (e) { wx.at = 0; wx.key = ''; setTimeout(loadWeather, 8000); return; }   // slow or offline: try again soon
    // air quality (dust) separately: it must never hold up the temperature
    get('https://air-quality-api.open-meteo.com/v1/air-quality?' + q + '&current=dust,pm10,us_aqi').then((a) => { if (wx.data && a && a.current) { wx.data.a = a; renderWeather(); } }).catch(() => {});
  }
  function renderWeather() {
    const el = $('#wx-pill');
    const c = wx.data && wx.data.f.current;
    el.hidden = !c || state.tab !== 'map' || !!state.zoneEdit;
    $('#view-app').classList.toggle('has-wx', !el.hidden);
    if (!c) return;
    const warn = wxWarn();
    el.className = 'wx-pill' + (warn ? ' warn-' + warn : '');
    el.innerHTML = WX_ICON[warn === 'dust' ? 'dust' : wxKind(c.weather_code, c.is_day)] + '<span></span>';
    el.querySelector('span').textContent = Math.round(c.temperature_2m) + '°';
    el.setAttribute('aria-label', t('wx_title') + ' ' + Math.round(c.temperature_2m) + '°');
  }
  function showWeather() {
    if (!wx.data) return;
    const { f, a } = wx.data, c = f.current, aq = a && a.current;
    const kind = wxKind(c.weather_code, c.is_day), warn = wxWarn();
    $('#wx-big').innerHTML = WX_ICON[kind];
    $('#wx-temp').textContent = Math.round(c.temperature_2m) + '°';
    $('#wx-desc').textContent = t('wx_' + kind) + (f.daily ? ' · ' + Math.round(f.daily.temperature_2m_max[0]) + '° / ' + Math.round(f.daily.temperature_2m_min[0]) + '°' : '');
    $('#wx-feels').textContent = Math.round(c.apparent_temperature) + '°';
    $('#wx-wind').textContent = Math.round(c.wind_speed_10m) + ' ' + t('kmh');
    $('#wx-hum').textContent = Math.round(c.relative_humidity_2m) + '%';
    const aqi = aq ? aq.us_aqi : null;
    $('#wx-air').textContent = aqi == null ? '—' : aqi + ' · ' + t(aqi <= 50 ? 'air_good' : aqi <= 100 ? 'air_ok' : aqi <= 150 ? 'air_sens' : 'air_bad');
    $('#wx-warn').hidden = !warn;
    if (warn) $('#wx-warn').textContent = t(warn === 'heat' ? 'wx_heat' : 'wx_dust');
    const hours = $('#wx-hours');
    hours.innerHTML = '';
    for (let i = 1; i < f.hourly.time.length; i += 2) {
      const d = document.createElement('div');
      d.innerHTML = '<span></span>' + WX_ICON[wxKind(f.hourly.weather_code[i], f.hourly.is_day[i])] + '<strong></strong>';
      d.querySelector('span').textContent = f.hourly.time[i].slice(11, 16);
      d.querySelector('strong').textContent = Math.round(f.hourly.temperature_2m[i]) + '°';
      hours.appendChild(d);
    }
    $('#wx-view').hidden = false;
  }

  // =====================================================================
  // TRAFFIC — live traffic colours on the roads (TomTom, free key: docs/traffic-setup.md)
  // =====================================================================
  const trafficOn = () => localStorage.getItem('trackly-traffic') === '1';
  function renderTraffic() {
    const row = $('#traffic-row');
    if (row) row.hidden = !CFG.tomtomKey;
    if ($('#btn-traffic')) $('#btn-traffic').setAttribute('aria-checked', String(trafficOn()));
    if (!map.m || !CFG.tomtomKey) return;
    if (!map.m.getPane('traffic')) { map.m.createPane('traffic'); map.m.getPane('traffic').style.zIndex = 250; map.m.getPane('traffic').style.pointerEvents = 'none'; }
    if (trafficOn() && !map.traffic) {
      map.traffic = L.tileLayer('https://api.tomtom.com/traffic/map/4/tile/flow/relative0/{z}/{x}/{y}.png?tileSize=256&key=' + encodeURIComponent(CFG.tomtomKey),
        { pane: 'traffic', maxZoom: 22, maxNativeZoom: 22, opacity: 0.85, attribution: '&copy; TomTom' }).addTo(map.m);
    } else if (!trafficOn() && map.traffic) { map.m.removeLayer(map.traffic); map.traffic = null; }
  }
  function toggleTraffic() {
    localStorage.setItem('trackly-traffic', trafficOn() ? '0' : '1');
    syncSettings(); renderTraffic();
    toast(trafficOn() ? t('traffic_on') : t('traffic_off'));
  }

  // =====================================================================
  // APPEARANCE — Auto (follows the phone), Light or Dark
  // =====================================================================
  const SCHEMES = ['auto', 'light', 'dark'];
  function schemePref() { const v = localStorage.getItem('trackly-scheme'); return SCHEMES.includes(v) ? v : 'auto'; }
  function applyScheme(v, quiet) {
    const s = SCHEMES.includes(v) ? v : 'auto';
    const changed = s !== schemePref();
    localStorage.setItem('trackly-scheme', s);
    if (s === 'auto') delete document.documentElement.dataset.scheme; else document.documentElement.dataset.scheme = s;
    $$('#scheme-seg .seg').forEach((b) => b.classList.toggle('active', b.dataset.scheme === s));
    const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
    $$('meta[name="theme-color"]').forEach((m) => { m.content = bg; });
    if (!quiet) syncSettings();
    if (changed && map.m) { setTiles(); renderMapPanel(); renderZones(); }
  }

  // =====================================================================
  // SAVED PLACES (the star on a place card) and RECENT SEARCHES — shown as soon as the search opens
  // =====================================================================
  const STAR = 'M12 3l2.6 5.6 6.1.7-4.5 4.2 1.2 6L12 16.6l-5.4 2.9 1.2-6-4.5-4.2 6.1-.7z';
  const SHARE_SVG = '<svg viewBox="0 0 24 24"><circle cx="18" cy="5" r="2.5"/><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="19" r="2.5"/><path d="M8.2 10.8l7.6-4.4M8.2 13.2l7.6 4.4"/></svg>';
  const favKey = (p) => (+p.lat).toFixed(5) + ',' + (+p.lng).toFixed(5);
  function favs() { try { return JSON.parse(localStorage.getItem('trackly-favs')) || []; } catch (e) { return []; } }
  function recents() { try { return JSON.parse(localStorage.getItem('trackly-recent')) || []; } catch (e) { return []; } }
  function toggleFav(p, name) {
    const k = favKey(p);
    const before = favs();
    let list = before.slice();
    const had = list.some((f) => f.k === k);
    if (had) list = list.filter((f) => f.k !== k);
    else list.unshift({ k, name: String(name || t('dropped_pin')).slice(0, 60), lat: +(+p.lat).toFixed(6), lng: +(+p.lng).toFixed(6), g: p.group || 'other' });
    localStorage.setItem('trackly-favs', JSON.stringify(list.slice(0, 60)));
    syncSettings(); drawFavs();
    if (had) toastUndo(t('fav_removed'), () => { localStorage.setItem('trackly-favs', JSON.stringify(before)); syncSettings(); drawFavs(); });
    else toast(t('fav_added'));
    return !had;
  }
  function drawFavs() {
    if (!map.m) return;
    if (map.favs) { map.m.removeLayer(map.favs); map.favs = null; }
    const g = L.layerGroup();
    for (const f of favs()) {
      L.marker([f.lat, f.lng], { keyboard: false, zIndexOffset: 800, icon: L.divIcon({ className: '', iconSize: [26, 26], iconAnchor: [13, 13], html: '<div class="fav-pin"><svg viewBox="0 0 24 24"><path d="' + STAR + '"/></svg></div>' }) })
        .on('click', () => showPlace({ id: 'fav', lat: f.lat, lng: f.lng, group: PLACE_GROUPS[f.g] ? f.g : 'other', tags: { name: f.name } })).addTo(g);
    }
    map.favs = g.addTo(map.m);
  }
  // star + share buttons on a place card
  function wirePlaceTools(box, p, name) {
    const fav = box.querySelector('[data-pa="fav"]'), share = box.querySelector('[data-pa="share"]');
    if (!fav || !share) return;
    const paint = (on) => {
      fav.classList.toggle('on', on);
      fav.innerHTML = '<svg viewBox="0 0 24 24"><path d="' + STAR + '"/></svg>';
      fav.setAttribute('aria-label', on ? t('fav_remove') : t('fav_add'));
      fav.setAttribute('aria-pressed', String(on));
    };
    paint(favs().some((f) => f.k === favKey(p)));
    fav.addEventListener('click', () => paint(toggleFav(p, name)));
    share.innerHTML = SHARE_SVG;
    share.setAttribute('aria-label', t('share_place'));
    share.addEventListener('click', async () => {
      const url = placeLink(p.lat, p.lng, name);
      try {
        if (navigator.share) await navigator.share({ title: name, text: name, url });
        else { await navigator.clipboard.writeText(name + ' ' + url); toast(t('copied')); }
      } catch (e) { /* closed */ }
    });
  }
  function addRecent(r) {
    const k = favKey(r);
    const list = recents().filter((x) => favKey(x) !== k);
    list.unshift({ name: String(r.name).slice(0, 60), sub: String(r.sub || '').slice(0, 80), lat: +(+r.lat).toFixed(6), lng: +(+r.lng).toFixed(6), group: r.group || null });
    try { localStorage.setItem('trackly-recent', JSON.stringify(list.slice(0, 8))); } catch (e) { /* full */ }
  }
  function searchItem(r, icon) {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    const g = r.group && PLACE_GROUPS[r.group] ? r.group : null;
    b.innerHTML = '<span class="place-dot" style="--c:' + (icon === 'star' ? '#E0A100' : icon === 'recent' ? '#64748B' : (g ? PLACE_GROUPS[g].color : '#64748B')) + '">' +
      (icon === 'star' ? '<svg viewBox="0 0 24 24"><path d="' + STAR + '"/></svg>' : icon === 'recent' ? '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/></svg>' : placeIcon(g || 'other')) +
      '</span><span class="sr-text"><strong></strong><span></span></span>';
    b.querySelector('strong').textContent = r.name;
    const from = state.me || state.recent[0];
    b.querySelector('.sr-text span').textContent = [r.sub, from ? fmtDistance(distanceM(from, r)) : ''].filter(Boolean).join(' · ');
    b.addEventListener('click', () => {
      closeSearch();
      if (icon !== 'star') addRecent(r);
      state.followBag = false; updateCenterBtn();
      if (state.tab !== 'map') switchTab('map');
      map.m.setView([r.lat, r.lng], 17);
      if (map.searchPin) map.m.removeLayer(map.searchPin);
      map.searchPin = L.marker([r.lat, r.lng], { icon: L.divIcon({ className: '', iconSize: [34, 42], iconAnchor: [17, 40], html: '<div class="search-pin"></div>' }) }).addTo(map.m);
      showPlace({ id: 'search', lat: r.lat, lng: r.lng, group: g || 'other', tags: { name: r.name } });
    });
    li.appendChild(b);
    return li;
  }
  function renderSearchHome() {
    const list = $('#map-search-results');
    list.innerHTML = '';
    const head = (txt, btn) => {
      const li = document.createElement('li'); li.className = 'sr-head';
      const s = document.createElement('span'); s.textContent = txt; li.appendChild(s);
      if (btn) li.appendChild(btn);
      list.appendChild(li);
    };
    const f = favs(), r = recents();
    if (f.length) { head(t('fav_title')); f.forEach((x) => list.appendChild(searchItem({ name: x.name, sub: t('pg_' + (PLACE_GROUPS[x.g] ? x.g : 'other')), lat: x.lat, lng: x.lng, group: x.g }, 'star'))); }
    if (r.length) {
      const clear = document.createElement('button');
      clear.type = 'button'; clear.className = 'link-btn tiny-link'; clear.textContent = t('recent_clear');
      clear.addEventListener('click', () => { const old = localStorage.getItem('trackly-recent'); localStorage.removeItem('trackly-recent'); renderSearchHome(); toastUndo(t('recent_cleared'), () => { localStorage.setItem('trackly-recent', old); renderSearchHome(); }); });
      head(t('recent_title'), clear);
      r.forEach((x) => list.appendChild(searchItem(x, 'recent')));
    }
    if (!f.length && !r.length) { const li = document.createElement('li'); li.className = 'empty'; li.textContent = t('search_hint'); list.appendChild(li); }
  }

  // =====================================================================
  // UPDATES — a new version was published: "Tap to update"
  // =====================================================================
  function watchForUpdates() {
    if (!('serviceWorker' in navigator)) return;
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register('sw.js').then((reg) => {
      reg.addEventListener('updatefound', () => {
        const w = reg.installing;
        if (!w) return;
        w.addEventListener('statechange', () => { if (w.state === 'activated' && hadController) $('#update-pill').hidden = false; });
      });
      // look again whenever Trackly comes back to the front (at most every 30 min)
      let last = Date.now();
      document.addEventListener('visibilitychange', () => { if (!document.hidden && Date.now() - last > 30 * 60e3) { last = Date.now(); reg.update().catch(() => {}); } });
    }).catch(() => {});
  }

  // =====================================================================
  // WHAT'S NEW — shown once after an update (not to brand-new users)
  // =====================================================================
  function maybeWhatsNew() {
    if (!state.tracker || localStorage.getItem('trackly-seen-version') === APP_VERSION) return;
    localStorage.setItem('trackly-seen-version', APP_VERSION);
    setTimeout(() => { if ($('#view-app').hidden || !$('#nav-banner').hidden) return; $('#new-view').hidden = false; }, 1200);
  }

  // =====================================================================
  // ONE-GLANCE STATUS on the bag card: "All good" / "Safe at Home" / "Battery low" / "No signal" / "Lost mode"
  // =====================================================================
  function renderHealth(loc, o) {
    const el = $('#bag-health');
    if (!el) return;
    let level = 'ok', text;
    if (!loc) { level = 'wait'; text = t('h_wait'); }
    else if (o.lost) { level = 'bad'; text = t('h_lost'); }
    else if (o.stale) { level = 'warn'; text = t('h_nosignal', { t: relTime(o.age) }); }
    else if (o.battery !== null && o.battery <= CFG.lowBatteryPercent) { level = 'warn'; text = t('h_battery', { n: o.battery }); }
    else if (o.moving && o.kmh >= 2) { level = 'move'; text = t('h_moving', { n: o.kmh }); }
    else if (o.inZone) text = t('h_safe', { z: o.inZone.name });
    else text = t('h_ok');
    el.className = 'bag-health ' + level;
    el.querySelector('span').textContent = text;
  }

  // =====================================================================
  // UNDO — a short message with an Undo button after removing something
  // =====================================================================
  function hideToast() {
    const el = $('#toast');
    el.classList.remove('in');
    setTimeout(() => { if (!el.classList.contains('in')) el.hidden = true; }, 220);
  }
  function toastUndo(msg, onUndo) {
    toast(msg);
    const el = $('#toast');
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'toast-undo'; b.textContent = t('undo');
    b.addEventListener('click', () => { onUndo(); hideToast(); });
    el.appendChild(b);
    el.classList.add('has-action');
    clearTimeout(toast._t);
    toast._t = setTimeout(hideToast, 6000);
  }

  // =====================================================================
  // ALERTS BELL — every alert in one place (the server's and this phone's), with an unread count
  // =====================================================================
  let alertCache = [];
  async function allAlerts() {
    const server = CFG.fakeBackend ? null : await serverAlerts();
    alertCache = (server || []).concat(alertList()).sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
    updateBell();
    return alertCache;
  }
  function updateBell() {
    const seen = Number(localStorage.getItem('trackly-alerts-seen')) || 0;
    const n = alertCache.filter((a) => new Date(a.at).getTime() > seen).length;
    const c = $('#bell-count');
    if (!c) return;
    c.hidden = !n;
    c.textContent = n > 9 ? '9+' : String(n);
    $('#bell-btn').setAttribute('aria-label', n ? t('alerts_n', { n }) : t('alerts'));
  }
  async function openAlerts() {
    $('#alerts-view').hidden = false;
    await renderAlerts($('#alerts-view-list'), 40);
    localStorage.setItem('trackly-alerts-seen', String(Date.now()));
    updateBell();
  }

  // =====================================================================
  // TEXT SIZE — Normal, Large, Extra large (Account → Appearance)
  // =====================================================================
  const SIZES = ['normal', 'large', 'xl'];
  function applySize(v, quiet) {
    const s = SIZES.includes(v) ? v : 'normal';
    localStorage.setItem('trackly-size', s);
    if (s === 'normal') delete document.documentElement.dataset.size; else document.documentElement.dataset.size = s;
    $$('#size-seg .seg').forEach((b) => b.classList.toggle('active', b.dataset.size === s));
    if (!quiet) syncSettings();
  }

  // =====================================================================
  // ACCOUNT — jump straight to a section
  // =====================================================================
  function accJump(id) {
    const sec = document.getElementById(id);
    if (!sec) return;
    if (state.snap !== 'full') setSnap('full');
    setTimeout(() => sec.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' }), 260);
  }

  // =====================================================================
  // PROFESSIONAL MAP STYLE — OpenFreeMap "Liberty" (free, no key), tuned like Google Maps:
  //  - every kind of place with its own icon (hospital, pharmacy, school, mosque, café, bank, fuel…)
  //  - labels never overlap and fade in/out while zooming (done by the map engine)
  //  - places appear sooner; hospitals, universities, malls and stadiums already from zoom 12
  //  - place names coloured by type, map labels in the app's language
  //  - dark mode: the same detailed map, recoloured to deep navy (with all places)
  // =====================================================================
  const POI_GROUPS = {
    health: ['hospital', 'pharmacy', 'doctors', 'dentist', 'clinic', 'veterinary'],
    food: ['restaurant', 'fast_food', 'cafe', 'bar', 'ice_cream', 'beer', 'pub', 'bakery'],
    shop: ['shop', 'grocery', 'clothing_store', 'alcohol_shop', 'butcher', 'jewelry', 'mobile_phone', 'shoes', 'furniture', 'florist',
      'gift', 'hardware', 'music', 'toys', 'electronics', 'supermarket', 'mall', 'department_store', 'laundry', 'bicycle'],
    money: ['bank', 'atm', 'bureau_de_change'],
    fuel: ['fuel', 'charging_station'],
    worship: ['place_of_worship'],
    edu: ['school', 'college', 'kindergarten', 'library', 'university'],
    hotel: ['lodging'],
    park: ['park', 'garden', 'playground', 'pitch', 'stadium', 'sports_centre', 'swimming', 'golf'],
    car: ['car', 'car_repair', 'car_wash', 'car_rental', 'parking'],
    gov: ['town_hall', 'police', 'post', 'fire_station', 'embassy', 'courthouse', 'prison'],
    fun: ['cinema', 'theatre', 'attraction', 'museum', 'art_gallery', 'zoo', 'theme_park', 'castle', 'monument', 'aquarium']
  };
  const POI_TEXT = {   // label colour per type (darker on the light map, lighter on the dark one)
    light: { health: '#be185d', food: '#c2410c', shop: '#6d28d9', money: '#0369a1', fuel: '#475569', worship: '#4d7c0f', edu: '#a16207', hotel: '#4338ca', park: '#15803d', car: '#0f766e', gov: '#334155', fun: '#a21caf', other: '#57534e' },
    dark: { health: '#f9a8d4', food: '#fdba74', shop: '#c4b5fd', money: '#7dd3fc', fuel: '#cbd5e1', worship: '#bef264', edu: '#fde68a', hotel: '#a5b4fc', park: '#86efac', car: '#5eead4', gov: '#cbd5e1', fun: '#f0abfc', other: '#d6d3d1' }
  };
  const POI_LAYERS = ['poi_r1', 'poi_r7', 'poi_r20', 'trackly-major'];
  const poiBaseFilters = {};
  let libertyBase = (() => {
    try {
      const c = JSON.parse(localStorage.getItem('trackly-liberty'));
      if (c && c.s && c.s.layers) { if (Date.now() - c.at > 7 * 86400e3) setTimeout(() => loadLiberty().catch(() => {}), 8000); return c.s; }
    } catch (e) { /* none saved */ }
    return null;
  })();
  const styleCache = {};

  function poiColorExpr(dark) {
    const c = POI_TEXT[dark ? 'dark' : 'light'];
    const expr = ['match', ['get', 'class']];
    for (const [g, classes] of Object.entries(POI_GROUPS)) expr.push(classes, c[g]);
    expr.push(c.other);
    return expr;
  }
  // map labels in the app's language (falls back to the local name)
  function nameExpr() {
    if (state.lang === 'ar') return ['coalesce', ['get', 'name:ar'], ['get', 'name']];
    if (state.lang === 'ckb') return ['coalesce', ['get', 'name:ckb'], ['get', 'name:ku'], ['get', 'name']];
    return ['coalesce', ['get', 'name:en'], ['get', 'name_en'], ['get', 'name:latin'], ['get', 'name']];
  }

  // ---- dark navy version: walk every colour in the style and recolour it ----
  function parseColor(c) {
    if (typeof c !== 'string') return null;
    let m, r, g, b, a = 1;
    if ((m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c))) {
      let h = m[1]; if (h.length === 3) h = h.split('').map((x) => x + x).join('');
      r = parseInt(h.slice(0, 2), 16); g = parseInt(h.slice(2, 4), 16); b = parseInt(h.slice(4, 6), 16);
    } else if ((m = /^rgba?\(([^)]+)\)$/i.exec(c))) {
      const p = m[1].split(',').map((x) => parseFloat(x)); [r, g, b] = p; if (p.length > 3) a = p[3];
    } else if ((m = /^hsla?\(([^)]+)\)$/i.exec(c))) {
      const p = m[1].split(',').map((x) => parseFloat(x));
      return { h: p[0], s: p[1] / 100, l: p[2] / 100, a: p.length > 3 ? p[3] : 1 };
    } else return null;
    r /= 255; g /= 255; b /= 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
    let h = 0, s = 0;
    if (mx !== mn) {
      const d = mx - mn; s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
      h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; h *= 60;
    }
    return { h, s, l, a };
  }
  const hsla = (o) => 'hsla(' + Math.round(o.h) + ', ' + Math.round(o.s * 100) + '%, ' + Math.round(o.l * 100) + '%, ' + o.a + ')';
  function darkColor(str, prop) {
    const c = parseColor(str);
    if (!c) return str;
    const water = c.h >= 180 && c.h <= 250 && c.s > 0.2;
    const neutral = c.s < 0.12;
    let o;
    if (prop === 'text-color') o = { h: neutral ? 215 : c.h, s: neutral ? 0.15 : c.s * 0.6, l: 0.93 - c.l * 0.5, a: c.a };
    else if (prop === 'text-halo-color') o = { h: 222, s: 0.35, l: 0.09, a: c.a };
    else if (prop === 'line-color') o = water ? { h: c.h, s: 0.4, l: 0.24, a: c.a } : { h: neutral ? 218 : c.h, s: neutral ? 0.2 : c.s * 0.55, l: 0.17 + 0.24 * c.l, a: c.a };
    else if (water) o = { h: c.h, s: 0.4, l: 0.17, a: c.a };
    else o = { h: neutral ? 222 : c.h, s: neutral ? 0.28 : c.s * 0.45, l: 0.075 + (1 - c.l) * 0.3, a: c.a };
    return hsla(o);
  }
  function walkColors(v, fn) {
    if (typeof v === 'string') return fn(v);
    if (Array.isArray(v)) return v.map((x) => walkColors(x, fn));
    if (v && typeof v === 'object') { const o = {}; for (const k in v) o[k] = walkColors(v[k], fn); return o; }
    return v;
  }
  function darkify(style) {
    style.layers.forEach((l) => {
      if (l.type === 'raster') { l.paint = Object.assign({}, l.paint, { 'raster-opacity': 0.12 }); return; }
      if (!l.paint) return;
      for (const k of Object.keys(l.paint)) if (/color$/.test(k) && k !== 'icon-color') l.paint[k] = walkColors(l.paint[k], (s) => darkColor(s, k));
    });
  }

  // Google-like colours: clearer parks, water, hospitals, schools and buildings; street names a little sooner;
  // neighbourhood names in calm grey capitals. Applied to the light style (the dark one is recoloured from it).
  function tuneBaseMap(s) {
    const set = (id, prop, v) => { const l = s.layers.find((x) => x.id === id); if (l) { l.paint = l.paint || {}; l.paint[prop] = v; } };
    const lay = (id, prop, v) => { const l = s.layers.find((x) => x.id === id); if (l) { l.layout = l.layout || {}; l.layout[prop] = v; } };
    const zoom = (id, z) => { const l = s.layers.find((x) => x.id === id); if (l) l.minzoom = z; };
    set('background', 'background-color', '#F5F3EE');
    set('landuse_residential', 'fill-color', '#EFECE6');
    set('park', 'fill-color', '#C9E7BE'); set('park_outline', 'line-color', '#B5DCA6');
    set('landcover_grass', 'fill-color', '#CDE9C2'); set('landcover_wood', 'fill-color', 'rgba(170, 214, 150, 0.75)');
    set('landuse_pitch', 'fill-color', '#C8E8BE'); set('landuse_track', 'fill-color', '#C8E8BE');
    set('landuse_cemetery', 'fill-color', '#DAE6CF');
    set('landuse_hospital', 'fill-color', '#F9DDE2');
    set('landuse_school', 'fill-color', '#F4EED6');
    set('water', 'fill-color', '#A6D3F5');
    ['waterway_river', 'waterway_other', 'waterway_tunnel'].forEach((id) => set(id, 'line-color', '#A6D3F5'));
    set('building', 'fill-color', '#E7E3DB'); set('building', 'fill-outline-color', '#D7D1C6');
    set('building-3d', 'fill-extrusion-color', '#E7E3DB');
    set('road_minor_casing', 'line-color', '#DAD6CF'); set('road_service_track_casing', 'line-color', '#DFDBD4');
    set('road_trunk_primary', 'line-color', '#FFE597'); set('road_secondary_tertiary', 'line-color', '#FFF1B8');
    set('road_trunk_primary_casing', 'line-color', '#EDC66A'); set('road_secondary_tertiary_casing', 'line-color', '#E9CF86');
    zoom('highway-name-minor', 14.5); zoom('highway-name-path', 15);
    set('highway-name-minor', 'text-color', '#5F6368'); set('highway-name-major', 'text-color', '#4A4E54');
    set('label_other', 'text-color', '#7A7E85'); lay('label_other', 'text-transform', 'uppercase'); lay('label_other', 'text-letter-spacing', 0.08);
    ['label_city', 'label_city_capital', 'label_town', 'label_village'].forEach((id) => { set(id, 'text-color', '#33373D'); set(id, 'text-halo-width', 1.6); set(id, 'text-halo-color', '#FFFFFF'); });
  }
  async function buildMapStyle(dark) {
    if (!libertyBase) await loadLiberty();
    return makeMapStyle(dark);
  }
  // the base style is saved on the phone, so next time the map opens in one step (refreshed weekly)
  async function loadLiberty() {
    libertyBase = await (await fetch('https://tiles.openfreemap.org/styles/liberty')).json();
    try { localStorage.setItem('trackly-liberty', JSON.stringify({ at: Date.now(), s: libertyBase })); } catch (e) { /* storage full */ }
  }
  function makeMapStyle(dark) {
    const key = (dark ? 'd' : 'l') + state.lang;
    if (styleCache[key]) return styleCache[key];
    const s = JSON.parse(JSON.stringify(libertyBase));
    const name = nameExpr();
    const minz = { poi_r1: 13, poi_r7: 14, poi_r20: 15 };
    tuneBaseMap(s);
    if (dark) darkify(s);   // recolour first, so the bright place-label colours below stay bright
    s.layers.forEach((l) => {
      const tf = l.layout && l.layout['text-field'];
      if (tf && JSON.stringify(tf).includes('"name')) l.layout['text-field'] = name;
      if (l['source-layer'] === 'poi' && minz[l.id] != null) {
        l.minzoom = minz[l.id];
        l.layout['text-font'] = ['Noto Sans Regular'];
        l.layout['text-size'] = 11.5;
        l.layout['icon-size'] = 1.05;
        l.paint = Object.assign({}, l.paint, { 'text-color': poiColorExpr(dark), 'text-halo-width': 1.4, 'text-halo-blur': 0.3 });
      }
    });
    // the important places, visible sooner and with priority over smaller ones (layers on top are placed first)
    s.layers.push({
      id: 'trackly-major', type: 'symbol', source: 'openmaptiles', 'source-layer': 'poi', minzoom: 12,
      filter: ['all', ['match', ['geometry-type'], ['MultiPoint', 'Point'], true, false],
        ['any', ['match', ['get', 'class'], ['hospital', 'college', 'stadium', 'museum', 'attraction'], true, false],
          ['match', ['get', 'subclass'], ['mall', 'department_store', 'university', 'hospital'], true, false]]],
      layout: { 'icon-image': ['get', 'class'], 'icon-size': 1.2, 'text-field': name, 'text-font': ['Noto Sans Bold'], 'text-size': 12,
        'text-anchor': 'top', 'text-offset': [0, 0.75], 'text-max-width': 8, 'symbol-sort-key': ['get', 'rank'] },
      paint: { 'text-color': poiColorExpr(dark), 'text-halo-color': dark ? '#0b1428' : '#ffffff', 'text-halo-width': 1.6 }
    });
    // house numbers on the buildings when zoomed right in
    s.layers.push({ id: 'trackly-housenumber', type: 'symbol', source: 'openmaptiles', 'source-layer': 'housenumber', minzoom: 17,
      layout: { 'text-field': ['get', 'housenumber'], 'text-font': ['Noto Sans Regular'], 'text-size': 10, 'text-padding': 2 },
      paint: { 'text-color': dark ? '#8b93a3' : '#8a8580', 'text-halo-color': dark ? '#0b1428' : '#ffffff', 'text-halo-width': 1 } });
    s.layers.forEach((l) => { if (POI_LAYERS.includes(l.id)) poiBaseFilters[l.id] = l.filter; });
    styleCache[key] = s;
    return s;
  }

  // category chips filter the map's own place icons
  function applyPoiFilter(gl) {
    try {
      const all = places.filter.size >= Object.keys(PLACE_GROUPS).length - 1;
      const classes = [].concat(...[...places.filter].map((g) => POI_GROUPS[g] || []));
      for (const id of POI_LAYERS) {
        if (!gl.getLayer(id)) continue;
        const base = poiBaseFilters[id];
        gl.setFilter(id, all || !classes.length ? base : ['all', base, ['match', ['get', 'class'], classes, true, false]]);
      }
    } catch (e) { /* style still loading */ }
  }
  function mapGl() { return map.tiles && map.tiles.getMaplibreMap ? map.tiles.getMaplibreMap() : null; }

  // tap a place icon on the map → the place card
  function tapMapPlace(latlng) {
    const gl = mapGl();
    if (!gl || !places.on) return false;
    const pt = gl.project([latlng.lng, latlng.lat]);
    let feats = [];
    try { feats = gl.queryRenderedFeatures([[pt.x - 14, pt.y - 14], [pt.x + 14, pt.y + 14]], { layers: POI_LAYERS.filter((id) => gl.getLayer(id)) }); } catch (e) { return false; }
    const f = feats.find((x) => x.properties && x.properties.name);
    if (!f) return false;
    const p = f.properties, [lng, lat] = f.geometry.coordinates;
    showPlace({ id: 'tap', lat, lng, group: vectorGroup(p.class, p.subclass),
      tags: { name: p.name, 'name:en': p['name:en'] || p.name_en, 'name:ar': p['name:ar'], 'name:ckb': p['name:ckb'] || p['name:ku'], kind: p.subclass || p.class } });
    return true;
  }
  // new language → map labels in that language
  async function refreshMapLanguage() {
    const gl = mapGl();
    if (!gl || state.mapStyle === 'sat' || state.mapStyle === 'hybrid') return;
    gl.setStyle(await buildMapStyle(isDark()));
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
    car: { color: '#0F766E', icon: 'M5 16V11l2-5h10l2 5v5M3 16h18v3h-3v-1H6v1H3z' },
    gov: { color: '#334155', icon: 'M3 21h18M4 10h16M6 10v9M10 10v9M14 10v9M18 10v9M12 3l8 5H4z' },
    fun: { color: '#C026D3', icon: 'M12 3l2.6 5.6 6.1.7-4.5 4.2 1.2 6L12 16.6l-5.4 2.9 1.2-6-4.5-4.2 6.1-.7z' },
    other: { color: '#64748B', icon: 'M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21zM12 7.5a2 2 0 1 0 0 4 2 2 0 0 0 0-4z' }
  };
  const placeIcon = (g) => '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="' + PLACE_GROUPS[g].icon + '"/></svg>';
  function placeGroup(tags) {
    const a = tags.amenity, tt = tags.tourism, l = tags.leisure;
    if (/^(restaurant|cafe|fast_food|ice_cream|food_court|bar)$/.test(a)) return 'food';
    if (/^(car|car_repair|tyres|car_parts)$/.test(tags.shop) || /^(car_wash|car_rental|parking)$/.test(a)) return 'car';
    if (/^(police|townhall|courthouse|embassy|post_office|fire_station)$/.test(a) || tags.office === 'government') return 'gov';
    if (/^(cinema|theatre|arts_centre)$/.test(a) || /^(attraction|museum|theme_park|zoo|gallery)$/.test(tt) || /^(water_park|amusement_arcade)$/.test(l)) return 'fun';
    if (tags.shop) return 'shop';
    if (/^(pharmacy|hospital|clinic|doctors|dentist)$/.test(a)) return 'health';
    if (/^(bank|atm|bureau_de_change)$/.test(a)) return 'money';
    if (a === 'fuel' || a === 'charging_station') return 'fuel';
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
  const PLACE_FILTER = '["name"]["amenity"~"^(restaurant|cafe|fast_food|ice_cream|food_court|pharmacy|hospital|clinic|doctors|dentist|bank|atm|bureau_de_change|fuel|charging_station|place_of_worship|school|university|college|kindergarten|police|post_office|cinema|marketplace|car_wash|car_rental|townhall|courthouse|embassy|fire_station|theatre|arts_centre)$"]';
  function placesQuery(area, limit) {
    return '[out:json][timeout:20];(' +
      'nwr' + PLACE_FILTER + area + ';' +
      'nwr["name"]["shop"]' + area + ';' +
      'nwr["name"]["tourism"~"^(hotel|guest_house|hostel|attraction|museum|viewpoint|theme_park|zoo|gallery)$"]' + area + ';' +
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
    if (/^(car|car_repair|car_wash|car_rental|parking)$/.test(c) || /^(car|car_repair|car_wash|car_rental)$/.test(s)) return 'car';
    if (/^(town_hall|police|post|fire_station|embassy|courthouse|prison)$/.test(c)) return 'gov';
    if (/^(cinema|theatre|attraction|museum|art_gallery|zoo|theme_park|castle|monument|aquarium)$/.test(c)) return 'fun';
    if (c === 'place_of_worship' || s === 'place_of_worship' || /^(mosque|church)$/.test(s)) return 'worship';
    if (/^(school|college|university|kindergarten)$/.test(c) || /^(school|college|university|kindergarten)$/.test(s)) return 'edu';
    if (c === 'lodging' || /^(hotel|guest_house|hostel)$/.test(s)) return 'hotel';
    if (/^(park|garden)$/.test(c) || /^(park|garden)$/.test(s)) return 'park';
    if (c === 'shop' || /_store$|_shop$/.test(c) || /^(grocery|bakery|mall|supermarket|clothes|convenience|electronics|mobile_phone|jewelry|shoes|butcher|greengrocer|department_store)$/.test(c + '|' + s) || c === 'grocery') return 'shop';
    return 'other';
  }
  function setMapPoiLabels(gl) {
    try {
      // change only what differs: setting it fires 'styledata' again, so this must not loop
      const want = places.on ? 'visible' : 'none';
      (gl.getStyle().layers || []).filter((l) => l['source-layer'] === 'poi' && l.id !== 'poi_transit').forEach((l) => {
        if ((gl.getLayoutProperty(l.id, 'visibility') || 'visible') !== want) gl.setLayoutProperty(l.id, 'visibility', want);
      });
    } catch (e) { /* style still loading */ }
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
      const tags = { name: p.name, 'name:en': p.name_en || p['name:en'], 'name:ar': p['name:ar'], 'name:ckb': p['name:ckb'] || p['name:ku'], kind: p.subclass || p.class, rank: p.rank };
      places.all.set(id, { id, lat, lng, tags, group: vectorGroup(p.class, p.subclass) });
      n++;
    }
    return n;
  }

  async function loadPlaces() {
    if (!places.on || !map.m || state.tab === 'history' || state.zoneEdit) return;
    if (map.m.getZoom() < 14) { renderPlaces(); return; }
    const gl = map.tiles && map.tiles.getMaplibreMap && map.tiles.getMaplibreMap();
    if (gl) {
      // vector map: read places when its tiles have loaded (and again after each move)
      if (!gl._tracklyHooked) {
        gl._tracklyHooked = true;
        gl.on('idle', () => { if (harvestVectorPlaces()) { renderPlaces(); if (state.recent[0]) updateNear(state.recent[0]); } });
        gl.on('styledata', () => setMapPoiLabels(gl));
      }
      setMapPoiLabels(gl);
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
    $('#btn-places').setAttribute('aria-checked', String(places.on));
    $('#places-bar').hidden = !places.on || state.tab !== 'map' || !!state.zoneEdit;
    if (!places.on || state.tab === 'history' || state.zoneEdit) return;
    const zoom = map.m.getZoom();
    const vector = !!mapGl() && state.mapStyle === 'detailed';
    $('#places-hint').hidden = vector || zoom >= 15 || state.tab !== 'map';
    if (vector) { applyPoiFilter(mapGl()); return; }
    if (zoom < 15) return;
    map.m.getContainer().classList.toggle('show-place-names', zoom >= 17);
    const b = map.m.getBounds().pad(0.1);
    // one place per little square of the screen (no piles), the most important ones first
    const cell = zoom >= 18 ? 30 : (zoom >= 17 ? 40 : (zoom >= 16 ? 52 : 64));
    const GROUP_ORDER = { shop: 2, food: 3, health: 1, money: 4, fuel: 4, worship: 3, edu: 3, hotel: 2, park: 2, other: 6 };
    const list = [...places.all.values()].filter((p) => places.filter.has(p.group) && b.contains([p.lat, p.lng]))
      .sort((a, c) => ((a.tags.rank ?? 30) + GROUP_ORDER[a.group] * 2) - ((c.tags.rank ?? 30) + GROUP_ORDER[c.group] * 2));
    const used = new Set();
    let shown = 0;
    for (const p of list) {
      if (shown >= 400) break;
      const pt = map.m.latLngToContainerPoint([p.lat, p.lng]);
      const key = Math.floor(pt.x / cell) + ':' + Math.floor(pt.y / cell);
      if (used.has(key)) continue;
      used.add(key);
      // the name goes to the right of the dot: only if those squares are free too
      let showName = zoom >= 17;
      if (showName) {
        const w = Math.min(160, placeName(p.tags).length * 6.5 + 10), row = Math.floor(pt.y / cell);
        for (let x = pt.x + 16; x < pt.x + 16 + w; x += cell / 2) { if (used.has(Math.floor(x / cell) + ':' + row + 'n')) { showName = false; break; } }
        if (showName) for (let x = pt.x + 16; x < pt.x + 16 + w; x += cell / 2) used.add(Math.floor(x / cell) + ':' + row + 'n');
      }
      const g = PLACE_GROUPS[p.group];
      const m = L.marker([p.lat, p.lng], {
        keyboard: false, riseOnHover: true,
        icon: L.divIcon({ className: '', iconSize: [26, 26], iconAnchor: [13, 13],
          html: '<div class="place" style="--c:' + g.color + '"><span class="place-dot">' + placeIcon(p.group) + '</span><span class="place-name"></span></div>' })
      });
      m.on('add', function () { const n = this.getElement().querySelector('.place-name'); n.textContent = placeName(p.tags); n.classList.toggle('no-name', !showName); });
      m.on('click', () => showPlace(p));
      m.addTo(map.places);
      shown++;
    }
  }

  function renderPlacesBar() {
    const bar = $('#places-bar');
    bar.innerHTML = '';
    const ph = document.createElement('button');
    ph.type = 'button'; ph.className = 'pchip on pchip-go'; ph.dataset.action = 'open-pharmacy';
    ph.style.setProperty('--c', PLACE_GROUPS.health.color);
    ph.innerHTML = placeIcon('health') + '<span></span>';
    ph.querySelector('span').textContent = t('ph_btn');
    bar.appendChild(ph);
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
    syncSettings();
    if (places.on && map.m.getZoom() < 15) toast(t('places_zoom'));
    renderPlaces(); loadPlaces();
    const gl = map.tiles && map.tiles.getMaplibreMap && map.tiles.getMaplibreMap();
    if (gl) setMapPoiLabels(gl);
  }

  // Tap a place: name, type, address, hours, phone + Directions / Safe zone here
  function showPlace(p) {
    const box = document.createElement('div');
    box.className = 'bi';
    const g = PLACE_GROUPS[p.group];
    box.innerHTML = '<div class="pl-head"><span class="place-dot big" style="--c:' + g.color + '">' + placeIcon(p.group) + '</span>' +
      '<div><strong class="bi-title"></strong><span class="pl-type"></span></div><span class="pl-tools"><button type="button" class="icon-btn small" data-pa="share"></button><button type="button" class="icon-btn small fav-btn" data-pa="fav"></button></span></div><dl class="bi-grid"></dl>' +
      '<div class="bi-actions"><button type="button" class="btn btn-secondary" data-pa="zone"></button><button type="button" class="btn btn-primary" data-pa="go"></button></div>';
    box.querySelector('.bi-title').textContent = placeName(p.tags);
    wirePlaceTools(box, p, placeName(p.tags));
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
    const openSt = openNow(p.tags.opening_hours);
    row('open_hours', p.tags.opening_hours && (p.tags.opening_hours + (openSt === true ? ' · ' + t('open_now') : openSt === false ? ' · ' + t('closed_now') : '')));
    const phone = p.tags.phone || p.tags['contact:phone'];
    row('phone', phone, phone ? 'tel:' + phone.replace(/\s/g, '') : null);
    const loc = state.recent[0];
    if (loc) row('from_bag', fmtDistance(distanceM(loc, p)));
    const etaDt = document.createElement('dt'), etaDd = document.createElement('dd');
    etaDt.textContent = t('travel_time'); etaDd.className = 'eta';
    dl.append(etaDt, etaDd);
    fillEta(etaDd, p);
    box.querySelector('[data-pa="zone"]').textContent = t('zone_here');
    box.querySelector('[data-pa="go"]').textContent = t('directions');
    box.querySelector('[data-pa="go"]').addEventListener('click', () => openRoute(p, placeName(p.tags)));
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
    renderSearchHome();
    setTimeout(() => $('#map-search').focus(), 50);
  }
  function closeSearch() { $('#search-panel').hidden = true; $('#map-search').blur(); }
  function onMapSearch(e) {
    clearTimeout(mapSearchTimer);
    const q = e.target.value.trim();
    const list = $('#map-search-results');
    if (q.length < 2) { renderSearchHome(); return; }
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
      const addLink = () => { const li = document.createElement('li'); li.className = 'empty add-place'; const a = document.createElement('a'); a.target = '_blank'; a.rel = 'noopener';
        a.href = 'https://www.openstreetmap.org/note/new#map=18/' + c.lat.toFixed(5) + '/' + c.lng.toFixed(5); a.textContent = t('add_place'); li.appendChild(a); list.appendChild(li); };
      if (!all.length) { const li = document.createElement('li'); li.className = 'empty'; li.textContent = t('no_results'); list.appendChild(li); addLink(); return; }
      all.forEach((r) => list.appendChild(searchItem(r)));
      addLink();
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
      if (was && !now) fireReminders(z, 'leave');
      if (!was && now) fireReminders(z, 'arrive');
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
  async function renderAlerts(target, max) {
    const ul = target || $('#alert-list');
    if (!ul) return;
    const list = await allAlerts();   // the server's alerts and this phone's (reminders, new place, night guard…)
    ul.innerHTML = '';
    if (!list.length) { const li = document.createElement('li'); li.className = 'empty'; li.textContent = t('no_alerts'); ul.appendChild(li); return; }
    list.slice(0, max || 8).forEach((a) => {
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
  // Bottom card with 3 snap points (like Google Maps): small, medium, full.
  // Drag the handle (it follows your finger), or tap it to switch small ↔ medium.
  const SNAPS = ['peek', 'half', 'full'];
  function setSnap(name) {
    const sheet = $('#sheet');
    sheet.style.maxHeight = '';
    SNAPS.forEach((n) => sheet.classList.toggle('snap-' + n, n === name));
    sheet.classList.toggle('collapsed', name === 'peek');
    $('#sheet-handle').setAttribute('aria-expanded', String(name !== 'peek'));
    state.snap = name;
  }
  function setupSheetDrag() {
    const sheet = $('#sheet'), handle = $('#sheet-handle');
    let y0 = null, h0 = 0, moved = false, t0 = 0;
    setSnap('half');
    handle.addEventListener('pointerdown', (e) => {
      y0 = e.clientY; h0 = sheet.offsetHeight; moved = false; t0 = performance.now();
      handle.setPointerCapture(e.pointerId);
      sheet.classList.add('dragging');
    });
    handle.addEventListener('pointermove', (e) => {
      if (y0 === null) return;
      const dy = e.clientY - y0;
      if (Math.abs(dy) > 4) moved = true;
      let want = h0 - dy;
      const lo = 110, hi = innerHeight * 0.9;
      if (want > hi) want = hi + (want - hi) * 0.25;      // rubber band at the top
      if (want < lo) want = lo - (lo - want) * 0.25;      // ...and at the bottom
      sheet.style.maxHeight = want + 'px';
    });
    const end = (e) => {
      if (y0 === null) return;
      sheet.classList.remove('dragging');
      const dy = e.clientY - y0, speed = dy / Math.max(1, performance.now() - t0);
      y0 = null;
      if (!moved) { setSnap(state.snap === 'peek' ? 'half' : 'peek'); return; }   // a tap
      const h = h0 - dy, vh = innerHeight;
      // a quick flick goes one step; otherwise the nearest snap point
      let snap;
      if (speed > 0.6) snap = state.snap === 'full' ? 'half' : 'peek';
      else if (speed < -0.6) snap = state.snap === 'peek' ? 'half' : 'full';
      else snap = h < vh * 0.3 ? 'peek' : (h < vh * 0.68 ? 'half' : 'full');
      setSnap(snap);
      if (navigator.vibrate) navigator.vibrate(8);
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  }

  // ----- pull down on History / Safe zones to refresh -----
  function showFabLabels() {
    const n = Number(localStorage.getItem('trackly-opens') || 0) + 1;
    localStorage.setItem('trackly-opens', String(n));
    if (n > 3) return;
    const c = $('#map-controls');
    c.classList.add('show-labels');
    setTimeout(() => c.classList.remove('show-labels'), 6000);
  }

  function setupPullToRefresh() {
    const sheet = $('#sheet'), ptr = $('#ptr');
    let y0 = null, dy = 0;
    sheet.addEventListener('touchstart', (e) => {
      if (sheet.scrollTop > 0 || !(state.tab === 'history' || state.tab === 'zones') || state.zoneEdit) { y0 = null; return; }
      y0 = e.touches[0].clientY; dy = 0;
    }, { passive: true });
    sheet.addEventListener('touchmove', (e) => {
      if (y0 === null) return;
      dy = e.touches[0].clientY - y0;
      if (dy > 0) { ptr.style.height = Math.min(70, dy * 0.5) + 'px'; ptr.classList.toggle('ready', dy > 90); }
    }, { passive: true });
    sheet.addEventListener('touchend', async () => {
      if (y0 === null) return;
      const go = dy > 90;
      y0 = null;
      if (!go) { ptr.style.height = ''; ptr.classList.remove('ready'); return; }
      ptr.classList.add('busy');
      if (navigator.vibrate) navigator.vibrate(10);
      if (state.tab === 'history') await loadHistory();
      else if (state.tracker) {
        const { data } = await sb.from('safe_zones').select('*').eq('tracker_id', state.tracker.id).order('created_at');
        if (data) { state.zones = data; renderZones(); saveCache(); }
      }
      ptr.classList.remove('busy', 'ready'); ptr.style.height = '';
    });
  }

  // ----- instant opening: the last bag, location and zones are kept on the phone -----
  const CACHE_KEY = 'trackly-cache';
  function saveCache() {
    if (!state.user || !state.tracker) return;
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ user: state.user.id, trackers: state.trackers, trackerId: state.tracker.id,
        recent: state.recent.slice(0, 60), zones: state.zones, at: Date.now(), real: !CFG.fakeBackend }));
    } catch (e) { /* storage full */ }
  }
  function readCache() {
    try {
      const c = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
      return c && state.user && c.user === state.user.id && c.real === !CFG.fakeBackend ? c : null;
    } catch (e) { return null; }
  }
  let cacheTimer = null;
  function saveCacheSoon() { clearTimeout(cacheTimer); cacheTimer = setTimeout(saveCache, 1500); }

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
    if (error || !data) { shareLocation(); return; } // fall back to a one-time place link
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
    $('#rp-maps').href = placeLink(loc.lat, loc.lng, state.tracker.name || state.tracker.device_code);
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
    const total = Math.round(mins), h = Math.floor(total / 60), m = total % 60;   // never '60 min'
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
        const night = document.createElement('div'); night.className = 'row-between night-row';
        const nl = document.createElement('div');
        const nt = document.createElement('strong'); nt.textContent = t('night_title');
        const ns = document.createElement('span'); ns.className = 'muted small'; ns.textContent = t('night_sub');
        nl.append(nt, ns);
        const nsw = document.createElement('button'); nsw.type = 'button'; nsw.className = 'switch'; nsw.setAttribute('role', 'switch');
        nsw.setAttribute('aria-checked', String(!!tr.night_saver)); nsw.setAttribute('aria-label', t('night_title'));
        nsw.addEventListener('click', () => setNightSaver(tr, !tr.night_saver));
        night.append(nl, nsw);
        li.appendChild(night);
        const inv = document.createElement('button'); inv.type = 'button'; inv.className = 'btn btn-secondary'; inv.textContent = t('invite_family');
        inv.addEventListener('click', () => inviteFamily(tr));
        const un = document.createElement('button'); un.type = 'button'; un.className = 'btn btn-ghost danger-text'; un.textContent = t('unpair');
        un.addEventListener('click', () => unpair(tr));
        acts.append(inv, un);
      }
      li.append(dot, name, code, colors, fam, acts);
      const nr = li.querySelector('.night-row'); if (nr) li.insertBefore(nr, fam);
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
    syncSettings();
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
    syncSettings();
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
    $('#park-btn [data-i18n]').textContent = on ? t('park_btn_on') : t('park_btn');
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

  // =====================================================================
  // WEEKLY SUMMARY (History tab): distance, active days, top places, time away from home
  // =====================================================================
  let weekFor = null, weekAt = 0;
  async function loadWeekly() {
    if (!state.tracker || (weekFor === state.tracker.id && Date.now() - weekAt < 10 * 60e3)) return;
    weekFor = state.tracker.id; weekAt = Date.now();
    const since = new Date(Date.now() - 7 * 86400e3).toISOString();
    const { data } = await sb.from('locations').select('lat, lng, created_at').eq('tracker_id', state.tracker.id)
      .gte('created_at', since).order('created_at', { ascending: true }).limit(20000);
    const pts = data || [];
    const box = $('#week-card');
    Object.assign(act.bag, bagActivity(pts));
    renderActivity();
    await loadCams();
    $('#week-drives').textContent = String(findDrives(pts).length);
    if (pts.length < 2) { box.hidden = true; return; }
    // distance: skip GPS jitter (< 15 m) and impossible jumps (> 150 km/h)
    let m = 0;
    for (let i = 1; i < pts.length; i++) {
      const d = distanceM(pts[i - 1], pts[i]);
      const s = (new Date(pts[i].created_at) - new Date(pts[i - 1].created_at)) / 1000;
      if (d >= 15 && s > 0 && d / s * 3.6 < 150) m += d;
    }
    const days = new Set(pts.map((p) => new Date(p.created_at).toDateString())).size;
    // the same place visited several times counts once (time added up)
    const stops = [];
    for (const st of findStops(pts)) {
      const same = stops.find((x) => distanceM(x, st) < 150);
      if (same) same.mins += st.mins; else stops.push(Object.assign({}, st));
    }
    stops.sort((a, b) => b.mins - a.mins);
    const home = state.zones.find((z) => z.kind === 'home');
    let awayMin = 0;
    if (home) for (let i = 1; i < pts.length; i++) {
      if (distanceM(pts[i - 1], home) > home.radius_m) awayMin += Math.min(120, (new Date(pts[i].created_at) - new Date(pts[i - 1].created_at)) / 60000);
    }
    $('#week-km').textContent = fmtDistance(m);
    $('#week-days').textContent = String(days);
    $('#week-stops').textContent = String(stops.length);
    $('#week-away').textContent = home ? fmtDuration(awayMin) : '—';
    const ul = $('#week-top');
    ul.innerHTML = '';
    for (const s of stops.slice(0, 3)) {
      const li = document.createElement('li');
      const name = document.createElement('strong'); name.textContent = '…';
      const dur = document.createElement('span'); dur.textContent = fmtDuration(s.mins);
      li.append(name, dur);
      ul.appendChild(li);
      stopName(s).then((n) => { name.textContent = n; });
    }
    box.hidden = false;
  }

  // =====================================================================
  // NIGHT BATTERY SAVER (per bag, owner): the tracker sends less at night
  // =====================================================================
  async function setNightSaver(tr, on) {
    const before = !!tr.night_saver;
    tr.night_saver = on; renderBags();
    const { error } = await sb.rpc('set_night_saver', { p_tracker: tr.id, p_on: on, p_start: '23:00', p_end: '07:00' });
    if (error) { tr.night_saver = before; renderBags(); toast(errorText(error)); return; }
    toast(on ? t('night_on') : t('night_off'));
  }

  // =====================================================================
  // TWO-STEP LOGIN (authenticator app, e.g. Google Authenticator) — free, no email or SMS needed
  // =====================================================================
  const mfa = { factorId: null, pending: null };
  async function mfaFactors() {
    try { const { data } = await sb.auth.mfa.listFactors(); return (data && data.totp) || []; } catch (e) { return []; }
  }
  async function renderMfa() {
    const sw = $('#mfa-switch');
    if (!sw) return;
    const f = (await mfaFactors()).filter((x) => x.status === 'verified');
    sw.setAttribute('aria-checked', String(!!f.length));
    $('#mfa-state').textContent = f.length ? t('mfa_on') : t('mfa_off');
  }
  async function toggleMfa() {
    const verified = (await mfaFactors()).filter((x) => x.status === 'verified');
    if (verified.length) {
      if (!confirm(t('mfa_off_q'))) return;
      for (const f of verified) await sb.auth.mfa.unenroll({ factorId: f.id });
      toast(t('mfa_off')); renderMfa(); return;
    }
    // remove half-finished set-ups, then start a new one
    for (const f of await mfaFactors()) if (f.status !== 'verified') await sb.auth.mfa.unenroll({ factorId: f.id });
    const { data, error } = await sb.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'Trackly' });
    if (error) { toast(errorText(error)); return; }
    mfa.factorId = data.id;
    $('#mfa-qr').src = data.totp.qr_code;
    $('#mfa-secret').textContent = data.totp.secret;
    $('#mfa-code').value = '';
    $('#mfa-error').textContent = '';
    $('#mfa-title').textContent = t('mfa_setup_title');
    $('#mfa-setup').hidden = false;
    $('#mfa-view').hidden = false;
    setTimeout(() => $('#mfa-code').focus(), 100);
  }
  // after a password login, ask for the 6-digit code if two-step login is on
  async function needsMfaCode() {
    try {
      const { data } = await sb.auth.mfa.getAuthenticatorAssuranceLevel();
      return data && data.nextLevel === 'aal2' && data.currentLevel !== 'aal2';
    } catch (e) { return false; }
  }
  async function askMfaCode() {
    const f = (await mfaFactors()).find((x) => x.status === 'verified');
    if (!f) return false;
    mfa.factorId = f.id;
    $('#mfa-setup').hidden = true;
    $('#mfa-title').textContent = t('mfa_login_title');
    $('#mfa-code').value = '';
    $('#mfa-error').textContent = '';
    $('#mfa-view').hidden = false;
    setTimeout(() => $('#mfa-code').focus(), 100);
    return new Promise((resolve) => { mfa.pending = resolve; });
  }
  async function submitMfa(e) {
    e.preventDefault();
    const code = $('#mfa-code').value.replace(/\D/g, '');
    if (code.length !== 6) { $('#mfa-error').textContent = t('mfa_six'); return; }
    const ch = await sb.auth.mfa.challenge({ factorId: mfa.factorId });
    if (ch.error) { $('#mfa-error').textContent = errorText(ch.error); return; }
    const v = await sb.auth.mfa.verify({ factorId: mfa.factorId, challengeId: ch.data.id, code });
    if (v.error) { $('#mfa-error').textContent = t('mfa_wrong'); return; }
    $('#mfa-view').hidden = true;
    if (mfa.pending) { const r = mfa.pending; mfa.pending = null; r(true); }
    else { toast(t('mfa_on')); renderMfa(); }
  }
  function cancelMfa() {
    $('#mfa-view').hidden = true;
    if (mfa.pending) { const r = mfa.pending; mfa.pending = null; r(false); }
  }

  // =====================================================================
  // DELETE MY ACCOUNT (server function deletes only the signed-in account)
  // =====================================================================
  async function deleteAccount() {
    if (!confirm(t('delete_acc_q'))) return;
    const typed = prompt(t('delete_acc_type'));
    if (!typed || typed.trim().toLowerCase() !== (state.user.email || '').toLowerCase()) { toast(t('delete_acc_cancel')); return; }
    if (CFG.fakeBackend) {
      const { error } = await sb.rpc('delete_my_account', {});
      if (error) { toast(errorText(error)); return; }
    } else {
      const { data } = await sb.auth.getSession();
      try {
        const r = await fetch(CFG.supabaseUrl + '/functions/v1/delete-account', { method: 'POST',
          headers: { Authorization: 'Bearer ' + data.session.access_token, apikey: CFG.supabaseKey, 'Content-Type': 'application/json' }, body: '{}' });
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.status);
      } catch (e) { toast(t('err_generic')); reportError(e); return; }
    }
    ['trackly-cache', 'trackly-saved-trackers', 'trackly-last-email', 'trackly-alerts', 'trackly-tracker', 'trackly-setup-done'].forEach((k) => localStorage.removeItem(k));
    await sb.auth.signOut().catch(() => {});
    toast(t('delete_acc_done'));
    showView('view-auth');
  }

  // owner page link (only for you)
  async function renderAdminLink() {
    if (CFG.fakeBackend || !state.user) { $('#admin-link').hidden = true; return; }
    const { data } = await sb.rpc('is_app_admin');
    $('#admin-link').hidden = data !== true;
  }

  // ---------- events ----------
  function bindEvents() {
    document.addEventListener('click', async (e) => {
      const el = e.target.closest('[data-action]');
      if (!el) return;
      const a = el.dataset.action;
      if (a === 'lang') openLangMenu();
      else if (a === 'pick-lang') { setLang(el.dataset.lang); closeLangMenu(); }
      else if (a === 'close-lang') closeLangMenu();
      else if (a === 'install') installApp();
      else if (a === 'check-update') checkForUpdate();
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
      else if (a === 'toggle-pw') {
        const inp = document.getElementById(el.dataset.target);
        const show = inp.type === 'password';
        inp.type = show ? 'text' : 'password';
        el.setAttribute('aria-pressed', String(show));
        el.setAttribute('aria-label', show ? t('hide_pw') : t('show_pw'));
        inp.focus();
      }
      else if (a === 'scan-qr') openScanner();
      else if (a === 'mfa') toggleMfa();
      else if (a === 'cancel-mfa') cancelMfa();
      else if (a === 'delete-account') deleteAccount();
      else if (a === 'close-scan') closeScanner();
      else if (a === 'forgot') forgotPassword();
      else if (a === 'google') googleLogin();
      else if (a === 'push') togglePush();
      else if (a === 'left-behind') toggleLeftBehind();
      else if (a === 'park') togglePark();
      else if (a === 'join-family') { const c = $('#join-code').value.trim(); if (c) joinFamily(c); }
      else if (a === 'close-search') closeSearch();
      else if (a === 'confirm-lost') { if (navigator.vibrate) navigator.vibrate([80, 60, 80]); closeConfirm(); if (await setMode('lost')) toast(t('toast_lost_on')); }
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
      else if (a === 'toggle-cams') toggleCams();
      else if (a === 'toggle-cam-sound') toggleCamSound();
      else if (a === 'toggle-voice') toggleVoice();
      else if (a === 'scheme') applyScheme(el.dataset.scheme);
      else if (a === 'text-size') applySize(el.dataset.size);
      else if (a === 'open-alerts') openAlerts();
      else if (a === 'close-alerts') closeModal($('#alerts-view'));
      else if (a === 'acc-jump') accJump(el.dataset.target);
      else if (a === 'reload-app') location.reload();
      else if (a === 'close-new') closeModal($('#new-view'));
      else if (a === 'toggle-traffic') toggleTraffic();
      else if (a === 'toggle-night') toggleSmart('trackly-night-guard', nightOn);
      else if (a === 'toggle-unusual') toggleSmart('trackly-unusual', unusualOn);
      else if (a === 'route-mode') setRouteMode(el.dataset.mode);
      else if (a === 'close-route') closeRoute();
      else if (a === 'route-start') startNav(false);
      else if (a === 'route-end') { stopNav(); closeRoute(); }
      else if (a === 'car') carAction();
      else if (a === 'add-reminder') openReminderForm();
      else if (a === 'close-rem') closeModal($('#rem-view'));
      else if (a === 'rem-when') $$('#rem-when .seg').forEach((b) => b.classList.toggle('active', b === el));
      else if (a === 'night-me') nightAnswer(true);
      else if (a === 'night-lost') nightAnswer(false);
      else if (a === 'weather') showWeather();
      else if (a === 'close-wx') closeModal($('#wx-view'));
      else if (a === 'toggle-steps') toggleSteps();
      else if (a === 'steps-resume') resumeSteps();
      else if (a === 'open-pharmacy') findOpenPharmacy();
      else if (a === 'close-trip') closeModal($('#trip-view'));
      else if (a === 'finder-qr') showFinderQr();
      else if (a === 'finder-share') shareFinder();
      else if (a === 'finder-print') printFinder();
      else if (a === 'close-finder') closeModal($('#finder-view'));
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
    $('#mfa-form').addEventListener('submit', submitMfa);
    $('#join-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); const c = e.target.value.trim(); if (c) joinFamily(c); } });
    $('#map-search').addEventListener('input', onMapSearch);
    // Enter opens the first result
    $('#map-search').addEventListener('keydown', (e) => { if (e.key !== 'Enter') return; e.preventDefault(); const first = $('#map-search-results li button'); if (first) first.click(); });
    $('#map-search').addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSearch(); });
    setupSheetDrag();
    setupPullToRefresh();
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
      if (!$('#lang-menu').hidden) closeLangMenu();
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
    applyScheme(schemePref(), true);
    applySize(localStorage.getItem('trackly-size'), true);
    // a tiny tap feel on the main buttons (Android)
    document.addEventListener('click', (e) => { if (navigator.vibrate && e.target.closest('.tab, .fab, .ab, .quick-btn, .seg, .switch, .pchip')) navigator.vibrate(8); }, true);
    takeLinkAction();
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    // a card / invite link opened while Trackly is already open
    window.addEventListener('hashchange', () => {
      takeLinkAction();
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
      if (!state.user) return;
      if (sessionStorage.getItem('trackly-pending-join')) applyPendingJoin();
      else if (applyPendingPair()) { $('[data-action="pair-back"]').hidden = !state.trackers.length; showView('view-pair'); }
    });
    const net = () => { $('#offline-banner').hidden = navigator.onLine; };
    window.addEventListener('online', () => { net(); if (state.tracker) selectTracker(state.tracker.id); });
    let hiddenAt = 0;
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) { hiddenAt = Date.now(); if (act.today) savePhoneSteps(); return; }
      if (state.tracker && !$('#view-app').hidden && Date.now() - hiddenAt > 20000) selectTracker(state.tracker.id);
      else renderMapPanel();
    });
    window.addEventListener('offline', net);
    net();
    window.addEventListener('error', (e) => reportError(e.error || e.message));
    window.addEventListener('unhandledrejection', (e) => reportError(e.reason));
    $$('[data-kind-icon]').forEach((el) => { el.innerHTML = kindIcon(el.dataset.kindIcon); });
    bindEvents();
    document.addEventListener('pointerdown', () => { unlockAudio(); unlockVoice(); }, { passive: true });
    $('#rem-form').addEventListener('submit', submitReminder);
    renderVoice(); renderSmartSwitches();
    const num = (id, key) => $(id).addEventListener('change', (e) => { const v = e.target.value.trim(); if (v) localStorage.setItem(key, String(Math.round(Number(v)))); else localStorage.removeItem(key); syncSettings(); renderStepsSettings(); renderActivity(); });
    num('#act-weight', 'trackly-weight'); num('#act-height', 'trackly-height'); num('#act-goal', 'trackly-goal');
    ['#finder-phone', '#finder-msg'].forEach((id) => $(id).addEventListener('change', saveFinder));
    renderStepsSettings(); renderCamSound(); renderFinder();
    if (stepsOn()) startSteps(false);
    $('#backend-state').textContent = CFG.fakeBackend ? t('backend_test') : t('backend_real');
    $('#backend-switch').setAttribute('aria-checked', String(!CFG.fakeBackend));
    applyLang();
    // remembered email: only the password is left to type (or the phone fills it in)
    const lastEmail = localStorage.getItem('trackly-last-email');
    if (lastEmail) $('#auth-email').value = lastEmail;
    initMap();
    renderTraffic(); drawCar();
    map.m.on('move', syncEditCircle);
    watchForUpdates();
    $('#google-btn').hidden = !CFG.googleLogin;
    renderInstall();
    $('#app-version').textContent = APP_VERSION;
    $('#behind-switch').setAttribute('aria-checked', String(leftBehindOn()));
    countVisit();
    route().then(() => {
      takeShortcut();
      maybeWhatsNew();
      if (state.user) renderAlerts();
      drawFavs();
      // left-behind needs the phone's location: start it quietly if the user already allowed it
      // show you on the map from the start: right away if allowed, otherwise ask once
      if (state.tracker) {
        const askOnce = () => { if (!localStorage.getItem('trackly-asked-gps')) { localStorage.setItem('trackly-asked-gps', '1'); locateMe(false); } };
        if (navigator.permissions) navigator.permissions.query({ name: 'geolocation' }).then((p) => { if (p.state === 'granted') locateMe(false); else if (p.state === 'prompt') askOnce(); }).catch(askOnce);
        else askOnce();
      }
    }).catch((e) => { reportError(e); showView('view-auth'); toast(t('err_generic')); });
  }

  start();
})();
