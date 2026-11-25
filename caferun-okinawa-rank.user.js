// ==UserScript==
// @name         カフェるん キープ一覧に沖縄キャストランキングを表示
// @namespace    https://shop.caferun.jp/
// @version      1.0.0
// @description  キープ中キャスト一覧の名前横に、カフェるん週間キャストランキング（沖縄・那覇）の順位と前回比を表示します
// @match        https://shop.caferun.jp/member/keep/cast*
// @match        https://shop.caferun.jp/keep/cast*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addStyle
// @run-at       document-idle
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
    const cache = GM_getValue(KEY_CACHE, null);
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
    GM_setValue(KEY_CACHE, data);
    saveHistory(period, ranks);
    console.log(TAG, `取得: ${period} / ${Object.keys(ranks).length}人`);
    return data;
  }

  /* ===================== 前回比（週ごとの履歴） ===================== */
  function saveHistory(period, ranks) {
    if (!period) return;
    let hist = GM_getValue(KEY_HIST, []);
    if (!Array.isArray(hist)) hist = [];
    const slim = {};
    Object.entries(ranks).forEach(([id, r]) => { slim[id] = r.rank; });
    const i = hist.findIndex((h) => h.period === period);
    if (i >= 0) hist[i].ranks = slim; else hist.push({ period, ranks: slim });
    GM_setValue(KEY_HIST, hist.slice(-CONFIG.historyWeeks));
  }

  function getPrev(period) {
    const hist = GM_getValue(KEY_HIST, []);
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
      if (a.closest('.okr-panel')) return;
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
      if (el.closest('.okr-panel, .okr-badge, script, style, header, footer, nav')) return;
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

    const fetched = new Date(current.fetchedAt);
    const hhmm = `${fetched.getMonth() + 1}/${fetched.getDate()} ${String(fetched.getHours()).padStart(2, '0')}:${String(fetched.getMinutes()).padStart(2, '0')}`;
    const lines = [];
    lines.push(`<div>${escapeHtml(current.period || '期間不明')}</div>`);
    if (s.total > 0) {
      lines.push(`<div>ランクイン <b>${s.ranked}</b>人 / キープ <b>${s.total}</b>人${CONFIG.showOutOfRank ? `（沖縄の圏外 ${s.out}人）` : ''}</div>`);
    } else if (guessed > 0) {
      lines.push(`<div>名前一致で <b>${guessed}</b>人に表示（推定）</div>`);
    } else {
      lines.push('<div class="okr-warn">このページでキャストを見つけられませんでした</div>');
    }
    lines.push(`<div class="okr-sub">${prev ? `前回比: ${escapeHtml(prev.period)} と比較` : '前回比: 来週以降に表示'}</div>`);
    lines.push(`<div class="okr-sub">取得 ${hhmm}</div>`);
    setPanel(lines.join(''));
  }

  /* ===================== パネル・監視 ===================== */
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function createPanel() {
    const p = document.createElement('div');
    p.className = 'okr-panel';
    p.innerHTML =
      '<div class="okr-head"><b>沖縄キャストランキング</b><button type="button" class="okr-x" title="閉じる">×</button></div>' +
      '<div class="okr-body">読み込み中…</div>' +
      `<div class="okr-actions"><button type="button" class="okr-refresh">再取得</button><a href="${CONFIG.castRankingUrl}" target="_blank" rel="noopener">ランキングを開く</a></div>`;
    p.querySelector('.okr-x').addEventListener('click', () => p.remove());
    p.querySelector('.okr-refresh').addEventListener('click', refresh);
    document.body.appendChild(p);
  }

  function setPanel(html) {
    const body = document.querySelector('.okr-panel .okr-body');
    if (body) body.innerHTML = html;
  }

  function showError(e) {
    console.error(TAG, e);
    setPanel(`<div class="okr-warn">取得に失敗しました</div><div class="okr-sub">${escapeHtml(e && e.message ? e.message : e)}</div>`);
  }

  async function refresh() {
    setPanel('再取得中…');
    document.querySelectorAll('.okr-badge').forEach((b) => b.remove());
    document.querySelectorAll('[data-okr-done]').forEach((el) => { delete el.dataset.okrDone; });
    try {
      current = await getRanking(true);
      run();
    } catch (e) {
      showError(e);
    }
  }

  function observe() {
    let timer = null;
    const isOurs = (n) => n.nodeType === 1 && (n.classList.contains('okr-badge') || n.classList.contains('okr-panel'));
    new MutationObserver((muts) => {
      if (!current) return;
      const relevant = muts.some((m) => {
        if (m.target.nodeType === 1 && m.target.closest('.okr-panel, .okr-badge')) return false;
        return [...m.addedNodes].some((n) => !isOurs(n) && !(n.nodeType === 3 && !n.nodeValue.trim()));
      });
      if (!relevant) return;
      clearTimeout(timer);
      timer = setTimeout(run, 400);
    }).observe(document.body, { childList: true, subtree: true });
  }

  function injectStyle() {
    GM_addStyle(`
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
      .okr-panel{position:fixed;right:12px;bottom:12px;z-index:2147483000;width:230px;padding:8px 10px;border-radius:10px;
        background:rgba(255,255,255,.97);color:#333;border:1px solid #f0b3cf;box-shadow:0 4px 14px rgba(0,0,0,.18);
        font-size:12px;line-height:1.55;font-family:-apple-system,BlinkMacSystemFont,"Hiragino Sans",sans-serif}
      .okr-panel .okr-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;color:#c2185b}
      .okr-panel .okr-x{border:none;background:none;font-size:16px;line-height:1;cursor:pointer;color:#999;padding:0 2px}
      .okr-panel .okr-sub{color:#888;font-size:11px}
      .okr-panel .okr-warn{color:#c92a2a;font-weight:700}
      .okr-panel .okr-actions{display:flex;gap:8px;align-items:center;margin-top:6px}
      .okr-panel .okr-refresh{border:1px solid #e2589a;background:#fff;color:#e2589a;border-radius:6px;padding:2px 8px;cursor:pointer;font-size:12px}
      .okr-panel .okr-actions a{color:#e2589a;font-size:11px}
    `);
  }

  /* ===================== 起動 ===================== */
  async function main() {
    injectStyle();
    createPanel();
    try {
      current = await getRanking(false);
      run();
    } catch (e) {
      showError(e);
    }
    observe();
  }

  main();
})();
