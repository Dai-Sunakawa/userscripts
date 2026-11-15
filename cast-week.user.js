// ==UserScript==
// @name         カフェるん キャストの今週の出勤
// @namespace    https://shop.caferun.jp/cast-week
// @version      1.0.0
// @description  キャストページに、その子の今日から7日分の出勤予定（出勤日・時間）を表示します
// @match        https://shop.caferun.jp/shop/*/cast/*
// @run-at       document-idle
// @grant        none
// @noframes
// @homepageURL  https://github.com/Dai-Sunakawa/userscripts
// @updateURL    https://raw.githubusercontent.com/Dai-Sunakawa/userscripts/main/cast-week.user.js
// @downloadURL  https://raw.githubusercontent.com/Dai-Sunakawa/userscripts/main/cast-week.user.js
// ==/UserScript==

(() => {
  'use strict';

  const pm = location.pathname.match(/^\/shop\/(\d+)\/cast\/(\d+)/);
  if (!pm) return;
  const SHOP_ID = pm[1];
  const CAST_ID = pm[2];
  const ORIGIN = location.origin;
  const DAYS = 7;
  const CACHE_MIN = 5;
  const NET_PARALLEL = 2;
  const NET_GAP_MS = 300;

  const WD = ['日', '月', '火', '水', '木', '金', '土'];
  // 「11/15(本日)の出勤 4人」「11/16(明日)の出勤 4人」「11/19の出勤 4人」
  const ATT_RE = /(\d{1,2})\s*[/月]\s*(\d{1,2})\s*日?\s*(?:[（(]\s*([^)）]{1,4})\s*[)）])?\s*の出勤(?:\s*(\d+)\s*人)?/;
  // 出勤予定リスト「11/17(火) 5人」「11/16(月) 未定」
  const SCHED_RE = /^(\d{1,2})\s*[/月]\s*(\d{1,2})\s*日?\s*[（(]\s*[日月火水木金土]\s*[)）]\s*(?:(\d+)\s*人|(未定))$/;
  const ALL_RE = /^キャスト\s*\d+\s*人$/;
  const TIME_RE = /(\d{1,2}[:：]\d{2})\s*[〜~～\-－–]\s*((?:翌\s*)?\d{1,2}[:：]\d{2}|LAST|Last|last|ラスト)?/;
  const SKIP_TAG = /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/;
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ---------- 日付（日本時間） ----------
  function buildDays() {
    const f = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' });
    const p = Object.fromEntries(f.formatToParts(new Date()).map((x) => [x.type, x.value]));
    const out = [];
    for (let i = 0; i < DAYS; i++) {
      const dt = new Date(Date.UTC(+p.year, +p.month - 1, +p.day + i));
      out.push({ i, iso: dt.toISOString().slice(0, 10), md: `${dt.getUTCMonth() + 1}/${dt.getUTCDate()}`, wd: dt.getUTCDay() });
    }
    return out;
  }

  // ---------- 通信（同時数・間隔を制限、混雑時は待って再試行） ----------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const q = [];
  let active = 0;
  let last = 0;
  let timer = null;
  function politeFetch(url) {
    return new Promise((resolve, reject) => { q.push({ url, resolve, reject }); pump(); });
  }
  function pump() {
    while (active < NET_PARALLEL && q.length) {
      const wait = last + NET_GAP_MS - Date.now();
      if (wait > 0) {
        if (!timer) timer = setTimeout(() => { timer = null; last = Date.now() - NET_GAP_MS; pump(); }, wait);
        return;
      }
      const job = q.shift();
      active++;
      last = Date.now();
      fetchRetry(job.url).then(job.resolve, job.reject).finally(() => { active--; pump(); });
    }
  }
  async function fetchRetry(url) {
    for (let i = 0; ; i++) {
      let res;
      try { res = await fetch(url, { credentials: 'include' }); } catch (e) {
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

  // ---------- 解析（クラス名に依存しない） ----------
  function parseHTML(html, url) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    try { const b = doc.createElement('base'); b.setAttribute('href', url); (doc.head || doc.documentElement).prepend(b); } catch (_) { /* noop */ }
    return doc;
  }
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
  const castIdOf = (a) => { const m = (a.href || '').match(new RegExp(`/shop/${SHOP_ID}/cast/(\\d+)`)); return m ? m[1] : null; };

  function parseSchedule(doc, base) {
    const sched = {};
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
          sched[md] = m[4] ? '未定' : `${m[3]}人`;
          const a = el.closest('a[href]') || el.querySelector('a[href]');
          if (a) { try { links[md] = new URL(a.getAttribute('href'), base).href; } catch (_) { /* noop */ } }
          break;
        }
      }
    }
    return { sched, links };
  }

  // その日の出勤欄に、このキャストがいるか（いれば時間も）
  function parseDay(html, url) {
    const doc = parseHTML(html, url);
    const { sched, links } = parseSchedule(doc, url);
    const head = findTextEl(doc, 'の出勤', (t) => { const m = t.match(ATT_RE); return m ? { m, full: m[4] != null } : null; });
    if (!head) return { found: false, sched, links };
    const m = head.r.m;
    const count = m[4] != null ? +m[4] : null;
    const end = findTextEl(doc, 'キャスト', (t) => (ALL_RE.test(t) ? { full: true } : null), head.el);
    const ids = [];
    let mine = null;
    for (const a of doc.querySelectorAll('a[href*="cast/"]')) {
      const id = castIdOf(a);
      if (!id) continue;
      if (!(head.el.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
      if (end && !(end.el.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_PRECEDING)) continue;
      if (!ids.includes(id)) {
        if (count != null && ids.length >= count) continue;
        ids.push(id);
      }
      if (id === CAST_ID && !mine) mine = a;
    }
    let time = '';
    if (mine) {
      // カードの範囲（ほかのキャストのリンクを含まない一番外側）から時間を探す
      let el = mine;
      for (let i = 0; i < 6 && el.parentElement; i++) {
        const p = el.parentElement;
        if (p.tagName === 'BODY' || p.contains(head.el) || (end && p.contains(end.el))) break;
        const others = [...p.querySelectorAll('a[href*="cast/"]')].some((x) => { const c = castIdOf(x); return c && c !== CAST_ID; });
        if (others) break;
        el = p;
      }
      const tm = norm(el.textContent).match(TIME_RE);
      if (tm) time = `${tm[1].replace('：', ':')}〜${(tm[2] || '').replace(/\s+/g, '').replace('：', ':')}`;
    }
    return { found: true, siteMd: `${+m[1]}/${+m[2]}`, working: !!mine, time, sched, links };
  }

  // ---------- 取得＋キャッシュ ----------
  const cacheKey = (iso) => `kt3castweek:${SHOP_ID}:${iso}`;
  function cacheGet(iso) {
    try {
      const o = JSON.parse(sessionStorage.getItem(cacheKey(iso)) || 'null');
      if (o && Date.now() - o.t < CACHE_MIN * 60e3) return o.v;
    } catch (_) { /* noop */ }
    return null;
  }
  function cacheSet(iso, v) { try { sessionStorage.setItem(cacheKey(iso), JSON.stringify({ t: Date.now(), v })); } catch (_) { /* noop */ } }

  async function loadDay(day, todayRes) {
    const hit = cacheGet(day.iso);
    if (hit) return hit;
    let url = `${ORIGIN}/shop/${SHOP_ID}/castlist/${day.i === 0 ? '' : `${day.iso}/`}`;
    if (day.i !== 0 && todayRes && todayRes.links && todayRes.links[day.md]) url = todayRes.links[day.md];
    const res = await politeFetch(url);
    if (!res.ok) return { state: res.status === 404 ? 'undecided' : 'error', url, status: res.status };
    const r = parseDay(await res.text(), res.url || url);
    let out;
    if (!r.found) {
      out = { state: r.sched[day.md] === '未定' ? 'undecided' : 'error', url };
    } else if (day.i !== 0 && r.siteMd !== day.md) {
      out = { state: 'error', url, why: `${r.siteMd}のページが返ってきました` };
    } else {
      out = { state: r.working ? 'on' : (r.sched[day.md] === '未定' ? 'undecided' : 'off'), time: r.time, url };
    }
    out.links = r.links;
    if (out.state !== 'error') cacheSet(day.iso, out);
    return out;
  }

  // ---------- 画面 ----------
  const STYLE = `
  :host { all: initial; display: block; }
  * { box-sizing: border-box; }
  .card {
    margin: 12px 0; padding: 12px 12px 10px; border-radius: 16px; border: 1px solid var(--line);
    background: var(--bg); color: var(--fg);
    font: 13px/1.4 system-ui, -apple-system, "Hiragino Sans", "Hiragino Kaku Gothic ProN", sans-serif;
    --bg: #fff; --fg: #1d1b22; --sub: #6f6a78; --line: #ece9f1; --chip: #f6f3f8; --on: #e5487a;
  }
  @media (prefers-color-scheme: dark) {
    .card { --bg: #1f1d24; --fg: #f2f0f5; --sub: #a29cad; --line: #322f39; --chip: #2a2731; }
  }
  .hd { display: flex; align-items: baseline; gap: 8px; margin-bottom: 8px; }
  .hd b { font-size: 15px; }
  .hd .sum { margin-left: auto; font-size: 12px; color: var(--sub); }
  .hd .sum strong { color: var(--on); font-size: 15px; }
  .days { display: grid; grid-template-columns: repeat(7, 1fr); gap: 4px; }
  .d {
    display: block; text-decoration: none; color: var(--fg); background: var(--chip); border-radius: 10px;
    padding: 6px 0 5px; text-align: center; min-height: 72px; border: 1px solid transparent;
  }
  .d .dt { font-size: 12px; font-weight: 700; }
  .d .w { font-size: 10px; color: var(--sub); }
  .d.sun .dt, .d.sun .w { color: #e5484d; } .d.sat .dt, .d.sat .w { color: #3e7bfa; }
  .d .mk { font-size: 17px; line-height: 1.3; margin-top: 2px; color: var(--sub); }
  .d .tm { font-size: 9px; color: var(--sub); line-height: 1.15; padding: 0 2px; word-break: break-all; }
  .d.on { background: var(--on); border-color: var(--on); color: #fff; }
  .d.on .w, .d.on .mk, .d.on .tm, .d.on .dt { color: #fff; }
  .d.today { border-color: var(--fg); }
  .d.err .mk { color: #e5484d; }
  .ld { display: inline-block; width: 12px; height: 12px; border: 2px solid var(--line); border-top-color: var(--on); border-radius: 50%; animation: sp .8s linear infinite; }
  @keyframes sp { to { transform: rotate(360deg); } }
  .ft { margin-top: 8px; font-size: 10px; color: var(--sub); }
  `;

  function mount() {
    if (document.getElementById('kt3-castweek-host')) return null;
    const host = document.createElement('div');
    host.id = 'kt3-castweek-host';
    const h1 = document.querySelector('h1');
    if (h1 && h1.parentElement) h1.insertAdjacentElement('afterend', host);
    else document.body.prepend(host);
    return host.attachShadow({ mode: 'open' });
  }

  async function main() {
    const root = mount();
    if (!root) return;
    const days = buildDays();
    root.innerHTML = `<style>${STYLE}</style>
      <div class="card">
        <div class="hd"><b>今週の出勤</b><span class="sum">確認中…</span></div>
        <div class="days">${days.map((d) => `
          <a class="d ${d.wd === 0 ? 'sun' : d.wd === 6 ? 'sat' : ''} ${d.i === 0 ? 'today' : ''}" data-i="${d.i}"
             href="${ORIGIN}/shop/${SHOP_ID}/castlist/${d.i === 0 ? '' : `${d.iso}/`}">
            <div class="dt">${d.md}</div><div class="w">${d.i === 0 ? '今日' : WD[d.wd]}</div>
            <div class="mk"><span class="ld"></span></div><div class="tm"></div>
          </a>`).join('')}
        </div>
        <div class="ft">● 出勤　－ 休み　？ 未定（カフェるんの出勤表から）・日付をタップでその日の出勤一覧</div>
      </div>`;
    const cell = (i) => root.querySelector(`.d[data-i="${i}"]`);
    const draw = (d, r) => {
      const c = cell(d.i);
      c.href = r.url || c.href;
      const mk = c.querySelector('.mk');
      const tm = c.querySelector('.tm');
      c.classList.toggle('on', r.state === 'on');
      c.classList.toggle('err', r.state === 'error');
      mk.textContent = r.state === 'on' ? '●' : r.state === 'off' ? '－' : r.state === 'undecided' ? '？' : '!';
      tm.textContent = r.state === 'on' ? (r.time || '') : r.state === 'error' ? '取得失敗' : '';
      if (r.state === 'error') c.title = r.why || (r.status ? `HTTP ${r.status}` : '');
    };
    const results = [];
    let today;
    try { today = await loadDay(days[0], null); } catch (_) { today = { state: 'error' }; }
    results[0] = today;
    draw(days[0], today);
    await Promise.all(days.slice(1).map(async (d) => {
      let r;
      try { r = await loadDay(d, today); } catch (_) { r = { state: 'error' }; }
      results[d.i] = r;
      draw(d, r);
    }));
    const on = results.filter((r) => r && r.state === 'on').length;
    const und = results.filter((r) => r && r.state === 'undecided').length;
    root.querySelector('.sum').innerHTML = `7日間で <strong>${on}</strong>日出勤${und ? `（未定${und}日）` : ''}`;
  }

  main();
})();
