// ==UserScript==
// @name         カフェるん 出勤まとめ（隣人部。×みくすろいど）＋推し＋ランキング
// @namespace    https://shop.caferun.jp/
// @version      1.3.1
// @description  カフェるんで隣人部。とみくすろいどの出勤を1画面に表示（日別／1週間）、★推しの出勤日とGoogleカレンダー追加、来店日を選ぶと誰に何回会えるか、沖縄のカワいいね！ランキング
// @match        https://shop.caferun.jp/*
// @run-at       document-idle
// @grant        none
// @noframes
// @homepageURL  https://github.com/Dai-Sunakawa/userscripts
// @updateURL    https://raw.githubusercontent.com/Dai-Sunakawa/userscripts/main/caferun-shukkin.user.js
// @downloadURL  https://raw.githubusercontent.com/Dai-Sunakawa/userscripts/main/caferun-shukkin.user.js
// ==/UserScript==

(() => {
  'use strict';

  // ================= 設定 =================
  // 店を増やしたいときはここに { id, name, color } を足すだけ
  // id は https://shop.caferun.jp/shop/〇〇〇〇 の数字
  const SHOPS = [
    { id: 12205, name: '隣人部。', color: '#ff5c8a' },
    { id: 11026, name: 'みくすろいど', color: '#39c5bb' },
  ];
  const DAYS_AHEAD = 7;        // 今日から何日分のタブを出すか
  const LATE_NIGHT_HOUR = 6;   // この時刻(日本時間)より前は「前日」タブも出す
  const CACHE_MIN = 3;         // 同じページを再取得しない時間(分)
  // このハッシュ付きURLで開くと自動表示（null = 前回のモード）
  const OPEN_HASHES = { '#shukkin': null, '#shukkin-week': 'week', '#shukkin-oshi': 'oshi', '#shukkin-rank': 'rank', '#shukkin-visit': 'visit' };
  const WEEK_PARALLEL = 4;     // 1週間/推しモードで同時に読み込むページ数
  // ランキングの対象（カフェるんの「沖縄・那覇」一覧。2ページ目以降は自動でたどる）
  const RANK_AREAS = ['/shop_search/area_7/mid_area_36/'];
  const RANK_CACHE_HOURS = 6;  // ランキングを再集計せず使い回す時間
  const RANK_PARALLEL = 3;     // ランキング集計で同時に読み込む店舗数
  const OTHER_SHOP_COLOR = '#8e7cc3'; // 上の2店以外の推しの色
  const NET_PARALLEL = 2;      // カフェるんへの同時アクセス数（混雑で弾かれないよう控えめ）
  const NET_GAP_MS = 300;      // アクセスの最小間隔(ミリ秒)
  // =========================================

  const ORIGIN = 'https://shop.caferun.jp';
  const WD = ['日', '月', '火', '水', '木', '金', '土'];
  // 出勤見出し: 「11/15(本日)の出勤 4人」「11/16(明日)の出勤 4人」「11/19の出勤 4人」(2日後以降はカッコなし)
  const ATT_RE = /(\d{1,2})\s*[\/月]\s*(\d{1,2})\s*日?\s*(?:[（(]\s*([^)）]{1,4})\s*[)）])?\s*の出勤(?:\s*(\d+)\s*人)?/;
  // 出勤予定リスト: 「11/17(火) 5人」「11/16(月) 未定」
  const SCHED_RE = /^(\d{1,2})\s*[\/月]\s*(\d{1,2})\s*日?\s*[（(]\s*[日月火水木金土]\s*[)）]\s*(?:(\d+)\s*人|(未定))$/;
  const ALL_RE = /^キャスト\s*\d+\s*人$/;
  const TIME_RE = /(\d{1,2}[:：]\d{2})\s*[〜~～\-－–]\s*((?:翌\s*)?\d{1,2}[:：]\d{2}|LAST|Last|last|ラスト)?/;
  const SKIP_TAG = /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/;
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();

  // ---------- 日付(日本時間) ----------
  function jstNow() {
    const f = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', hourCycle: 'h23',
    });
    const p = Object.fromEntries(f.formatToParts(new Date()).map((x) => [x.type, x.value]));
    return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour };
  }

  function buildDays() {
    const { y, m, d, h } = jstNow();
    const start = h < LATE_NIGHT_HOUR ? -1 : 0;
    const days = [];
    for (let i = start; i < DAYS_AHEAD; i++) {
      const dt = new Date(Date.UTC(y, m - 1, d + i));
      days.push({
        offset: i,
        iso: dt.toISOString().slice(0, 10),
        md: `${dt.getUTCMonth() + 1}/${dt.getUTCDate()}`,
        label: `${dt.getUTCMonth() + 1}/${dt.getUTCDate()}(${WD[dt.getUTCDay()]})`,
        rel: i === -1 ? '前日' : i === 0 ? '今日' : i === 1 ? '明日' : '',
        wd: dt.getUTCDay(),
      });
    }
    return days;
  }

  const castlistUrl = (shop, day) =>
    day.offset === 0
      ? `${ORIGIN}/shop/${shop.id}/castlist/`
      : `${ORIGIN}/shop/${shop.id}/castlist/${day.iso}/`;

  // ---------- 取得 & キャッシュ ----------
  const memCache = new Map();
  function cacheGet(key) {
    const now = Date.now();
    const hit = memCache.get(key);
    if (hit && now - hit.t < CACHE_MIN * 60e3) return hit.v;
    try {
      const raw = sessionStorage.getItem('kt3shukkin:' + key);
      if (raw) {
        const o = JSON.parse(raw);
        if (now - o.t < CACHE_MIN * 60e3) return o.v;
      }
    } catch (_) { /* storage不可でも動く */ }
    return null;
  }
  function cacheSet(key, v) {
    const o = { t: Date.now(), v };
    memCache.set(key, o);
    try { sessionStorage.setItem('kt3shukkin:' + key, JSON.stringify(o)); } catch (_) { /* noop */ }
  }

  // カフェるんへのアクセスは全部ここを通す（同時数・間隔を制限、混雑時は待って再試行）
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const netQ = { hi: [], lo: [] };
  let netActive = 0;
  let netLast = 0;
  let netTimer = null;
  function politeFetch(url, low) {
    return new Promise((resolve, reject) => {
      (low ? netQ.lo : netQ.hi).push({ url, resolve, reject });
      netPump();
    });
  }
  function netPump() {
    while (netActive < NET_PARALLEL && (netQ.hi.length || netQ.lo.length)) {
      const wait = netLast + NET_GAP_MS - Date.now();
      if (wait > 0) {
        if (!netTimer) netTimer = setTimeout(() => { netTimer = null; netLast = Date.now() - NET_GAP_MS; netPump(); }, wait);
        return;
      }
      const job = netQ.hi.length ? netQ.hi.shift() : netQ.lo.shift(); // ランキング集計より表示用を優先
      netActive++;
      netLast = Date.now();
      fetchRetry(job.url).then(job.resolve, job.reject).finally(() => { netActive--; netPump(); });
    }
  }
  async function fetchRetry(url) {
    for (let i = 0; ; i++) {
      let res;
      try {
        res = await fetch(url, { credentials: 'include' });
      } catch (e) {
        if (i < 2) { await sleep(1500 * (i + 1)); continue; }
        throw e;
      }
      if ((res.status === 429 || res.status === 403 || res.status >= 500) && i < 2) {
        const ra = parseInt(res.headers.get('Retry-After') || '', 10);
        await sleep((ra > 0 && ra <= 20 ? ra : 2 * (i + 1)) * 1000);
        continue;
      }
      return res;
    }
  }

  function parseHTML(html, url) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    try { // 相対リンクを正しく解決するため
      const b = doc.createElement('base');
      b.setAttribute('href', url);
      (doc.head || doc.documentElement).prepend(b);
    } catch (_) { /* noop */ }
    return doc;
  }

  const todayDay = () => buildDays().find((d) => d.offset === 0);
  const inflight = new Map();

  function loadShopDay(shop, day, force) {
    const key = `${shop.id}:${day.iso}:${day.offset === 0 ? 'today' : 'date'}`;
    if (!force) {
      const c = cacheGet(key);
      if (c) return Promise.resolve(c);
    }
    if (inflight.has(key)) return inflight.get(key);
    const p = (async () => {
      let url = castlistUrl(shop, day);
      if (day.offset !== 0) {
        // 本日ページの「出勤予定」に載っているその日のリンクがあれば、それを使う
        try {
          const t = await loadShopDay(shop, todayDay(), false);
          if (t.links && t.links[day.md]) url = t.links[day.md];
        } catch (_) { /* 組み立てたURLで続行 */ }
      }
      const res = await politeFetch(url);
      const diag = { status: res.status, redirected: !!res.redirected, finalUrl: res.url || url };
      if (!res.ok) {
        const r = { url, found: false, error: res.status !== 404, status: res.status, diag, casts: [] };
        if (res.status === 404) cacheSet(key, r);
        return r;
      }
      const html = await res.text();
      const r = { url, status: res.status, diag, ...parseCastlist(html, shop, res.url || url) };
      if (r.found && day.offset !== 0 && r.siteMd !== day.md) {
        // 別の日(たいてい今日)のページが返ってきた → その日の出勤としては使わない
        r.mismatch = true;
        r.found = false;
        r.casts = [];
      }
      const undecided = r.schedule && r.schedule[day.md] === '未定';
      if (!r.found && !undecided) r.error = true;
      if (!r.error) cacheSet(key, r);
      return r;
    })();
    inflight.set(key, p);
    const done = () => inflight.delete(key);
    p.then(done, done);
    return p;
  }

  // ---------- 解析(クラス名に依存しない作り) ----------
  function findTextEl(doc, needle, test, after) {
    const w = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = w.nextNode())) {
      if (!n.nodeValue.includes(needle)) continue;
      let el = n.parentElement;
      let best = null;
      for (let i = 0; el && i < 4; i++, el = el.parentElement) {
        if (SKIP_TAG.test(el.tagName)) { best = null; break; }
        const t = norm(el.textContent);
        if (t.length > 40) break;
        const r = test(t);
        if (r) { best = { el, r }; if (r.full) break; }
      }
      if (!best) continue;
      if (after && !(after.compareDocumentPosition(best.el) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
      return best;
    }
    return null;
  }

  function castIdOf(a, shopId) {
    const m = (a.href || a.getAttribute('href') || '').match(new RegExp(`/shop/${shopId}/cast/(\\d+)`));
    return m ? m[1] : null;
  }

  // 画像のalt込みでテキストを並べる(「ハート 814」のようにアイコンがimgの場合に対応)
  function richText(el) {
    const out = [];
    const w = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    let n;
    while ((n = w.nextNode())) {
      if (n.nodeType === 3) {
        if (n.parentElement && SKIP_TAG.test(n.parentElement.tagName)) continue;
        out.push(n.nodeValue);
      } else if (n.tagName === 'IMG') {
        out.push(' ' + (n.getAttribute('alt') || '') + ' ');
      }
    }
    return norm(out.join(' '));
  }

  function pickSrc(im, base) {
    const first = (s) => (s || '').trim().split(/\s+/)[0];
    const pic = im.parentElement && im.parentElement.tagName === 'PICTURE' ? im.parentElement : null;
    const cands = [
      im.getAttribute('data-src'), im.getAttribute('data-original'), im.getAttribute('data-lazy-src'),
      first(im.getAttribute('data-srcset')),
      pic && first((pic.querySelector('source[srcset]') || { getAttribute: () => '' }).getAttribute('srcset')),
      first(im.getAttribute('srcset')),
      im.getAttribute('src'),
    ];
    for (const c of cands) {
      if (!c || c.startsWith('data:')) continue;
      try { return new URL(c, base).href; } catch (_) { /* next */ }
    }
    return '';
  }

  function cardOf(a, shopId, stops) {
    let el = a;
    for (let i = 0; i < 6 && el.parentElement; i++) {
      const p = el.parentElement;
      if (p.tagName === 'BODY' || stops.some((s) => s && p.contains(s))) break;
      const ids = new Set();
      p.querySelectorAll('a[href*="cast/"]').forEach((x) => {
        const c = castIdOf(x, shopId);
        if (c) ids.add(c);
      });
      if (ids.size > 1) break;
      el = p;
    }
    return el;
  }

  const JUNK = /^(アクティブハート|ハート|本日出勤|出勤|NEW|new|New|新人|PICK ?UP)$/;

  function extractCard(card, links, base) {
    let name = '';
    let img = '';
    const imgs = [...card.querySelectorAll('img')];
    const photo = imgs.find((im) => /さんの写真/.test(im.getAttribute('alt') || ''));
    if (photo) {
      name = (photo.getAttribute('alt') || '').replace(/さんの写真.*$/, '').trim();
      img = pickSrc(photo, base);
    }
    if (!img) {
      const im = imgs.find((x) => !/ハート|heart|icon/i.test((x.getAttribute('alt') || '') + (x.getAttribute('src') || '')));
      if (im) img = pickSrc(im, base);
    }
    if (!img) {
      const bgEl = [card, ...card.querySelectorAll('[style*="background"]')]
        .find((x) => /url\(/.test(x.getAttribute('style') || ''));
      if (bgEl) {
        const mm = (bgEl.getAttribute('style') || '').match(/url\((['"]?)(.*?)\1\)/);
        if (mm) { try { img = new URL(mm[2], base).href; } catch (_) { /* noop */ } }
      }
    }
    const text = richText(card);
    const tm = text.match(TIME_RE);
    const time = tm ? `${tm[1].replace('：', ':')}〜${(tm[2] || '').replace(/\s+/g, '').replace('：', ':')}` : '';
    const hm = text.match(/ハート\s*([\d,]+)/);
    const heart = hm ? hm[1] : '';
    if (!name) {
      const parts = [];
      const w = card.ownerDocument.createTreeWalker(card, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = w.nextNode())) {
        const t = norm(n.nodeValue);
        if (!t || JUNK.test(t) || /^[\d,]+$/.test(t) || TIME_RE.test(t)) continue;
        parts.push(t);
      }
      name = parts.length ? parts[parts.length - 1] : '';
    }
    const href = links[0].getAttribute('href');
    let url = links[0].href || '';
    if (!url) { try { url = new URL(href, base).href; } catch (_) { url = href; } }
    return { name: name || '(名前不明)', img, time, heart, url };
  }

  // 「出勤予定」リスト → schedule { '11/17': '5人', '11/16': '未定' } と links { '11/17': その日のURL }
  function parseSchedule(doc, base) {
    const out = {};
    const links = {};
    const w = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = w.nextNode())) {
      if (!/人|未定/.test(n.nodeValue)) continue;
      let el = n.parentElement;
      for (let i = 0; el && i < 4; i++, el = el.parentElement) {
        if (SKIP_TAG.test(el.tagName)) break;
        const t = norm(el.textContent);
        if (t.length > 30) break;
        const m = t.match(SCHED_RE);
        if (m) {
          const md = `${+m[1]}/${+m[2]}`;
          out[md] = m[4] ? '未定' : `${m[3]}人`;
          const a = el.closest('a[href]') || el.querySelector('a[href]');
          if (a) { try { links[md] = new URL(a.getAttribute('href'), base).href; } catch (_) { /* noop */ } }
          break;
        }
      }
    }
    return { schedule: out, links };
  }

  function parseCastlist(html, shop, base) {
    const doc = parseHTML(html, base);
    const { schedule, links } = parseSchedule(doc, base);
    const title = norm(doc.title).slice(0, 50);
    const head = findTextEl(doc, 'の出勤', (t) => {
      const m = t.match(ATT_RE);
      return m ? { m, full: m[4] != null } : null;
    });
    if (!head) return { found: false, casts: [], schedule, links, title, noHeading: true };
    const m = head.r.m;
    const count = m[4] != null ? +m[4] : null;
    const end = findTextEl(doc, 'キャスト', (t) => (ALL_RE.test(t) ? { full: true } : null), head.el);

    const groups = new Map();
    for (const a of doc.querySelectorAll('a[href*="cast/"]')) {
      const id = castIdOf(a, shop.id);
      if (!id) continue;
      if (!(head.el.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
      if (end && !(end.el.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_PRECEDING)) continue;
      if (groups.has(id)) { groups.get(id).push(a); continue; }
      if (count != null && groups.size >= count) continue;
      groups.set(id, [a]);
    }

    const casts = [];
    for (const [id, links] of groups) {
      const card = cardOf(links[0], shop.id, [head.el, end && end.el]);
      casts.push({ id, ...extractCard(card, links, base) });
    }
    return {
      found: true,
      siteMd: `${+m[1]}/${+m[2]}`,
      siteRel: m[3] || '',
      count: count != null ? count : casts.length,
      casts,
      schedule,
      links,
      title,
    };
  }

  // ---------- 推し(★) ----------
  const FAV_KEY = 'kt3shukkin:favs';
  function loadFavs() {
    try { return JSON.parse(localStorage.getItem(FAV_KEY) || '{}') || {}; } catch (_) { return {}; }
  }
  let favs = loadFavs();
  const isFav = (k) => Object.prototype.hasOwnProperty.call(favs, k);
  function toggleFav(k, info) {
    if (isFav(k)) delete favs[k]; else favs[k] = info;
    try { localStorage.setItem(FAV_KEY, JSON.stringify(favs)); } catch (_) { /* このページ内だけ有効 */ }
    return isFav(k);
  }
  const shopById = (id, nameHint) =>
    SHOPS.find((s) => s.id === +id) || { id: +id, name: nameHint || `店舗${id}`, color: OTHER_SHOP_COLOR };

  // Googleカレンダーの予定作成URL（時間が分かればその時間、分からなければ終日）
  function gcalUrl(shop, day, hits) {
    const [y, m, d] = day.iso.split('-').map(Number);
    const f = (dt) => dt.toISOString().slice(0, 19).replace(/[-:]/g, '');
    let start = null;
    let end = null;
    for (const c of hits) {
      const t = (c.time || '').match(/^(\d{1,2}):(\d{2})〜(翌)?(?:(\d{1,2}):(\d{2}))?/);
      if (!t) continue;
      const s = new Date(Date.UTC(y, m - 1, d, +t[1], +t[2]));
      let e;
      if (t[4] != null) {
        e = new Date(Date.UTC(y, m - 1, d, +t[4], +t[5]));
        if (t[3] || e <= s) e = new Date(e.getTime() + 864e5);
      } else {
        e = new Date(s.getTime() + 3 * 36e5);
      }
      if (!start || s < start) start = s;
      if (!end || e > end) end = e;
    }
    const next = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10).replace(/-/g, '');
    const dates = start ? `${f(start)}/${f(end)}` : `${day.iso.replace(/-/g, '')}/${next}`;
    const p = new URLSearchParams({
      action: 'TEMPLATE',
      text: `${shop.name} ${hits.map((c) => c.name).join('・')} 出勤`,
      dates,
      ctz: 'Asia/Tokyo',
      location: shop.name,
      details: `${hits.map((c) => `${c.name}${c.time ? `（${c.time}）` : ''}: ${c.url}`).join('\n')}\n出勤表: ${castlistUrl(shop, day)}`,
    });
    return `https://calendar.google.com/calendar/render?${p}`;
  }

  // ---------- ランキング(カワいいね！) ----------
  const RANK_KEY = 'kt3shukkin:rank';
  const GIRLS_RE = /ガールズ|girl'?s|girls/i;
  let rankData = null;
  let rankJob = null;
  let rankProgress = null;
  let rankLimit = 100;
  let rankQuery = '';
  let rankFavOnly = false;
  let rankNoGirls = (() => { try { return localStorage.getItem('kt3shukkin:noGirls') === '1'; } catch (_) { return false; } })();

  function rankCacheGet() {
    try {
      const o = JSON.parse(localStorage.getItem(RANK_KEY) || 'null');
      if (o && Date.now() - o.t < RANK_CACHE_HOURS * 36e5) return o;
    } catch (_) { /* noop */ }
    return null;
  }

  // 店のキャスト一覧ページから、在籍キャスト全員の名前・写真・ハート数を拾う
  function parseAllCasts(doc, shop, base) {
    const groups = new Map();
    for (const a of doc.querySelectorAll('a[href*="cast/"]')) {
      const id = castIdOf(a, shop.id);
      if (!id) continue;
      if (!groups.has(id)) groups.set(id, []);
      groups.get(id).push(a);
    }
    const out = [];
    for (const [id, links] of groups) {
      let best = null;
      for (const a of links) {
        const info = extractCard(cardOf(a, shop.id, []), [a], base);
        if (!best || (info.heart && !best.heart)) best = info;
        if (best.heart) break;
      }
      out.push({
        id, shopId: shop.id, shopName: shop.name, name: best.name,
        heart: best.heart ? +best.heart.replace(/,/g, '') : 0, img: best.img, url: best.url,
      });
    }
    return out;
  }

  async function crawlRank(onProgress) {
    const shops = new Map();
    for (const path of RANK_AREAS) {
      let url = new URL(path, ORIGIN).href;
      const seen = new Set();
      while (url && !seen.has(url) && seen.size < 20) {
        seen.add(url);
        onProgress({ phase: 'list', page: seen.size });
        const res = await politeFetch(url, true);
        if (!res.ok) break;
        const doc = parseHTML(await res.text(), url);
        let next = null;
        for (const a of doc.querySelectorAll('a[href]')) {
          let u;
          try { u = new URL(a.getAttribute('href'), url); } catch (_) { continue; }
          const t = norm(a.textContent);
          if (/^次へ/.test(t)) next = u.href;
          if (u.origin !== ORIGIN) continue;
          const m = u.pathname.match(/^\/shop\/(\d+)\/?$/);
          if (!m) continue;
          const id = +m[1];
          if (!shops.has(id)) shops.set(id, { id, name: '' });
          const s = shops.get(id);
          if (!s.name && t && !/お店の詳細|詳細を見る/.test(t) && t.length <= 60) s.name = t;
        }
        url = next;
      }
    }
    const list = [...shops.values()];
    const all = [];
    let done = 0;
    let okShops = 0;
    await runPool(list.map((s) => async () => {
      try {
        const url = `${ORIGIN}/shop/${s.id}/castlist/`;
        const res = await politeFetch(url, true);
        if (res.ok) {
          const doc = parseHTML(await res.text(), url);
          // <title> 在籍キャスト一覧・出勤 - VOCALOID BAR みくすろいど（沖縄） | カフェるん
          const tm = norm(doc.title).match(/-\s*(.+?)\s*\|\s*カフェるん/);
          let pref = '';
          if (tm) {
            const pm = tm[1].match(/（([^（）]+)）$/);
            if (pm) pref = pm[1];
            s.name = tm[1].replace(/（[^（）]+）$/, '').trim() || s.name;
          }
          if (!pref || /沖縄/.test(pref)) { // 一覧の端にある他県の店は除外
            okShops++;
            all.push(...parseAllCasts(doc, s, url));
          }
        }
      } catch (_) { /* その店は飛ばす */ }
      onProgress({ phase: 'shop', done: ++done, total: list.length });
    }), RANK_PARALLEL);

    // 重複除去（同じ店が旧IDでも載っていることがあるため、名前＋店名でもまとめる）
    const byId = new Map();
    for (const c of all) {
      const k = `${c.shopId}:${c.id}`;
      if (!byId.has(k) || byId.get(k).heart < c.heart) byId.set(k, c);
    }
    const ns = (x) => (x || '').replace(/[\s　。、・.．,，!！]/g, '').toLowerCase();
    const byName = new Map();
    for (const c of byId.values()) {
      const k = `${c.name}|${ns(c.shopName)}`;
      const prev = byName.get(k);
      if (!prev || prev.heart < c.heart || (prev.heart === c.heart && SHOPS.some((x) => x.id === c.shopId))) byName.set(k, c);
    }
    const casts = [...byName.values()].sort((a, b) => b.heart - a.heart || a.name.localeCompare(b.name, 'ja'));
    const o = { t: Date.now(), shops: okShops, casts };
    try { localStorage.setItem(RANK_KEY, JSON.stringify(o)); } catch (_) { /* noop */ }
    return o;
  }

  function getRank(force) {
    if (!force) {
      const c = rankData || rankCacheGet();
      if (c) return Promise.resolve(c);
    }
    if (!rankJob) {
      rankJob = crawlRank((p) => rankProgress && rankProgress(p))
        .finally(() => { rankJob = null; });
    }
    return rankJob;
  }

  async function runPool(tasks, limit) {
    let i = 0;
    const worker = async () => {
      while (i < tasks.length) {
        const t = tasks[i++];
        try { await t(); } catch (_) { /* 各タスク側で表示 */ }
      }
    };
    await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  }

  // ---------- UI ----------
  const STYLE = `
  :host { all: initial; }
  * { box-sizing: border-box; }
  .fab {
    position: fixed; right: 14px; bottom: 88px; z-index: 2147483000;
    width: 58px; height: 58px; border-radius: 50%; border: none; cursor: pointer;
    background: linear-gradient(135deg, ${SHOPS[0].color}, ${SHOPS[1] ? SHOPS[1].color : SHOPS[0].color});
    color: #fff; font: 700 13px/1.15 system-ui, -apple-system, "Hiragino Sans", sans-serif;
    box-shadow: 0 6px 18px rgba(0,0,0,.28); -webkit-tap-highlight-color: transparent;
  }
  .fab:active { transform: scale(.94); }
  .ov {
    position: fixed; inset: 0; z-index: 2147483001; display: none;
    background: rgba(20,16,28,.55); -webkit-backdrop-filter: blur(3px); backdrop-filter: blur(3px);
    font: 14px/1.5 system-ui, -apple-system, "Hiragino Sans", "Hiragino Kaku Gothic ProN", sans-serif;
    color: var(--fg);
    --bg: #ffffff; --fg: #1d1b22; --sub: #6f6a78; --line: #ece9f1; --chip: #f3f1f6; --card: #faf9fc;
    --c: ${SHOPS[0].color}; --gold: #f5a623;
  }
  @media (prefers-color-scheme: dark) {
    .ov { --bg: #1c1a21; --fg: #f2f0f5; --sub: #a29cad; --line: #2e2b35; --chip: #2a2731; --card: #24212a; }
  }
  .ov.open { display: block; }
  .panel {
    position: absolute; inset: max(env(safe-area-inset-top), 10px) 0 0 0;
    margin: 0 auto; max-width: 980px; background: var(--bg);
    border-radius: 18px 18px 0 0; display: flex; flex-direction: column; overflow: hidden;
    box-shadow: 0 -8px 30px rgba(0,0,0,.25);
  }
  header { display: flex; align-items: center; gap: 8px; padding: 12px 14px 8px; }
  header h1 { flex: 1; margin: 0; font-size: 17px; font-weight: 800; letter-spacing: .02em; }
  .btn {
    border: 1px solid var(--line); background: var(--chip); color: var(--fg);
    border-radius: 999px; padding: 7px 12px; font: inherit; font-size: 13px; cursor: pointer;
    -webkit-tap-highlight-color: transparent;
  }
  .btn.ic { width: 36px; height: 36px; padding: 0; font-size: 17px; line-height: 1; flex: 0 0 auto; }
  .segw { padding: 0 14px 10px; }
  .segw.last { border-bottom: 1px solid var(--line); }
  .seg { display: flex; background: var(--chip); border: 1px solid var(--line); border-radius: 999px; padding: 2px; }
  .seg button {
    flex: 1; border: none; background: transparent; color: var(--sub); font: inherit; font-size: 12.5px;
    padding: 6px 2px; border-radius: 999px; cursor: pointer; white-space: nowrap; -webkit-tap-highlight-color: transparent;
  }
  .seg button.on { background: var(--fg); color: var(--bg); font-weight: 700; }
  .tabs {
    display: flex; gap: 6px; overflow-x: auto; padding: 0 14px 10px;
    scrollbar-width: none; -webkit-overflow-scrolling: touch; border-bottom: 1px solid var(--line);
  }
  .tabs[hidden] { display: none; }
  .tabs::-webkit-scrollbar { display: none; }
  .tab {
    flex: 0 0 auto; border: 1px solid var(--line); background: var(--chip); color: var(--fg);
    border-radius: 12px; padding: 6px 10px; font: inherit; font-size: 13px; cursor: pointer;
    text-align: center; line-height: 1.25; -webkit-tap-highlight-color: transparent;
  }
  .tab small { display: block; font-size: 10px; color: var(--sub); }
  .tab.sun { color: #e5484d; } .tab.sat { color: #3e7bfa; }
  .tab.on { background: var(--fg); color: var(--bg); border-color: var(--fg); }
  .tab.on small { color: var(--bg); opacity: .75; }
  .body { flex: 1; overflow-y: auto; -webkit-overflow-scrolling: touch; padding: 12px 14px calc(24px + env(safe-area-inset-bottom)); }
  .sum { margin: 0 0 12px; font-size: 13px; color: var(--sub); }
  .sum b { color: var(--fg); font-size: 16px; }
  .msg { padding: 18px 12px; text-align: center; color: var(--sub); font-size: 13px; }
  .msg a { color: var(--c); }
  .ld { display: inline-block; width: 14px; height: 14px; border: 2px solid var(--line); border-top-color: var(--c);
    border-radius: 50%; animation: sp .8s linear infinite; vertical-align: -2px; margin-right: 6px; }
  @keyframes sp { to { transform: rotate(360deg); } }
  .ini {
    position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
    font-weight: 800; color: #fff; background: var(--c);
  }
  .ini[hidden] { display: none; }
  .star {
    border: none; cursor: pointer; padding: 0; font: inherit; line-height: 1;
    -webkit-tap-highlight-color: transparent;
  }

  /* 日別 */
  .shops { display: grid; gap: 14px; grid-template-columns: 1fr; }
  @media (min-width: 760px) { .shops { grid-template-columns: repeat(${Math.min(SHOPS.length, 2)}, 1fr); } }
  .shop { border: 1px solid var(--line); border-radius: 16px; overflow: hidden; background: var(--bg); }
  .sh { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--line); border-left: 6px solid var(--c); }
  .sh .nm { font-weight: 800; font-size: 15px; }
  .sh .ct { font-weight: 800; color: var(--c); font-size: 15px; }
  .sh .sp { flex: 1; }
  .sh a { color: var(--sub); font-size: 12px; text-decoration: none; }
  .note { padding: 0 12px; margin: 8px 0 0; font-size: 11px; color: var(--sub); }
  .grid { display: grid; gap: 10px; padding: 12px; grid-template-columns: repeat(auto-fill, minmax(98px, 1fr)); }
  .cw { position: relative; }
  .card {
    display: block; text-decoration: none; color: var(--fg); background: var(--card);
    border-radius: 12px; overflow: hidden; border: 1px solid var(--line); -webkit-tap-highlight-color: transparent;
  }
  .card:active { opacity: .7; }
  .ph { position: relative; aspect-ratio: 1 / 1; background: var(--chip); overflow: hidden; }
  .ph img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .ph .ini { font-size: 30px; }
  .ph .hr { position: absolute; right: 4px; bottom: 4px; background: rgba(0,0,0,.55); color: #fff; font-size: 10px; padding: 1px 6px; border-radius: 999px; }
  .cw .star {
    position: absolute; top: 5px; left: 5px; width: 30px; height: 30px; border-radius: 50%;
    background: rgba(0,0,0,.42); color: #fff; font-size: 17px;
  }
  .cw .star.on { color: #ffd23f; background: rgba(0,0,0,.6); }
  .meta { padding: 6px 7px 8px; }
  .meta .n { font-weight: 700; font-size: 13px; line-height: 1.3; word-break: break-all; }
  .meta .t { font-size: 11px; color: var(--sub); margin-top: 2px; white-space: nowrap; letter-spacing: -.02em; overflow: hidden; text-overflow: ellipsis; }

  /* 1週間 */
  .wk { border: 1px solid var(--line); border-radius: 14px; }
  .wr { display: grid; grid-template-columns: 48px repeat(${SHOPS.length}, minmax(0, 1fr)); border-top: 1px solid var(--line); }
  .wr > div { padding: 7px 6px; border-left: 1px solid var(--line); min-width: 0; }
  .wr > div:first-child { border-left: none; }
  .wr.hd { position: sticky; top: -12px; z-index: 1; background: var(--bg); border-top: none; border-radius: 14px 14px 0 0; }
  .wr.hd > div { font-weight: 800; font-size: 13px; padding: 9px 6px 7px; box-shadow: inset 0 -3px 0 var(--c, transparent); }
  .wr.today { background: var(--card); }
  .wd { text-align: center; font-size: 13px; font-weight: 700; line-height: 1.2; align-self: center; }
  .wd small { display: block; font-size: 10px; color: var(--sub); font-weight: 400; margin-top: 2px; }
  .wd.sun, .odh.sun { color: #e5484d; } .wd.sat, .odh.sat { color: #3e7bfa; }
  .chips { display: flex; flex-wrap: wrap; gap: 4px; }
  .chip {
    border: 1px solid var(--line); background: var(--chip); color: var(--fg); font: inherit;
    font-size: 12px; line-height: 1.3; padding: 2px 7px; border-radius: 999px; cursor: pointer;
    max-width: 100%; overflow-wrap: anywhere; text-align: left; -webkit-tap-highlight-color: transparent;
  }
  .chip.fav::before { content: "★"; color: var(--gold); margin-right: 2px; }
  .chip.hl { background: var(--c); border-color: var(--c); color: #fff; font-weight: 700; }
  .chip.hl.fav::before { color: #fff; }
  .no { font-size: 12px; color: var(--sub); text-decoration: none; }
  .no.err { color: #e5484d; }
  .diag { font-size: 10px; color: var(--sub); opacity: .85; margin-top: 8px; word-break: break-all; }
  .msg small { font-size: 12px; }

  /* ★推し */
  .od { border: 1px solid var(--line); border-radius: 14px; margin-bottom: 10px; overflow: hidden; }
  .od.none { opacity: .7; }
  .odh { display: flex; align-items: baseline; gap: 6px; padding: 8px 12px; background: var(--card); font-size: 14px; }
  .odh small { font-size: 11px; color: var(--sub); }
  .orow { display: flex; align-items: center; gap: 10px; padding: 9px 12px; border-top: 1px solid var(--line); border-left: 5px solid var(--c); }
  .oi { flex: 1; min-width: 0; }
  .os { font-size: 11px; color: var(--sub); }
  .on { font-size: 15px; font-weight: 700; line-height: 1.4; }
  .on a { color: var(--fg); text-decoration: none; }
  .on small { font-size: 11px; color: var(--sub); font-weight: 400; margin-left: 3px; }
  .on .dot { color: var(--sub); font-weight: 400; margin: 0 3px; }
  .cal {
    flex: 0 0 auto; text-decoration: none; font-size: 12px; font-weight: 700; color: #fff; background: var(--c);
    padding: 7px 10px; border-radius: 999px; white-space: nowrap;
  }
  .onone { padding: 8px 12px; font-size: 12px; color: var(--sub); border-top: 1px solid var(--line); }
  .sec { font-size: 13px; margin: 18px 0 8px; color: var(--sub); font-weight: 700; }
  .fvs { display: flex; flex-wrap: wrap; gap: 6px; }
  .fv { display: inline-flex; align-items: center; gap: 4px; background: var(--chip); border: 1px solid var(--line); border-radius: 999px; padding: 3px 4px 3px 10px; font-size: 13px; }
  .fv small { color: var(--sub); font-size: 11px; }
  .fv .rm { width: 22px; height: 22px; border-radius: 50%; background: transparent; color: var(--sub); font-size: 14px; }

  /* ランキング */
  .rk-top { position: sticky; top: -12px; z-index: 1; background: var(--bg); padding: 0 0 8px; margin-bottom: 4px; }
  .q {
    width: 100%; border: 1px solid var(--line); background: var(--chip); color: var(--fg); border-radius: 12px;
    padding: 9px 12px; font: inherit; font-size: 16px; outline: none; -webkit-appearance: none; appearance: none;
  }
  .flt { display: flex; gap: 6px; margin: 8px 0 6px; flex-wrap: wrap; }
  .fchip { border: 1px solid var(--line); background: var(--bg); color: var(--sub); border-radius: 999px; padding: 5px 11px; font: inherit; font-size: 12px; cursor: pointer; }
  .fchip.on { background: var(--fg); color: var(--bg); border-color: var(--fg); font-weight: 700; }
  .rk-top .sum { margin: 0; font-size: 11px; }
  .rr { display: flex; align-items: center; gap: 8px; padding: 7px 4px 7px 6px; border-bottom: 1px solid var(--line); }
  .rr.mine { border-left: 4px solid var(--c); padding-left: 4px; }
  .rn { width: 30px; text-align: center; font-weight: 800; font-size: 14px; color: var(--sub); flex: 0 0 auto; }
  .rr.r1 .rn { color: #d4a017; font-size: 17px; } .rr.r2 .rn { color: #9aa3ad; font-size: 16px; } .rr.r3 .rn { color: #c27c46; font-size: 16px; }
  .rlink { flex: 1; min-width: 0; display: flex; align-items: center; gap: 10px; text-decoration: none; color: var(--fg); }
  .ra { position: relative; width: 44px; height: 44px; border-radius: 50%; overflow: hidden; background: var(--chip); flex: 0 0 auto; }
  .ra img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .ra .ini { font-size: 18px; }
  .rt { flex: 1; min-width: 0; line-height: 1.3; }
  .rt b { display: block; font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .rt small { display: block; font-size: 11px; color: var(--sub); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .rh { font-weight: 800; font-size: 14px; color: #e5487a; white-space: nowrap; }
  .rr .star { width: 34px; height: 34px; background: transparent; color: var(--sub); font-size: 20px; flex: 0 0 auto; }
  .rr .star.on { color: var(--gold); }
  .more { display: block; width: 100%; margin: 12px 0; }

  /* 来店 */
  .vdays { display: grid; grid-template-columns: repeat(7, 1fr); gap: 5px; }
  .vday {
    border: 1px solid var(--line); background: var(--chip); color: var(--fg); border-radius: 12px;
    padding: 7px 0 6px; font: inherit; font-size: 13px; font-weight: 700; line-height: 1.2; cursor: pointer;
    -webkit-tap-highlight-color: transparent;
  }
  .vday small { display: block; font-size: 10px; font-weight: 400; color: var(--sub); }
  .vday.sun { color: #e5484d; } .vday.sat { color: #3e7bfa; }
  .vday.on { background: var(--fg); border-color: var(--fg); color: var(--bg); }
  .vday.on small { color: var(--bg); opacity: .75; }
  .vshop.on { background: var(--c); border-color: var(--c); color: #fff; }
  .vsum { margin: 14px 0 10px; font-size: 13px; color: var(--sub); }
  .vsum b { font-size: 20px; color: var(--fg); }
  .vm { border: 1px solid var(--line); border-radius: 14px; overflow: hidden; }
  .vr { display: grid; grid-template-columns: minmax(0, 1fr) repeat(var(--cols), 32px) 46px; align-items: center; border-top: 1px solid var(--line); }
  .vr:first-child { border-top: none; }
  .vr.vh { background: var(--card); font-size: 11px; font-weight: 700; }
  .vr.vh .vn { border-left-color: transparent; }
  .vr > div { padding: 7px 0; text-align: center; min-width: 0; }
  .vr .vn { text-align: left; padding: 6px 8px; border-left: 4px solid var(--c, transparent); }
  .vn a { color: var(--fg); text-decoration: none; font-weight: 700; font-size: 14px; display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .vn small { display: block; font-size: 10px; color: var(--sub); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .vn .fv-mark { color: var(--gold); }
  .vc { font-size: 13px; line-height: 1.15; }
  .vc small { display: block; font-size: 9px; color: var(--sub); font-weight: 400; }
  .vc.sun { color: #e5484d; } .vc.sat { color: #3e7bfa; }
  .vc .dm { color: var(--c); font-size: 15px; }
  .vt { font-size: 11px; color: var(--sub); }
  .vt b { font-size: 16px; color: var(--fg); }
  .vnote { font-size: 12px; color: var(--sub); margin: 10px 2px 0; line-height: 1.6; }
  .vnote.err { color: #e5484d; }
  `;

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const starBtn = (k, name, shop, extra = '') => {
    const on = isFav(k);
    return `<button type="button" class="star ${on ? 'on' : ''} ${extra}" data-fk="${esc(k)}" data-name="${esc(name)}"
      data-sid="${esc(shop.id)}" data-sname="${esc(shop.name)}" aria-label="推しに登録">${on ? '★' : '☆'}</button>`;
  };
  const fmtTime = (t) => new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(new Date(t));

  let root, ov, tabsEl, segwEl, bodyEl, days, current, token = 0;
  const hl = new Set(); // 1週間モードで一時的に光らせているキャスト
  const MODES = ['day', 'week', 'oshi', 'visit', 'rank'];
  let mode = (() => {
    try { const m = localStorage.getItem('kt3shukkin:mode'); return MODES.includes(m) ? m : 'day'; } catch (_) { return 'day'; }
  })();

  function mount() {
    if (document.getElementById('kt3-shukkin-host')) return;
    const host = document.createElement('div');
    host.id = 'kt3-shukkin-host';
    document.documentElement.appendChild(host);
    root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>${STYLE}</style>
      <button class="fab" type="button" aria-label="出勤まとめを開く">出勤<br>まとめ</button>
      <div class="ov" role="dialog" aria-modal="true" aria-label="出勤まとめ">
        <div class="panel">
          <header>
            <h1>出勤まとめ</h1>
            <button class="btn ic rf" type="button" aria-label="更新">↻</button>
            <button class="btn ic x" type="button" aria-label="閉じる">×</button>
          </header>
          <div class="segw"><div class="seg">
            <button type="button" data-m="day">日別</button><button type="button" data-m="week">1週間</button><button type="button" data-m="oshi">★推し</button><button type="button" data-m="visit">来店</button><button type="button" data-m="rank">ランキング</button>
          </div></div>
          <div class="tabs"></div>
          <div class="body"></div>
        </div>
      </div>`;
    ov = root.querySelector('.ov');
    tabsEl = root.querySelector('.tabs');
    segwEl = root.querySelector('.segw');
    bodyEl = root.querySelector('.body');
    root.querySelector('.fab').addEventListener('click', () => open());
    root.querySelector('.x').addEventListener('click', close);
    root.querySelector('.rf').addEventListener('click', () => refresh(true));
    root.querySelectorAll('.seg button').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.m)));
    bodyEl.addEventListener('click', onBodyClick);
    bodyEl.addEventListener('error', (e) => { // 写真が読めないときは頭文字に
      const im = e.target;
      if (!im || im.tagName !== 'IMG') return;
      const box = im.parentElement;
      im.remove();
      const ini = box && box.querySelector('.ini');
      if (ini) ini.hidden = false;
    }, true);
    ov.addEventListener('click', (e) => { if (e.target === ov) close(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && ov.classList.contains('open')) close(); });
    const byHash = () => {
      if (Object.prototype.hasOwnProperty.call(OPEN_HASHES, location.hash)) open(OPEN_HASHES[location.hash]);
    };
    window.addEventListener('hashchange', byHash);
    byHash();
  }

  function onBodyClick(e) {
    const t = e.target;
    const star = t.closest && t.closest('.star');
    if (star) {
      e.preventDefault();
      e.stopPropagation();
      const k = star.dataset.fk;
      const on = toggleFav(k, { name: star.dataset.name, shopId: +star.dataset.sid, shopName: star.dataset.sname });
      bodyEl.querySelectorAll('.star').forEach((b) => {
        if (b.dataset.fk !== k) return;
        b.classList.toggle('on', on);
        if (!b.classList.contains('rm')) b.textContent = on ? '★' : '☆';
      });
      bodyEl.querySelectorAll('.chip').forEach((c) => c.classList.toggle('fav', isFav(c.dataset.ck)));
      if (mode === 'oshi') renderOshi(false);
      if (mode === 'rank' && rankFavOnly) drawRankList();
      return;
    }
    const chip = t.closest && t.closest('.chip');
    if (chip) {
      const k = chip.dataset.ck;
      if (hl.has(k)) hl.delete(k); else hl.add(k);
      bodyEl.querySelectorAll('.chip').forEach((c) => c.classList.toggle('hl', hl.has(c.dataset.ck)));
      return;
    }
    const vday = t.closest && t.closest('.vday');
    if (vday) {
      const iso = vday.dataset.iso;
      if (visitSel.has(iso)) visitSel.delete(iso); else visitSel.add(iso);
      saveVisit();
      renderVisit(false);
      return;
    }
    const vact = t.closest && t.closest('.vact');
    if (vact) {
      const wdays = days.filter((d) => d.offset >= 0);
      if (vact.dataset.v === 'all') visitSel = new Set(wdays.map((d) => d.iso));
      else if (vact.dataset.v === 'wkend') visitSel = new Set(wdays.filter((d) => [5, 6, 0].includes(d.wd)).map((d) => d.iso));
      else visitSel = new Set();
      saveVisit();
      renderVisit(false);
      return;
    }
    const vshop = t.closest && t.closest('.vshop');
    if (vshop) {
      const id = +vshop.dataset.sid;
      if (visitShops.has(id)) visitShops.delete(id); else visitShops.add(id);
      saveVisit();
      renderVisit(false);
      return;
    }
    const fchip = t.closest && t.closest('.fchip');
    if (fchip) {
      if (fchip.dataset.f === 'ng') {
        rankNoGirls = !rankNoGirls;
        try { localStorage.setItem('kt3shukkin:noGirls', rankNoGirls ? '1' : '0'); } catch (_) { /* noop */ }
      } else {
        rankFavOnly = !rankFavOnly;
      }
      fchip.classList.toggle('on');
      rankLimit = 100;
      drawRankList();
      return;
    }
    if (t.closest && t.closest('.more')) {
      rankLimit += 100;
      drawRankList();
    }
  }

  let prevOverflow = '';
  function open(forceMode) {
    if (forceMode) mode = forceMode;
    favs = loadFavs();
    days = buildDays();
    current = days.find((d) => d.offset === 0);
    drawMode();
    drawTabs();
    refresh(false);
    if (!ov.classList.contains('open')) {
      prevOverflow = document.documentElement.style.overflow;
      document.documentElement.style.overflow = 'hidden';
      ov.classList.add('open');
    }
  }
  function close() {
    ov.classList.remove('open');
    document.documentElement.style.overflow = prevOverflow;
    if (Object.prototype.hasOwnProperty.call(OPEN_HASHES, location.hash)) {
      history.replaceState(null, '', location.pathname + location.search);
    }
  }

  function setMode(m) {
    if (m === mode) return;
    mode = m;
    try { localStorage.setItem('kt3shukkin:mode', m); } catch (_) { /* noop */ }
    drawMode();
    refresh(false);
  }
  function drawMode() {
    root.querySelectorAll('.seg button').forEach((b) => b.classList.toggle('on', b.dataset.m === mode));
    tabsEl.hidden = mode !== 'day';
    segwEl.classList.toggle('last', mode !== 'day');
  }
  function refresh(force) {
    bodyEl.scrollTop = 0;
    if (mode === 'week') renderWeek(force);
    else if (mode === 'oshi') renderOshi(force);
    else if (mode === 'rank') renderRank(force);
    else if (mode === 'visit') renderVisit(force);
    else render(current, force);
  }

  function drawTabs() {
    tabsEl.innerHTML = days.map((d, i) => `
      <button class="tab ${d.wd === 0 ? 'sun' : d.wd === 6 ? 'sat' : ''} ${d === current ? 'on' : ''}" data-i="${i}" type="button">
        ${esc(d.label)}<small>${esc(d.rel || ' ')}</small>
      </button>`).join('');
    tabsEl.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => {
      current = days[+b.dataset.i];
      drawTabs();
      refresh(false);
    }));
    const on = tabsEl.querySelector('.tab.on');
    if (on && on.scrollIntoView) on.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  // ---------- 日別モード ----------
  function render(day, force) {
    const my = ++token;
    bodyEl.innerHTML = `
      <p class="sum">${esc(day.label)}${day.rel ? `（${esc(day.rel)}）` : ''}　合計 <b class="total">…</b> 人　<small>☆で推し登録</small></p>
      <div class="shops">${SHOPS.map((s, i) => `
        <section class="shop" style="--c:${esc(s.color)}" data-i="${i}">
          <div class="sh"><span class="nm">${esc(s.name)}</span><span class="ct"></span><span class="sp"></span>
            <a href="${esc(castlistUrl(s, day))}">お店ページ ›</a></div>
          <div class="cn"><div class="msg"><span class="ld"></span>読み込み中…</div></div>
        </section>`).join('')}
      </div>`;
    let total = 0;
    let done = 0;
    let anyCount = false;
    SHOPS.forEach((shop, i) => {
      const sec = bodyEl.querySelector(`.shop[data-i="${i}"]`);
      loadShopDay(shop, day, force)
        .then((r) => {
          if (my !== token) return;
          drawShop(sec, shop, day, r);
          if (r.found) { total += r.casts.length; anyCount = true; }
        })
        .catch((err) => {
          if (my !== token) return;
          sec.querySelector('.cn').innerHTML = `<div class="msg">取得できませんでした（${esc(err && err.message || err)}）<br>
            <a href="${esc(castlistUrl(shop, day))}">お店のページで見る</a></div>`;
        })
        .finally(() => {
          if (my !== token) return;
          if (++done === SHOPS.length) bodyEl.querySelector('.total').textContent = anyCount ? total : '-';
        });
    });
  }

  function failInfo(r) {
    let why = 'ページの中に出勤欄が見つかりませんでした';
    if (r.mismatch) why = `${r.siteMd} のページが返ってきました（日付の指定が効いていません）`;
    else if (r.status === 429 || r.status === 403 || r.status >= 500) why = `カフェるんに弾かれました（HTTP ${r.status}）。少し待ってから ↻ を押してください`;
    else if (r.status && r.status !== 200) why = `HTTP ${r.status}`;
    const d = r.diag || {};
    const diag = [
      `HTTP ${d.status != null ? d.status : (r.status != null ? r.status : '-')}`,
      d.redirected ? '転送あり' : '',
      r.title ? `「${r.title}」` : '',
      (d.finalUrl || r.url || '').replace(ORIGIN, ''),
    ].filter(Boolean).join('・');
    return { why, diag };
  }

  function drawShop(sec, shop, day, r) {
    const cn = sec.querySelector('.cn');
    const ct = sec.querySelector('.ct');
    const undecided = r.schedule && r.schedule[day.md] === '未定';
    if (!r.found) {
      ct.textContent = '';
      if (r.error && day.offset >= 0) {
        const f = failInfo(r);
        cn.innerHTML = `<div class="msg">この日の出勤を取得できませんでした<br><small>${esc(f.why)}</small><br>
          <a href="${esc(r.url)}">お店のページで確認</a><div class="diag">診断: ${esc(f.diag)}</div></div>`;
        return;
      }
      let why = undecided ? 'この日の出勤はまだ未定です' : 'この日の出勤情報はまだ出ていません（未定）';
      if (day.offset < 0) why = '前日分はカフェるんで公開されていないようです';
      cn.innerHTML = `<div class="msg">${esc(why)}<br><a href="${esc(r.url)}">お店のページで確認</a></div>`;
      return;
    }
    ct.textContent = `${r.casts.length}人`;
    const note = r.siteMd && r.siteMd !== day.md
      ? `<p class="note">※カフェるん側は ${esc(r.siteMd)}${r.siteRel ? `(${esc(r.siteRel)})` : ''} の出勤として表示しています</p>` : '';
    if (!r.casts.length) {
      cn.innerHTML = `${note}<div class="msg">${undecided ? 'この日の出勤はまだ未定です' : '出勤キャストなし'}</div>`;
      return;
    }
    cn.innerHTML = `${note}<div class="grid">${r.casts.map((c) => `
      <div class="cw">
        <a class="card" href="${esc(c.url)}">
          <div class="ph">
            ${c.img ? `<img src="${esc(c.img)}" alt="" loading="lazy">` : ''}
            <div class="ini" ${c.img ? 'hidden' : ''}>${esc((c.name || '?').slice(0, 1))}</div>
            ${c.heart ? `<span class="hr">♡${esc(c.heart)}</span>` : ''}
          </div>
          <div class="meta"><div class="n">${esc(c.name)}</div>${c.time ? `<div class="t">${esc(c.time)}</div>` : ''}</div>
        </a>
        ${starBtn(`${shop.id}:${c.id}`, c.name, shop)}
      </div>`).join('')}</div>`;
  }

  // ---------- 1週間モード(名前のみ) ----------
  function renderWeek(force) {
    const my = ++token;
    const wdays = days.filter((d) => d.offset >= 0);
    bodyEl.innerHTML = `
      <p class="sum">${esc(wdays[0].label)}〜${esc(wdays[wdays.length - 1].label)}<br>名前タップでその人の出勤日を強調（★＝推し）</p>
      <div class="wk">
        <div class="wr hd"><div></div>${SHOPS.map((s) => `<div style="--c:${esc(s.color)}">${esc(s.name)}</div>`).join('')}</div>
        ${wdays.map((d, di) => `
          <div class="wr ${d.offset === 0 ? 'today' : ''}">
            <div class="wd ${d.wd === 0 ? 'sun' : d.wd === 6 ? 'sat' : ''}">${esc(d.md)}<small>${WD[d.wd]}</small>${d.rel ? `<small>${esc(d.rel)}</small>` : ''}</div>
            ${SHOPS.map((s, si) => `<div class="wc" style="--c:${esc(s.color)}" data-k="${di}-${si}"><span class="ld"></span></div>`).join('')}
          </div>`).join('')}
      </div>`;
    const tasks = [];
    wdays.forEach((d, di) => SHOPS.forEach((s, si) => tasks.push(async () => {
      if (my !== token) return;
      let r;
      try { r = await loadShopDay(s, d, force); } catch (e) { r = { error: e }; }
      if (my !== token) return;
      drawWeekCell(bodyEl.querySelector(`.wc[data-k="${di}-${si}"]`), s, d, r);
    })));
    runPool(tasks, WEEK_PARALLEL);
  }

  function drawWeekCell(cell, shop, day, r) {
    if (!cell) return;
    if (!r || r.error) {
      const f = r ? failInfo(r) : { why: '', diag: '' };
      cell.innerHTML = `<a class="no err" href="${esc((r && r.url) || castlistUrl(shop, day))}" title="${esc(f.why)}">取得失敗</a>`;
      return;
    }
    const undecided = r.schedule && r.schedule[day.md] === '未定';
    if (!r.found || !r.casts.length) {
      cell.innerHTML = `<span class="no">${!r.found || undecided ? '未定' : 'なし'}</span>`;
      return;
    }
    cell.innerHTML = `<div class="chips">${r.casts.map((c) => {
      const k = `${shop.id}:${c.id}`;
      return `<button type="button" class="chip ${hl.has(k) ? 'hl' : ''} ${isFav(k) ? 'fav' : ''}" data-ck="${esc(k)}">${esc(c.name)}</button>`;
    }).join('')}</div>`;
  }

  // ---------- ★推しモード ----------
  function renderOshi(force) {
    const my = ++token;
    const entries = Object.entries(favs);
    if (!entries.length) {
      bodyEl.innerHTML = `<div class="msg">まだ推しが登録されていません。<br><br>「日別」の写真の左上や「ランキング」の ☆ をタップすると、ここに推しの出勤日がまとまります。</div>`;
      return;
    }
    const shopIds = [...new Set(entries.map(([, f]) => +f.shopId))];
    const shops = shopIds.map((id) => shopById(id, (entries.find(([, f]) => +f.shopId === id) || [, {}])[1].shopName));
    const wdays = days.filter((d) => d.offset >= 0);
    const tasks = [];
    const results = {};
    let done = 0;
    wdays.forEach((d) => shops.forEach((s) => tasks.push(async () => {
      if (my !== token) return;
      try { results[`${s.id}|${d.iso}`] = await loadShopDay(s, d, force); } catch (_) { results[`${s.id}|${d.iso}`] = { error: true }; }
      done++;
      const pg = my === token && bodyEl.querySelector('.pg');
      if (pg) pg.textContent = `${done}/${tasks.length}`;
    })));
    bodyEl.innerHTML = `<div class="msg"><span class="ld"></span>推しの出勤を確認中… <span class="pg">0/${tasks.length}</span></div>`;
    runPool(tasks, WEEK_PARALLEL).then(() => { if (my === token) drawOshi(wdays, shops, results, entries); });
  }

  function drawOshi(wdays, shops, results, entries) {
    const html = wdays.map((d) => {
      const rows = [];
      const pending = [];
      const errs = [];
      for (const s of shops) {
        const r = results[`${s.id}|${d.iso}`];
        if (!r || r.error) { errs.push(s.name); continue; }
        const hits = (r.casts || []).filter((c) => isFav(`${s.id}:${c.id}`));
        if (hits.length) rows.push({ s, hits });
        else if (!r.found || (r.schedule && r.schedule[d.md] === '未定')) pending.push(s.name);
      }
      const head = `<div class="odh ${d.wd === 0 ? 'sun' : d.wd === 6 ? 'sat' : ''}"><b>${esc(d.label)}</b>${d.rel ? `<small>${esc(d.rel)}</small>` : ''}</div>`;
      const errLine = errs.length ? `<div class="onone" style="color:#e5484d">${esc(errs.join('・'))}は取得失敗（↻で再試行）</div>` : '';
      if (!rows.length) {
        return `<div class="od ${errs.length ? '' : 'none'}">${head}<div class="onone">推しの出勤なし${pending.length ? `（${esc(pending.join('・'))}は未定）` : ''}</div>${errLine}</div>`;
      }
      return `<div class="od">${head}${rows.map(({ s, hits }) => `
        <div class="orow" style="--c:${esc(s.color)}">
          <div class="oi"><div class="os">${esc(s.name)}</div>
            <div class="on">${hits.map((c) => `<a href="${esc(c.url)}">${esc(c.name)}</a>${c.time ? `<small>${esc(c.time)}</small>` : ''}`).join('<span class="dot">・</span>')}</div>
          </div>
          <a class="cal" href="${esc(gcalUrl(s, d, hits))}" target="_blank" rel="noopener">📅 カレンダー</a>
        </div>`).join('')}${pending.length ? `<div class="onone">${esc(pending.join('・'))}は未定</div>` : ''}${errLine}</div>`;
    }).join('');
    const list = entries.map(([k, f]) => `
      <span class="fv">★ ${esc(f.name)} <small>${esc(f.shopName || '')}</small>
        ${starBtn(k, f.name, shopById(f.shopId, f.shopName), 'rm').replace(/>[★☆]<\/button>$/, '>×</button>')}</span>`).join('');
    bodyEl.innerHTML = `
      <p class="sum">推しの出勤（${esc(wdays[0].label)}〜${esc(wdays[wdays.length - 1].label)}）</p>
      ${html}
      <h3 class="sec">登録中の推し（×で解除）</h3><div class="fvs">${list}</div>`;
  }

  // ---------- 来店モード（行く日を選ぶと、誰に何回会えるか） ----------
  let visitSel = new Set();
  let visitShops = new Set(SHOPS.map((s) => s.id));
  try {
    const v = JSON.parse(localStorage.getItem('kt3shukkin:visit') || 'null');
    if (v) {
      visitSel = new Set(v.days || []);
      if (Array.isArray(v.shops)) visitShops = new Set(v.shops.filter((id) => SHOPS.some((s) => s.id === id)));
    }
  } catch (_) { /* noop */ }
  function saveVisit() {
    try { localStorage.setItem('kt3shukkin:visit', JSON.stringify({ days: [...visitSel], shops: [...visitShops] })); } catch (_) { /* noop */ }
  }

  function renderVisit(force) {
    const my = ++token;
    const wdays = days.filter((d) => d.offset >= 0);
    // 過ぎた日・公開範囲外の日は選択から外す
    visitSel = new Set([...visitSel].filter((iso) => wdays.some((d) => d.iso === iso)));
    const cls = (d) => (d.wd === 0 ? 'sun' : d.wd === 6 ? 'sat' : '');
    bodyEl.innerHTML = `
      <p class="sum" style="margin-bottom:8px">来店する日をタップ（複数OK）</p>
      <div class="vdays">${wdays.map((d) => `
        <button type="button" class="vday ${cls(d)} ${visitSel.has(d.iso) ? 'on' : ''}" data-iso="${d.iso}">${esc(d.md)}<small>${WD[d.wd]}${d.offset === 0 ? '・今日' : ''}</small></button>`).join('')}
      </div>
      <div class="flt">
        <button type="button" class="fchip vact" data-v="all">7日全部</button>
        <button type="button" class="fchip vact" data-v="wkend">金土日</button>
        <button type="button" class="fchip vact" data-v="clear">クリア</button>
      </div>
      <div class="flt" style="margin-top:0">
        ${SHOPS.map((s) => `<button type="button" class="fchip vshop ${visitShops.has(s.id) ? 'on' : ''}" data-sid="${s.id}" style="--c:${esc(s.color)}">${esc(s.name)}</button>`).join('')}
      </div>
      <div class="vres"></div>`;
    const res = bodyEl.querySelector('.vres');
    const sel = wdays.filter((d) => visitSel.has(d.iso));
    const shops = SHOPS.filter((s) => visitShops.has(s.id));
    if (!sel.length) {
      res.innerHTML = `<div class="msg">日付を選ぶと、誰に何回会えるかが出ます。<br><small>カフェるんに出勤が出ている${wdays.length}日分から選べます</small></div>`;
      return;
    }
    if (!shops.length) {
      res.innerHTML = `<div class="msg">お店を1つ以上選んでください</div>`;
      return;
    }
    res.innerHTML = `<div class="msg"><span class="ld"></span>出勤を確認中… <span class="pg">0/${sel.length * shops.length}</span></div>`;
    const results = {};
    let done = 0;
    const tasks = [];
    sel.forEach((d) => shops.forEach((s) => tasks.push(async () => {
      if (my !== token) return;
      try { results[`${s.id}|${d.iso}`] = await loadShopDay(s, d, force); } catch (_) { results[`${s.id}|${d.iso}`] = { error: true }; }
      done++;
      const pg = my === token && res.querySelector('.pg');
      if (pg) pg.textContent = `${done}/${tasks.length}`;
    })));
    runPool(tasks, WEEK_PARALLEL).then(() => { if (my === token) drawVisit(res, sel, shops, results); });
  }

  function drawVisit(res, sel, shops, results) {
    const map = new Map();
    const undecided = [];
    const errs = [];
    let order = 0;
    for (const d of sel) {
      for (const s of shops) {
        const r = results[`${s.id}|${d.iso}`];
        if (!r || r.error) { errs.push(`${d.label} ${s.name}`); continue; }
        if (!r.found || (r.schedule && r.schedule[d.md] === '未定' && !r.casts.length)) { undecided.push(`${d.label} ${s.name}`); continue; }
        for (const c of r.casts) {
          const k = `${s.id}:${c.id}`;
          if (!map.has(k)) map.set(k, { k, c, s, days: new Set(), order: order++ });
          map.get(k).days.add(d.iso);
        }
      }
    }
    const shopIdx = (s) => SHOPS.findIndex((x) => x.id === s.id);
    const rows = [...map.values()].sort((a, b) =>
      b.days.size - a.days.size || (isFav(b.k) - isFav(a.k)) || shopIdx(a.s) - shopIdx(b.s) || a.order - b.order);
    const total = rows.reduce((n, r) => n + r.days.size, 0);
    const cls = (d) => (d.wd === 0 ? 'sun' : d.wd === 6 ? 'sat' : '');
    const favRows = rows.filter((r) => isFav(r.k));
    const favLine = favRows.length
      ? `<br>★推し: ${favRows.map((r) => `${esc(r.c.name)} ${r.days.size}回`).join('・')}` : '';
    const notes = [
      undecided.length ? `<p class="vnote">まだ未定: ${esc(undecided.join('、'))}（出勤が出たら回数が増えるかも）</p>` : '',
      errs.length ? `<p class="vnote err">取得失敗: ${esc(errs.join('、'))}（↻で再試行）</p>` : '',
    ].join('');
    if (!rows.length) {
      res.innerHTML = `<div class="msg">選んだ日に出勤が出ているキャストがいません</div>${notes}`;
      return;
    }
    res.innerHTML = `
      <p class="vsum"><b>${rows.length}人</b> に会えます（のべ${total}回・${sel.length}日間）${favLine}</p>
      <div class="vm">
        <div class="vr vh" style="--cols:${sel.length}"><div class="vn">キャスト</div>${sel.map((d) => `<div class="vc ${cls(d)}">${+d.iso.slice(8)}<small>${WD[d.wd]}</small></div>`).join('')}<div class="vt">回数</div></div>
        ${rows.map((r) => `
          <div class="vr" style="--cols:${sel.length};--c:${esc(r.s.color)}">
            <div class="vn"><a href="${esc(r.c.url)}">${isFav(r.k) ? '<span class="fv-mark">★</span>' : ''}${esc(r.c.name)}</a><small>${esc(r.s.name)}</small></div>
            ${sel.map((d) => `<div class="vc">${r.days.has(d.iso) ? '<span class="dm">●</span>' : ''}</div>`).join('')}
            <div class="vt"><b>${r.days.size}</b>回</div>
          </div>`).join('')}
      </div>${notes}`;
  }

  // ---------- ランキングモード ----------
  function renderRank(force) {
    const my = ++token;
    bodyEl.innerHTML = `
      <div class="rk-top">
        <input class="q" type="search" placeholder="名前・店名で絞り込み" enterkeyhint="search">
        <div class="flt">
          <button type="button" class="fchip ${rankNoGirls ? 'on' : ''}" data-f="ng">ガールズバーを除く</button>
          <button type="button" class="fchip ${rankFavOnly ? 'on' : ''}" data-f="fav">★推しだけ</button>
        </div>
        <p class="sum st">カワいいね！の数で並べた沖縄のキャストランキング</p>
      </div>
      <div class="rl"><div class="msg"><span class="ld"></span><span class="pg">準備中…</span></div></div>`;
    const q = bodyEl.querySelector('.q');
    q.value = rankQuery;
    q.addEventListener('input', () => { rankQuery = q.value; rankLimit = 100; drawRankList(); });
    rankProgress = (p) => {
      const pg = my === token && bodyEl.querySelector('.pg');
      if (!pg) return;
      pg.textContent = p.phase === 'list'
        ? `店舗一覧を読み込み中…（${p.page}ページ目）`
        : `キャスト情報を集計中… ${p.done}/${p.total}店（初回は1分ほど）`;
    };
    getRank(force)
      .then((o) => { rankData = o; if (my === token) drawRankList(); })
      .catch((err) => {
        if (my !== token) return;
        bodyEl.querySelector('.rl').innerHTML = `<div class="msg">集計できませんでした（${esc(err && err.message || err)}）<br>↻ で再試行できます</div>`;
      });
  }

  function drawRankList() {
    const o = rankData;
    const rl = bodyEl.querySelector('.rl');
    const st = bodyEl.querySelector('.st');
    if (!o || !rl) return;
    let list = o.casts;
    if (rankNoGirls) list = list.filter((c) => !GIRLS_RE.test(c.shopName));
    let rank = 0;
    let prev = null;
    let view = list.map((c, i) => {
      if (c.heart !== prev) { rank = i + 1; prev = c.heart; }
      return { c, rank };
    });
    const q = norm(rankQuery).toLowerCase();
    if (q) view = view.filter(({ c }) => `${c.name} ${c.shopName}`.toLowerCase().includes(q));
    if (rankFavOnly) view = view.filter(({ c }) => isFav(`${c.shopId}:${c.id}`));
    st.textContent = `集計 ${fmtTime(o.t)}・${o.shops}店・${list.length}人（カワいいね！の数順／↻で再集計）`;
    if (!view.length) {
      rl.innerHTML = `<div class="msg">${rankFavOnly ? 'ランキング内に★推しがいません' : '該当するキャストがいません'}</div>`;
      return;
    }
    rl.innerHTML = view.slice(0, rankLimit).map(({ c, rank: r }) => {
      const shop = shopById(c.shopId, c.shopName);
      const mine = SHOPS.some((s) => s.id === c.shopId);
      return `
      <div class="rr ${r <= 3 ? `r${r}` : ''} ${mine ? 'mine' : ''}" style="--c:${esc(shop.color)}">
        <span class="rn">${r}</span>
        <a class="rlink" href="${esc(c.url)}">
          <span class="ra">${c.img ? `<img src="${esc(c.img)}" alt="" loading="lazy">` : ''}<span class="ini" ${c.img ? 'hidden' : ''}>${esc((c.name || '?').slice(0, 1))}</span></span>
          <span class="rt"><b>${esc(c.name)}</b><small>${esc(c.shopName)}</small></span>
          <span class="rh">♡${c.heart.toLocaleString('ja-JP')}</span>
        </a>
        ${starBtn(`${c.shopId}:${c.id}`, c.name, { id: c.shopId, name: shop.name })}
      </div>`;
    }).join('') + (view.length > rankLimit
      ? `<button type="button" class="btn more">もっと見る（残り${view.length - rankLimit}人）</button>` : '');
  }

  mount();
})();
