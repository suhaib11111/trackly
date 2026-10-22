// Trackly directions for the public pages (a shared live location, a shared place):
// every way from where you are to there, shortest first, drawn on the page's map. Nobody has to open another app.
(function () {
  'use strict';
  const T = {
    en: { car: 'Car', foot: 'Walk', finding: 'Finding your location…', loading: 'Finding the best ways…', no_gps: 'Allow location to get directions from where you are.',
      none: 'No way found.', offline: 'No internet. Try again.', best: 'Best way', shortest: 'Shortest', short_fast: 'Shortest & fastest', fastest: 'Fastest', longest: 'Longest', other: 'Another way',
      arrive: 'arrive {t}', min: '{n} min', h: '{h} h {m} min', m: '{n} m', km: '{n} km', here: 'You’re already here.' },
    ckb: { car: 'ئۆتۆمبێل', foot: 'پیادە', finding: 'شوێنەکەت دەدۆزرێتەوە…', loading: 'باشترین ڕێگاکان دەدۆزرێنەوە…', no_gps: 'ڕێگە بە شوێن بدە بۆ ئەوەی ڕێگات پیشان بدەین.',
      none: 'هیچ ڕێگایەک نەدۆزرایەوە.', offline: 'ئینتەرنێت نییە. دووبارە هەوڵ بدەرەوە.', best: 'باشترین ڕێگا', shortest: 'کورتترین', short_fast: 'کورتترین و خێراترین', fastest: 'خێراترین', longest: 'درێژترین', other: 'ڕێگایەکی تر',
      arrive: 'گەیشتن {t}', min: '{n} خولەک', h: '{h} کاتژمێر {m} خولەک', m: '{n} م', km: '{n} کم', here: 'تۆ ئێستا لێرەیت.' },
    ar: { car: 'سيارة', foot: 'مشي', finding: 'جارٍ تحديد موقعك…', loading: 'جارٍ إيجاد أفضل الطرق…', no_gps: 'اسمح بالموقع لعرض الطريق من مكانك.',
      none: 'لم يتم العثور على طريق.', offline: 'لا يوجد إنترنت. حاول مرة أخرى.', best: 'أفضل طريق', shortest: 'الأقصر', short_fast: 'الأقصر والأسرع', fastest: 'الأسرع', longest: 'الأطول', other: 'طريق آخر',
      arrive: 'الوصول {t}', min: '{n} دقيقة', h: '{h} س {m} د', m: '{n} م', km: '{n} كم', here: 'أنت هنا بالفعل.' }
  };
  const ROUTER = 'https://routing.openstreetmap.de/';
  const MODES = { car: 'routed-car/route/v1/driving/', foot: 'routed-foot/route/v1/foot/' };
  const COLORS = ['#2F7BF6', '#8B5CF6', '#F97316', '#64748B'];
  const dist = (a, b) => {
    const R = 6371000, r = (x) => x * Math.PI / 180;
    const h = Math.sin(r(b.lat - a.lat) / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lng - a.lng) / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  };

  // opts: { map (Leaflet), box (element for the route list), lang, to: () => ({ lat, lng }) }
  window.TracklyDirections = function (opts) {
    const m = opts.map, box = opts.box, X = T[opts.lang] || T.en;
    const fill = (s, v) => s.replace(/\{(\w+)\}/g, (_, k) => v[k]);
    const fmtD = (x) => x < 1000 ? fill(X.m, { n: Math.round(x / 10) * 10 }) : fill(X.km, { n: (x / 1000).toFixed(x < 10000 ? 1 : 0) });
    const fmtT = (s) => { const n = Math.max(1, Math.round(s / 60)); return n < 60 ? fill(X.min, { n }) : fill(X.h, { h: Math.floor(n / 60), m: n % 60 }); };
    const clock = (s) => new Date(Date.now() + s * 1000).toLocaleTimeString(opts.lang === 'en' ? 'en-GB' : (opts.lang === 'ar' ? 'ar-IQ-u-nu-latn' : 'ckb-IQ-u-nu-latn'), { hour: '2-digit', minute: '2-digit' });
    let mode = 'car', me = null, layer = null, meDot = null, list = [], sel = 0, seq = 0, started = false;

    box.innerHTML = '<div class="segmented small"><button type="button" class="seg active" data-m="car"></button><button type="button" class="seg" data-m="foot"></button></div><ul class="rp-list"></ul>';
    box.querySelector('[data-m="car"]').textContent = X.car;
    box.querySelector('[data-m="foot"]').textContent = X.foot;
    const ul = box.querySelector('ul');
    box.querySelectorAll('[data-m]').forEach((b) => b.addEventListener('click', () => {
      mode = b.dataset.m;
      box.querySelectorAll('[data-m]').forEach((x) => x.classList.toggle('active', x === b));
      load(true);
    }));
    const note = (txt) => { ul.innerHTML = ''; const li = document.createElement('li'); li.className = 'rp-note'; li.textContent = txt; ul.appendChild(li); };

    function draw(fit) {
      if (layer) m.removeLayer(layer);
      const g = L.layerGroup(), dash = mode === 'foot' ? '1 9' : null;
      list.forEach((r, i) => { if (i !== sel) L.polyline(r.coords, { color: '#9aa3b2', weight: 6, opacity: 0.85, lineCap: 'round', dashArray: dash }).on('click', () => { sel = i; render(); draw(false); }).addTo(g); });
      const r = list[sel];
      if (r) {
        L.polyline(r.coords, { color: '#ffffff', weight: 11, opacity: 0.95, lineCap: 'round', interactive: false }).addTo(g);
        L.polyline(r.coords, { color: COLORS[sel] || COLORS[0], weight: 6.5, lineCap: 'round', lineJoin: 'round', dashArray: dash, interactive: false }).addTo(g);
      }
      layer = g.addTo(m);
      if (fit && list.length) {
        const b = L.latLngBounds([]);
        list.forEach((x) => b.extend(L.latLngBounds(x.coords)));
        m.fitBounds(b, { paddingTopLeft: [24, 80], paddingBottomRight: [24, (opts.bottom ? opts.bottom() : 280) + 16], maxZoom: 17 });
      }
    }
    function render() {
      ul.innerHTML = '';
      list.forEach((r, i) => {
        const li = document.createElement('li');
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'rp-opt' + (i === sel ? ' on' : '');
        b.style.setProperty('--c', COLORS[i] || COLORS[3]);
        b.innerHTML = '<span class="rp-dot"></span><span class="rp-txt"><strong></strong><span></span></span><span class="rp-time"><strong></strong><span></span></span>';
        b.querySelector('.rp-txt strong').textContent = X[r.tag];
        b.querySelector('.rp-txt span').textContent = fmtD(r.m) + (i ? ' · +' + fmtD(r.m - list[0].m) : '');
        b.querySelector('.rp-time strong').textContent = fmtT(r.s);
        b.querySelector('.rp-time span').textContent = fill(X.arrive, { t: clock(r.s) });
        b.addEventListener('click', () => { sel = i; render(); draw(false); });
        li.appendChild(b);
        ul.appendChild(li);
      });
    }
    async function load(fit) {
      if (!me) return;
      const to = opts.to();
      if (!to) return;
      if (dist(me, to) < 25) { note(X.here); if (layer) m.removeLayer(layer); return; }
      const my = ++seq;
      note(X.loading);
      let routes = null;
      try {
        const r = await fetch(ROUTER + MODES[mode] + me.lng.toFixed(6) + ',' + me.lat.toFixed(6) + ';' + to.lng.toFixed(6) + ',' + to.lat.toFixed(6) + '?alternatives=3&overview=full&geometries=geojson');
        const j = await r.json();
        routes = j.code === 'Ok' ? j.routes.map((x) => ({ m: x.distance, s: x.duration, coords: x.geometry.coordinates.map((c) => [c[1], c[0]]) })) : [];
      } catch (e) { routes = null; }
      if (my !== seq) return;
      if (!routes) { note(X.offline); return; }
      if (!routes.length) { note(X.none); return; }
      routes.sort((a, b) => a.m - b.m);                    // the shortest way first
      const fastest = routes.reduce((a, b) => (b.s < a.s ? b : a));
      routes.forEach((r, i) => { r.tag = routes.length === 1 ? 'best' : i === 0 ? (r === fastest ? 'short_fast' : 'shortest') : r === fastest ? 'fastest' : i === routes.length - 1 ? 'longest' : 'other'; });
      list = routes; sel = 0;
      render(); draw(fit !== false);
    }
    function start() {
      box.hidden = false;
      if (started) { load(true); return; }
      started = true;
      if (!navigator.geolocation) { note(X.no_gps); return; }
      note(X.finding);
      setTimeout(() => { if (!me) note(X.no_gps); }, 12000);   // no answer from the GPS: say how to fix it
      navigator.geolocation.watchPosition((p) => {
        const first = !me;
        me = { lat: p.coords.latitude, lng: p.coords.longitude };
        if (!meDot) meDot = L.circleMarker([me.lat, me.lng], { radius: 8, weight: 3, color: '#ffffff', fillColor: '#3B82F6', fillOpacity: 1, interactive: false }).addTo(m);
        else meDot.setLatLng([me.lat, me.lng]);
        if (first) load(true);
      }, () => { if (!me) note(X.no_gps); }, { enableHighAccuracy: true, maximumAge: 10000 });
    }
    return { start, refresh: () => load(false) };
  };
})();
