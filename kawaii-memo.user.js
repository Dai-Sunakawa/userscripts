// ==UserScript==
// @name         カフェるん カワいいね！増え方メモ
// @namespace    https://shop.caferun.jp/kawaii-memo
// @version      1.0.1
// @description  キャストページを開くたびに「カワいいね！」の数を記録して、前回からの増加と1日あたりのペースを表示します
// @match        https://shop.caferun.jp/shop/*/cast/*
// @run-at       document-idle
// @grant        none
// @noframes
// @homepageURL  https://github.com/Dai-Sunakawa/userscripts
// @updateURL    https://raw.githubusercontent.com/Dai-Sunakawa/userscripts/main/kawaii-memo.user.js
// @downloadURL  https://raw.githubusercontent.com/Dai-Sunakawa/userscripts/main/kawaii-memo.user.js
// ==/UserScript==

(() => {
  'use strict';

  const pm = location.pathname.match(/^\/shop\/(\d+)\/cast\/(\d+)/);
  if (!pm) return;
  const shopId = pm[1];
  const castId = pm[2];
  const KEY = `kt3kawaii:${shopId}:${castId}`;
  const INDEX_KEY = 'kt3kawaii:index';
  const SAME_VISIT_MIN = 10;  // この分数以内の開き直しは同じ訪問として扱う
  const MAX_ENTRIES = 300;    // 1人あたりの記録上限

  // ---------- 保存 ----------
  const load = (k, def) => { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? def : v; } catch (_) { return def; } };
  const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (_) { return false; } };

  // ---------- 表示用 ----------
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (t) => new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(t));
  const fmtDay = (t) => new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric' }).format(new Date(t));
  const num = (n) => n.toLocaleString('ja-JP');
  const signed = (n) => (n > 0 ? `+${num(n)}` : n < 0 ? `−${num(-n)}` : '±0');
  function ago(ms) {
    const m = Math.round(ms / 60e3);
    if (m < 60) return `${Math.max(m, 1)}分前`;
    const h = Math.round(m / 60);
    if (h < 48) return `${h}時間前`;
    return `${Math.round(h / 24)}日前`;
  }

  // ---------- ページから読み取り ----------
  // 「カワいいね！」の文字のあと(ハートの絵のあと)に出てくる数字を拾う
  function findCount() {
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n;
    let armed = 0;
    while ((n = w.nextNode())) {
      const p = n.parentElement;
      if (p && /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(p.tagName)) continue;
      const t = n.nodeValue.replace(/\s+/g, ' ').trim();
      if (!t) continue;
      if (/カワいいね/.test(t)) {
        const same = t.match(/カワいいね[！!]?\s*([\d,]+)/);
        if (same) return +same[1].replace(/,/g, '');
        armed = 6;
        continue;
      }
      if (armed > 0) {
        armed--;
        const mm = t.match(/^([\d,]+)$/);
        if (mm) return +mm[1].replace(/,/g, '');
      }
    }
    return null;
  }

  function castInfo() {
    // <title> 柊おるこ - アニメ・コスプレ隣人部。（沖縄） | カフェるん
    const tm = document.title.match(/^(.+?)\s+-\s+(.+?)(?:（[^）]*）)?\s*\|/);
    const h1 = document.querySelector('h1');
    return {
      name: tm ? tm[1].trim() : (h1 && h1.textContent.trim()) || `キャスト${castId}`,
      shopName: tm ? tm[2].trim() : '',
    };
  }

  // ---------- 記録 ----------
  function record(count) {
    const now = Date.now();
    let hist = load(KEY, []);
    if (!Array.isArray(hist)) hist = [];
    const cutoff = now - SAME_VISIT_MIN * 60e3;
    const prev = [...hist].reverse().find((e) => e.t < cutoff) || null;
    const last = hist[hist.length - 1];
    if (last && last.t >= cutoff) { last.t = now; last.n = count; } else hist.push({ t: now, n: count });
    if (hist.length > MAX_ENTRIES) hist = hist.slice(-MAX_ENTRIES);
    const ok = save(KEY, hist);

    const info = castInfo();
    const idx = load(INDEX_KEY, {});
    idx[`${shopId}:${castId}`] = {
      name: info.name, shopName: info.shopName, url: location.origin + location.pathname,
      last: count, t: now, first: hist[0].n, firstT: hist[0].t,
    };
    save(INDEX_KEY, idx);

    // 1日あたりのペース（直近7日。12時間以上の記録があるときだけ）
    let pace = null;
    const base = hist.find((e) => e.t >= now - 7 * 864e5) || hist[0];
    if (base && now - base.t >= 12 * 36e5) {
      pace = { perDay: (count - base.n) / ((now - base.t) / 864e5), since: base.t };
    }
    return { now, hist, prev, pace, info, ok };
  }

  // ---------- 画面 ----------
  const STYLE = `
  :host { all: initial; }
  * { box-sizing: border-box; }
  .wrap {
    position: fixed; left: 12px; bottom: 88px; z-index: 2147482990; max-width: calc(100vw - 100px);
    font: 13px/1.45 system-ui, -apple-system, "Hiragino Sans", "Hiragino Kaku Gothic ProN", sans-serif;
    --bg: #fff; --fg: #1d1b22; --sub: #6f6a78; --line: #ece9f1; --chip: #f5f2f7; --pink: #e5487a; --up: #1f9d55;
    color: var(--fg);
  }
  @media (prefers-color-scheme: dark) {
    .wrap { --bg: #1f1d24; --fg: #f2f0f5; --sub: #a29cad; --line: #322f39; --chip: #2a2731; }
  }
  .badge {
    display: flex; align-items: center; gap: 8px; border: none; cursor: pointer; text-align: left;
    background: var(--bg); color: var(--fg); border-radius: 999px; padding: 8px 14px 8px 12px; font: inherit;
    box-shadow: 0 4px 16px rgba(0,0,0,.22); -webkit-tap-highlight-color: transparent;
  }
  .badge .h { color: var(--pink); font-weight: 800; font-size: 15px; white-space: nowrap; }
  .badge .d { font-size: 12px; color: var(--sub); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .badge .d b { color: var(--up); font-size: 13px; }
  .panel {
    position: fixed; left: 10px; right: 10px; bottom: 88px; max-width: 460px; max-height: 70vh; overflow-y: auto;
    background: var(--bg); border-radius: 18px; padding: 14px 14px 12px; box-shadow: 0 10px 34px rgba(0,0,0,.3);
    -webkit-overflow-scrolling: touch;
  }
  .panel[hidden], .badge[hidden] { display: none; }
  .top { display: flex; align-items: flex-start; gap: 8px; }
  .top .nm { flex: 1; min-width: 0; }
  .top .nm b { font-size: 16px; display: block; }
  .top .nm small { color: var(--sub); font-size: 11px; }
  .x { border: none; background: var(--chip); color: var(--fg); width: 32px; height: 32px; border-radius: 50%; font-size: 16px; cursor: pointer; flex: 0 0 auto; }
  .big { font-size: 30px; font-weight: 800; color: var(--pink); margin: 4px 0 8px; }
  .big small { font-size: 12px; color: var(--sub); font-weight: 400; margin-left: 6px; }
  .rows { display: grid; gap: 6px; margin-bottom: 10px; }
  .row { display: flex; justify-content: space-between; gap: 10px; background: var(--chip); border-radius: 10px; padding: 7px 10px; }
  .row span { color: var(--sub); font-size: 12px; }
  .row b { font-size: 14px; white-space: nowrap; }
  .row b.up { color: var(--up); }
  .row small { display: block; font-size: 10px; color: var(--sub); font-weight: 400; text-align: right; }
  svg { display: block; width: 100%; height: 56px; margin: 4px 0 10px; }
  h3 { font-size: 12px; color: var(--sub); margin: 12px 0 6px; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  td { padding: 5px 2px; border-top: 1px solid var(--line); }
  td.n { text-align: right; font-weight: 700; }
  td.dd { text-align: right; color: var(--up); width: 64px; }
  .others a { display: flex; gap: 8px; align-items: center; padding: 7px 2px; border-top: 1px solid var(--line); color: var(--fg); text-decoration: none; }
  .others .on { flex: 1; min-width: 0; }
  .others .on b { display: block; font-size: 13px; }
  .others .on small { display: block; font-size: 10px; color: var(--sub); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .others .hv { text-align: right; font-size: 12px; white-space: nowrap; }
  .others .hv b { color: var(--pink); }
  .others .hv small { display: block; color: var(--up); font-size: 11px; }
  .note { font-size: 11px; color: var(--sub); margin: 8px 0 0; }
  .reset { margin-top: 12px; width: 100%; border: 1px solid var(--line); background: transparent; color: var(--sub); border-radius: 10px; padding: 8px; font: inherit; font-size: 12px; cursor: pointer; }
  .reset.arm { color: #e5484d; border-color: #e5484d; }
  `;

  function spark(hist) {
    const pts = hist.slice(-60);
    if (pts.length < 2) return '';
    const W = 300, H = 56, P = 4;
    const t0 = pts[0].t, t1 = pts[pts.length - 1].t || t0 + 1;
    const vs = pts.map((e) => e.n);
    const lo = Math.min(...vs), hi = Math.max(...vs);
    const x = (t) => P + ((t - t0) / Math.max(t1 - t0, 1)) * (W - P * 2);
    const y = (v) => H - P - ((v - lo) / Math.max(hi - lo, 1)) * (H - P * 2);
    const d = pts.map((e, i) => `${i ? 'L' : 'M'}${x(e.t).toFixed(1)},${y(e.n).toFixed(1)}`).join(' ');
    const last = pts[pts.length - 1];
    return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-label="カワいいね！の推移">
      <path d="${d}" fill="none" stroke="#e5487a" stroke-width="2" vector-effect="non-scaling-stroke"/>
      <circle cx="${x(last.t).toFixed(1)}" cy="${y(last.n).toFixed(1)}" r="3" fill="#e5487a"/></svg>`;
  }

  function mount(count, r) {
    const host = document.createElement('div');
    host.id = 'kt3-kawaii-host';
    document.documentElement.appendChild(host);
    const root = host.attachShadow({ mode: 'open' });
    const { now, hist, prev, pace, info, ok } = r;

    const diffTxt = prev
      ? `<b>${signed(count - prev.n)}</b> 前回(${ago(now - prev.t)})から`
      : '初回記録・次から増え方が出ます';

    const rows = [];
    if (prev) rows.push(`<div class="row"><span>前回から</span><b class="up">${signed(count - prev.n)}<small>${esc(fmt(prev.t))}・${ago(now - prev.t)}</small></b></div>`);
    if (pace) rows.push(`<div class="row"><span>1日あたり</span><b class="up">${pace.perDay >= 0 ? '+' : ''}${pace.perDay.toFixed(1)}<small>${esc(fmtDay(pace.since))}からのペース</small></b></div>`);
    if (hist.length > 1 && hist[0].t < now - SAME_VISIT_MIN * 60e3) {
      rows.push(`<div class="row"><span>記録開始から</span><b class="up">${signed(count - hist[0].n)}<small>${esc(fmtDay(hist[0].t))}から・${hist.length}回記録</small></b></div>`);
    }

    const recent = hist.slice(-10).reverse();
    const histRows = recent.map((e, i) => {
      const older = hist[hist.length - 2 - i];
      return `<tr><td>${esc(fmt(e.t))}</td><td class="n">♡${num(e.n)}</td><td class="dd">${older ? signed(e.n - older.n) : ''}</td></tr>`;
    }).join('');

    const idx = load(INDEX_KEY, {});
    const others = Object.entries(idx)
      .filter(([k]) => k !== `${shopId}:${castId}`)
      .sort((a, b) => b[1].t - a[1].t)
      .slice(0, 30)
      .map(([, v]) => `<a href="${esc(v.url)}"><span class="on"><b>${esc(v.name)}</b><small>${esc(v.shopName || '')}・${esc(fmt(v.t))}に確認</small></span>
        <span class="hv"><b>♡${num(v.last)}</b>${v.firstT < v.t - SAME_VISIT_MIN * 60e3 ? `<small>${signed(v.last - v.first)}（${esc(fmtDay(v.firstT))}〜）</small>` : ''}</span></a>`)
      .join('');

    root.innerHTML = `
      <style>${STYLE}</style>
      <div class="wrap">
        <button class="badge" type="button" aria-label="カワいいね！の記録を開く">
          <span class="h">♡${num(count)}</span><span class="d">${diffTxt}</span>
        </button>
        <div class="panel" hidden>
          <div class="top">
            <div class="nm"><b>${esc(info.name)}</b><small>${esc(info.shopName)}</small></div>
            <button class="x" type="button" aria-label="閉じる">×</button>
          </div>
          <div class="big">♡${num(count)}<small>カワいいね！（${esc(fmt(now))}）</small></div>
          ${rows.length ? `<div class="rows">${rows.join('')}</div>` : '<p class="note">初めての記録です。次にこのページを開いたとき、ここに増え方が出ます。</p>'}
          ${spark(hist)}
          ${hist.length > 1 ? `<h3>記録（新しい順）</h3><table>${histRows}</table>` : ''}
          ${others ? `<h3>ほかに記録しているキャスト</h3><div class="others">${others}</div>` : ''}
          ${ok ? '' : '<p class="note">※この端末に保存できませんでした（プライベートブラウズでは記録されません）</p>'}
          <p class="note">${SAME_VISIT_MIN}分以内に開き直したときは同じ訪問としてまとめます。記録はこのiPhoneのSafariの中だけに保存されます。</p>
          <button class="reset" type="button">このキャストの記録を消す</button>
        </div>
      </div>`;

    const badge = root.querySelector('.badge');
    const panel = root.querySelector('.panel');
    badge.addEventListener('click', () => { panel.hidden = false; badge.hidden = true; });
    root.querySelector('.x').addEventListener('click', () => { panel.hidden = true; badge.hidden = false; });
    const reset = root.querySelector('.reset');
    reset.addEventListener('click', () => {
      if (!reset.classList.contains('arm')) {
        reset.classList.add('arm');
        reset.textContent = 'もう一度押すと消えます';
        setTimeout(() => { reset.classList.remove('arm'); reset.textContent = 'このキャストの記録を消す'; }, 4000);
        return;
      }
      try {
        localStorage.removeItem(KEY);
        const ix = load(INDEX_KEY, {});
        delete ix[`${shopId}:${castId}`];
        save(INDEX_KEY, ix);
      } catch (_) { /* noop */ }
      reset.textContent = '消しました';
      reset.disabled = true;
    });
  }

  function showMissing() {
    const host = document.createElement('div');
    host.id = 'kt3-kawaii-host';
    document.documentElement.appendChild(host);
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>${STYLE}</style><div class="wrap"><button class="badge" type="button"><span class="d">カワいいね！の数が見つかりませんでした</span></button></div>`;
    root.querySelector('.badge').addEventListener('click', () => host.remove());
  }

  // ---------- 実行（数字が後から出るページにも対応して最大8秒待つ） ----------
  function start() {
    if (document.getElementById('kt3-kawaii-host')) return true;
    const c = findCount();
    if (c != null) { mount(c, record(c)); return true; }
    return false;
  }
  if (!start()) {
    const mo = new MutationObserver(() => { if (start()) { mo.disconnect(); clearTimeout(timer); } });
    mo.observe(document.body, { childList: true, subtree: true, characterData: true });
    const timer = setTimeout(() => { mo.disconnect(); if (!document.getElementById('kt3-kawaii-host')) showMissing(); }, 8000);
  }
})();
