// ==UserScript==
// @name         カフェるん キープ一覧に沖縄キャストランキングを表示
// @namespace    https://shop.caferun.jp/
// @version      1.2.0
// @description  キープ中キャスト一覧の名前横に、カフェるん週間キャストランキング（沖縄・那覇）の順位と前回比を表示します
// @match        https://shop.caferun.jp/member/keep/cast*
// @match        https://shop.caferun.jp/keep/cast*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addStyle
// @run-at       document-idle
// @noframes
// @homepageURL  https://github.com/Dai-Sunakawa/userscripts
// @updateURL    https://raw.githubusercontent.com/Dai-Sunakawa/userscripts/main/caferun-okinawa-rank.user.js
// @downloadURL  https://raw.githubusercontent.com/Dai-Sunakawa/userscripts/main/caferun-okinawa-rank.user.js
// ==/UserScript==

(function () {
  'use strict';

  /* ===================== 設定 ===================== */
  const CONFIG = {
    // 沖縄・那覇エリアの週間キャストランキング（男性向け/女性向け・コンセプトは指定なし）
    castRankingUrl: 'https://shop.caferun.jp/ranking/cast/area_7/mid_area_36/sub_area_58/all/all/',
    // 沖縄の店舗IDを補うためのショップランキング（「圏外」判定に使用）
    shopRankingUrl: 'https://shop.caferun.jp/ranking/shop/area_7/mid_area_36/sub_area_58/all/all/',
    cacheTtlMs: 3 * 60 * 60 * 1000, // ランキングのキャッシュ時間（3時間）
    showOutOfRank: true,            // 沖縄の店のキャストが50位圏外なら「圏外」を表示する
    historyWeeks: 8,                // 前回比の計算用に保存しておく週数
    nameFallback: true,             // キャストページへのリンクが無いページでは名前の完全一致で推定表示
  };

  const TAG = '[沖縄ランク]';
  const KEY_CACHE = 'okr_cache_v1';
  const KEY_HIST = 'okr_history_v1';
  const CAST_HREF = /\/shop\/(\d+)\/cast\/(\d+)/;
  const SHOP_HREF = /\/shop\/(\d+)/;
  const RANK_TEXT = /No\.\s*\d+/g;
  const PERIOD_TEXT = /\d{4}年\d{1,2}月\d{1,2}日\s*[～〜~\-]\s*(?:\d{4}年)?\d{1,2}月\d{1,2}日/;
  const GENERIC_LINK = /詳細|詳しく|もっと|見る|プロフィール|more|view/i;

  let current = null; // { fetchedAt, period, ranks: {castId: {rank, name, shopId}}, shopIds: [] }

  /* ===================== 保存・スタイル（Tampermonkey / iOSのUserscripts両対応） ===================== */
  // Userscripts(iOS) は同期版 GM_getValue 等が無いので、その場合は localStorage に保存する
  function loadValue(key, def) {
    try { if (typeof GM_getValue === 'function') return GM_getValue(key, def); } catch (e) { /* fallthrough */ }
    try { const v = localStorage.getItem(key); return v == null ? def : JSON.parse(v); } catch (e) { return def; }
  }
  function saveValue(key, val) {
    try { if (typeof GM_setValue === 'function') { GM_setValue(key, val); return; } } catch (e) { /* fallthrough */ }
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* 保存できなくても表示は続ける */ }
  }
  function addStyle(css) {
    try { if (typeof GM_addStyle === 'function') { GM_addStyle(css); return; } } catch (e) { /* fallthrough */ }
    const s = document.createElement('style');
    s.textContent = css;
    (document.head || document.documentElement).appendChild(s);
  }

  /* ===================== ランキング取得・解析 ===================== */
  async function fetchDoc(url) {
    const res = await fetch(url, { credentials: 'include', cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
    const html = await res.text();
    return new DOMParser().parseFromString(html, 'text/html');
  }

  // 要素から祖先をたどり、「No.◯」をちょうど1つだけ含む最小の範囲から順位を読む
  function findRank(el) {
    for (let node = el; node && node.tagName !== 'BODY' && node.tagName !== 'HTML'; node = node.parentElement) {
      const hits = (node.textContent || '').match(RANK_TEXT);
      if (hits) return hits.length === 1 ? parseInt(hits[0].replace(/\D/g, ''), 10) : null;
    }
    return null;
  }

  function parseCastRanking(doc) {
    const ranks = {};
    const order = [];
    doc.querySelectorAll('a[href]').forEach((a) => {
      const m = (a.getAttribute('href') || '').match(CAST_HREF);
      if (!m) return;
      const [, shopId, castId] = m;
      const name = (a.textContent || '').trim() || ((a.querySelector('img') || {}).alt || '').trim();
      if (!order.includes(castId)) order.push(castId);
      const rank = findRank(a);
      const cur = ranks[castId];
      if (!cur) {
        ranks[castId] = { rank, name, shopId };
      } else {
        if (!cur.name && name) cur.name = name;
        if (cur.rank == null && rank != null) cur.rank = rank;
      }
    });
    // 「No.」表記が読めなかった場合だけ、掲載順を順位とみなす
    if (!Object.values(ranks).some((r) => r.rank != null)) {
      order.forEach((id, i) => { ranks[id].rank = i + 1; });
    }
    Object.keys(ranks).forEach((id) => { if (ranks[id].rank == null) delete ranks[id]; });
    const period = (((doc.body && doc.body.textContent) || '').match(PERIOD_TEXT) || [''])[0].replace(/\s+/g, '');
    return { ranks, period };
  }

  function parseShopIds(doc) {
    const ids = new Set();
    if (!doc) return ids;
    doc.querySelectorAll('a[href]').forEach((a) => {
      const m = (a.getAttribute('href') || '').match(SHOP_HREF);
      if (m && findRank(a) != null) ids.add(m[1]);
    });
    return ids;
  }

  async function getRanking(force) {
    const cache = loadValue(KEY_CACHE, null);
    if (!force && cache && cache.ranks && Date.now() - cache.fetchedAt < CONFIG.cacheTtlMs) return cache;

    const [castDoc, shopDoc] = await Promise.all([
      fetchDoc(CONFIG.castRankingUrl),
      fetchDoc(CONFIG.shopRankingUrl).catch((e) => { console.warn(TAG, 'ショップランキング取得失敗', e); return null; }),
    ]);
    const { ranks, period } = parseCastRanking(castDoc);
    if (!Object.keys(ranks).length) throw new Error('ランキングページからキャストを読み取れませんでした（ページ構成が変わった可能性）');

    const shopIds = parseShopIds(shopDoc);
    Object.values(ranks).forEach((r) => shopIds.add(r.shopId));

    const data = { fetchedAt: Date.now(), period, ranks, shopIds: [...shopIds] };
    saveValue(KEY_CACHE, data);
    saveHistory(period, ranks);
    console.log(TAG, `取得: ${period} / ${Object.keys(ranks).length}人`);
    return data;
  }

  /* ===================== 前回比（週ごとの履歴） ===================== */
  function saveHistory(period, ranks) {
    if (!period) return;
    let hist = loadValue(KEY_HIST, []);
    if (!Array.isArray(hist)) hist = [];
    const slim = {};
    Object.entries(ranks).forEach(([id, r]) => { slim[id] = r.rank; });
    const i = hist.findIndex((h) => h.period === period);
    if (i >= 0) hist[i].ranks = slim; else hist.push({ period, ranks: slim });
    saveValue(KEY_HIST, hist.slice(-CONFIG.historyWeeks));
  }

  function getPrev(period) {
    const hist = loadValue(KEY_HIST, []);
    if (!Array.isArray(hist) || !hist.length) return null;
    const i = hist.findIndex((h) => h.period === period);
    if (i > 0) return hist[i - 1];
    if (i === -1) return hist[hist.length - 1];
    return null;
  }

  /* ===================== キープ一覧への表示 ===================== */
  function ownText(el) {
    let t = '';
    el.childNodes.forEach((n) => { if (n.nodeType === 3) t += n.nodeValue; });
    return t.trim();
  }

  function textWithoutBadges(node) {
    let t = node.textContent || '';
    node.querySelectorAll('.okr-badge').forEach((b) => { t = t.replace(b.textContent, ''); });
    return t;
  }

  function collectCastGroups() {
    const groups = new Map();
    document.querySelectorAll('a[href]').forEach((a) => {
      const m = (a.getAttribute('href') || '').match(CAST_HREF);
      if (!m) return;
      const castId = m[2];
      if (!groups.has(castId)) groups.set(castId, { shopId: m[1], anchors: [] });
      groups.get(castId).anchors.push(a);
    });
    return groups;
  }

  // そのキャストのリンクをすべて含み、他のキャストのリンクを含まない範囲（＝カード）
  function cardOf(anchors, castId) {
    let node = anchors[0];
    while (node.parentElement && !anchors.every((a) => node.contains(a))) node = node.parentElement;
    for (let i = 0; i < 4 && node.parentElement && node.parentElement !== document.body; i++) {
      const up = node.parentElement;
      const hasOther = [...up.querySelectorAll('a[href]')].some((a) => {
        const m = (a.getAttribute('href') || '').match(CAST_HREF);
        return m && m[2] !== castId;
      });
      if (hasOther) break;
      node = up;
    }
    return node;
  }

  function findTextLeaf(root, preferName) {
    const els = [root, ...root.querySelectorAll('*')].filter((e) => !e.closest('.okr-badge'));
    if (preferName) {
      const hit = els.find((e) => ownText(e) === preferName);
      if (hit) return hit;
    }
    return els.find((e) => ownText(e) && !GENERIC_LINK.test(ownText(e))) || null;
  }

  // バッジを置く場所：名前リンクの直後 ＞ カード型リンク内の名前要素 ＞ 画像リンクの直後
  function pickTarget(anchors, name) {
    if (name) {
      const exact = anchors.find((a) => ownText(a) === name || a.textContent.trim() === name);
      if (exact) {
        if (!exact.querySelector('img')) return { el: exact, mode: 'after' };
        const leaf = findTextLeaf(exact, name);
        if (leaf) return { el: leaf, mode: leaf === exact ? 'after' : 'append' };
      }
    }
    const textOnly = anchors.find((a) => !a.querySelector('img') && a.textContent.trim() && !GENERIC_LINK.test(a.textContent.trim()));
    if (textOnly) return { el: textOnly, mode: 'after' };
    for (const a of anchors) {
      if (!a.textContent.trim()) continue;
      const leaf = findTextLeaf(a, name);
      if (leaf) return { el: leaf, mode: leaf === a ? 'after' : 'append' };
    }
    return anchors.length ? { el: anchors[anchors.length - 1], mode: 'after' } : null;
  }

  function makeBadge(castId, r, prev, period) {
    const b = document.createElement('span');
    b.className = 'okr-badge';
    b.dataset.cast = castId;
    if (r) {
      b.classList.add(r.rank === 1 ? 'okr-gold' : r.rank === 2 ? 'okr-silver' : r.rank === 3 ? 'okr-bronze' : 'okr-in');
      b.appendChild(document.createTextNode(`沖縄 ${r.rank}位`));
    } else {
      b.classList.add('okr-out');
      b.appendChild(document.createTextNode('沖縄 圏外'));
    }
    let title = `カフェるん週間キャストランキング（沖縄・那覇）${period ? '\n' + period : ''}`;
    if (prev) {
      const pr = prev.ranks[castId];
      let txt = '';
      let cls = '';
      if (r && pr == null) { txt = 'NEW'; cls = 'okr-up'; }
      else if (r && pr > r.rank) { txt = `▲${pr - r.rank}`; cls = 'okr-up'; }
      else if (r && pr < r.rank) { txt = `▼${r.rank - pr}`; cls = 'okr-down'; }
      else if (r) { txt = '→'; }
      else if (pr != null) { txt = `前回${pr}位`; cls = 'okr-down'; }
      if (txt) {
        const d = document.createElement('span');
        d.className = `okr-diff ${cls}`;
        d.textContent = txt;
        b.appendChild(d);
      }
      title += `\n前回（${prev.period}）: ${pr != null ? pr + '位' : '圏外'}`;
    }
    b.title = title;
    return b;
  }

  function decorateByLinks(data, prev) {
    const okinawaShops = new Set(data.shopIds || []);
    const groups = collectCastGroups();
    let ranked = 0;
    let out = 0;
    groups.forEach((g, castId) => {
      const r = data.ranks[castId];
      const card = cardOf(g.anchors, castId);
      const isOkinawa = okinawaShops.has(g.shopId) || /沖縄/.test(textWithoutBadges(card));
      if (!r && !(CONFIG.showOutOfRank && isOkinawa)) return;
      if (r) ranked++; else out++;
      const t = pickTarget(g.anchors, r && r.name);
      if (!t || t.el.dataset.okrDone) return;
      const badge = makeBadge(castId, r, prev, data.period);
      if (t.mode === 'append') t.el.appendChild(badge);
      else t.el.insertAdjacentElement('afterend', badge);
      t.el.dataset.okrDone = '1';
    });
    return { total: groups.size, ranked, out };
  }

  // キャストページへのリンクが見つからない場合の保険：名前の完全一致（ランキング内で一意な名前のみ）
  function decorateByName(data, prev) {
    const count = {};
    Object.values(data.ranks).forEach((r) => { if (r.name) count[r.name] = (count[r.name] || 0) + 1; });
    const byName = {};
    Object.entries(data.ranks).forEach(([id, r]) => { if (r.name && count[r.name] === 1) byName[r.name] = { id, r }; });
    let n = 0;
    document.body.querySelectorAll('*').forEach((el) => {
      if (el.closest('.okr-badge, script, style, header, footer, nav')) return;
      if (el.dataset.okrDone) { n++; return; }
      const hit = byName[ownText(el)];
      if (!hit) return;
      const b = makeBadge(hit.id, hit.r, prev, data.period);
      b.classList.add('okr-guess');
      b.title += '\n※名前の一致による推定';
      el.appendChild(b);
      el.dataset.okrDone = '1';
      n++;
    });
    return n;
  }

  function run() {
    if (!current) return;
    const prev = getPrev(current.period);
    const s = decorateByLinks(current, prev);
    let guessed = 0;
    if (s.total === 0 && CONFIG.nameFallback) guessed = decorateByName(current, prev);
    console.log(TAG, s.total > 0
      ? `ランクイン ${s.ranked}人 / キープ ${s.total}人（沖縄の圏外 ${s.out}人）`
      : `名前一致で ${guessed}人に表示（推定）`);
  }

  /* ===================== 監視 ===================== */
  function observe() {
    let timer = null;
    const isOurs = (n) => n.nodeType === 1 && n.classList.contains('okr-badge');
    new MutationObserver((muts) => {
      if (!current) return;
      const relevant = muts.some((m) => {
        if (m.target.nodeType === 1 && m.target.closest('.okr-badge')) return false;
        return [...m.addedNodes].some((n) => !isOurs(n) && !(n.nodeType === 3 && !n.nodeValue.trim()));
      });
      if (!relevant) return;
      clearTimeout(timer);
      timer = setTimeout(run, 400);
    }).observe(document.body, { childList: true, subtree: true });
  }

  function injectStyle() {
    addStyle(`
      .okr-badge{display:inline-flex;align-items:center;gap:4px;margin:0 0 0 6px;padding:1px 8px;border-radius:999px;
        font-size:11px;font-weight:700;line-height:1.7;vertical-align:middle;white-space:nowrap;color:#fff;background:#e2589a;
        box-shadow:0 1px 2px rgba(0,0,0,.15);text-decoration:none;font-family:inherit}
      .okr-badge.okr-gold{background:linear-gradient(135deg,#ffe27a,#d9a400);color:#4a3500}
      .okr-badge.okr-silver{background:linear-gradient(135deg,#eef1f4,#9aa3ad);color:#222}
      .okr-badge.okr-bronze{background:linear-gradient(135deg,#f0b98a,#b8682f);color:#fff}
      .okr-badge.okr-out{background:#9aa0a6}
      .okr-badge.okr-guess{outline:1px dashed rgba(0,0,0,.35);outline-offset:1px}
      .okr-diff{font-size:10px;padding:0 5px;border-radius:999px;background:rgba(255,255,255,.9);color:#555}
      .okr-diff.okr-up{color:#d6336c}
      .okr-diff.okr-down{color:#1c7ed6}
    `);
  }

  /* ===================== 起動 ===================== */
  async function main() {
    injectStyle();
    try {
      current = await getRanking(false);
      run();
    } catch (e) {
      console.error(TAG, '取得に失敗しました', e);
    }
    observe();
  }

  main();
})();
