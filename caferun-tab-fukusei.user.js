// ==UserScript==
// @name         カフェるん タブ複製
// @namespace    https://shop.caferun.jp/sunadai
// @version      1.0.0
// @description  カフェるんのページを、決めたタブ数になるまで10タブずつ1分おきに複製して開きます。タブを開くだけで、ページ内のボタンは押しません
// @match        https://shop.caferun.jp/*
// @run-at       document-idle
// @grant        GM_openInTab
// @grant        GM.openInTab
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @noframes
// @homepageURL  https://github.com/Dai-Sunakawa/userscripts
// @updateURL    https://raw.githubusercontent.com/Dai-Sunakawa/userscripts/main/caferun-tab-fukusei.user.js
// @downloadURL  https://raw.githubusercontent.com/Dai-Sunakawa/userscripts/main/caferun-tab-fukusei.user.js
// ==/UserScript==

(function () {
  'use strict';

  // ---- 設定 ----
  const BATCH_SIZE     = 10;          // 1回に開くタブ数
  const BATCH_GAP_MS   = 60 * 1000;   // 回と回の間隔（前の回を始めてから1分）
  const OPEN_GAP_MS    = 400;         // 同じ回の中でタブを開く間隔（一度に開いて固まらないように）
  const MAX_TARGET     = 300;         // 目標タブ数の上限（入れすぎ防止）
  const DEFAULT_TARGET = 10;
  const ORIGIN         = 'https://shop.caferun.jp';
  const JOB_KEY        = 'kt3dup_job';          // このタブの sessionStorage（再読み込みしても続きから）
  const LAST_TARGET_KEY = 'kt3dup_last_target'; // 前回の目標タブ数

  const log = (...a) => console.log('[caferun-tab-fukusei]', ...a);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---- タブを開く（Tampermonkey の GM_openInTab、なければ GM.openInTab）----
  function getOpener() {
    if (typeof GM_openInTab === 'function') {
      return (url) => GM_openInTab(url, { active: false, insert: true });
    }
    if (typeof GM !== 'undefined' && GM && typeof GM.openInTab === 'function') {
      return (url) => GM.openInTab(url, true); // true = 裏で開く
    }
    return null;
  }
  const openTab = getOpener();

  // ---- 保存 ----
  function loadJob() {
    try { return JSON.parse(sessionStorage.getItem(JOB_KEY) || 'null'); } catch (e) { return null; }
  }
  function saveJob(job) {
    try { sessionStorage.setItem(JOB_KEY, JSON.stringify(job)); } catch (e) { /* 保存できなくても続ける */ }
  }
  function clearJob() {
    try { sessionStorage.removeItem(JOB_KEY); } catch (e) { /* noop */ }
  }
  function getLastTarget() {
    try {
      if (typeof GM_getValue === 'function') return Number(GM_getValue(LAST_TARGET_KEY, DEFAULT_TARGET)) || DEFAULT_TARGET;
      return Number(localStorage.getItem(LAST_TARGET_KEY)) || DEFAULT_TARGET;
    } catch (e) { return DEFAULT_TARGET; }
  }
  function setLastTarget(n) {
    try {
      if (typeof GM_setValue === 'function') GM_setValue(LAST_TARGET_KEY, n);
      else localStorage.setItem(LAST_TARGET_KEY, String(n));
    } catch (e) { /* noop */ }
  }

  // ---- 入力チェック ----
  function normalizeUrl(value) {
    try {
      const u = new URL(String(value || '').trim(), location.href);
      return u.origin === ORIGIN ? u.href : null; // カフェるん以外のページは複製しない
    } catch (e) { return null; }
  }
  function batchesFor(target) { return Math.ceil(target / BATCH_SIZE); }

  // ---- 複製の進行 ----
  let busy = false;
  let ticker = null;      // 1秒ごとの表示更新
  let wakeTimer = null;   // 次の回の時刻ちょうどに起こすタイマー
  let lastMessage = '';   // 完了・停止・エラーのお知らせ

  function startTicking() {
    if (!ticker) ticker = setInterval(tick, 1000);
  }
  function stopTicking() {
    if (ticker) { clearInterval(ticker); ticker = null; }
    if (wakeTimer) { clearTimeout(wakeTimer); wakeTimer = null; }
  }
  function scheduleWake(job) {
    if (wakeTimer) clearTimeout(wakeTimer);
    wakeTimer = setTimeout(() => { wakeTimer = null; tick(); }, Math.max(0, job.nextAt - Date.now()));
  }

  async function openBatch(job) {
    busy = true;
    try {
      const n = Math.min(BATCH_SIZE, job.target - job.opened);
      job.nextAt = Date.now() + BATCH_GAP_MS;   // 次の回は、この回を始めてから1分後
      job.round = (job.round || 0) + 1;
      saveJob(job);
      log(`${job.round}回目: ${n}タブ開きます（${job.opened}/${job.target}）`);
      for (let i = 0; i < n; i++) {
        const cur = loadJob();
        if (!cur || cur.id !== job.id) return;  // 途中で停止された
        openTab(cur.url);
        cur.opened += 1;
        saveJob(cur);
        job = cur;
        render();
        if (i < n - 1) await sleep(OPEN_GAP_MS);
      }
      if (job.opened >= job.target) finish(job);
      else scheduleWake(job);
    } catch (e) {
      log('タブを開けませんでした', e);
      clearJob();
      stopTicking();
      lastMessage = `タブを開けませんでした（${job.opened}/${job.target}で停止）`;
    } finally {
      busy = false;
      render();
    }
  }

  function finish(job) {
    clearJob();
    stopTicking();
    lastMessage = `完了：${job.target}タブ開きました`;
    log(lastMessage);
  }

  function tick() {
    const job = loadJob();
    if (!job) { stopTicking(); render(); return; }
    // 画面に出ているときだけ開く（ほかのタブやロック中に勝手に開かない。戻ってきたら続きから）
    if (!busy && document.visibilityState === 'visible' && Date.now() >= job.nextAt && job.opened < job.target) {
      openBatch(job);
    }
    render();
  }

  function start() {
    if (!openTab) {
      lastMessage = 'このアプリではタブを開けません（Tampermonkeyで入れてください）';
      render();
      return;
    }
    if (loadJob()) return; // 実行中
    const url = normalizeUrl(ui.url.value);
    if (!url) {
      lastMessage = 'カフェるん（shop.caferun.jp）のURLを入れてください';
      render();
      return;
    }
    const target = Math.floor(Number(ui.target.value));
    if (!(target >= 1 && target <= MAX_TARGET)) {
      lastMessage = `目標タブ数は1〜${MAX_TARGET}で入れてください`;
      render();
      return;
    }
    setLastTarget(target);
    lastMessage = '';
    const job = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
      url, target, opened: 0, round: 0, nextAt: 0, startedAt: Date.now(),
    };
    saveJob(job);
    startTicking();
    tick(); // 1回目はすぐ開く
  }

  function stop(reason) {
    const job = loadJob();
    clearJob();
    stopTicking();
    if (job) lastMessage = `停止しました（${job.opened}/${job.target}タブ）`;
    log('停止:', reason || '');
    render();
  }

  // ---- 画面（左下のボタンと設定パネル）----
  const ui = {};

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Hiragino Sans", sans-serif; }
    .pill {
      position: fixed; left: 12px; bottom: calc(16px + env(safe-area-inset-bottom, 0px)); z-index: 2147482995;
      padding: 10px 16px; border: none; border-radius: 999px; background: #e8609a; color: #fff;
      font-size: 14px; font-weight: 700; box-shadow: 0 3px 10px rgba(0,0,0,.25); cursor: pointer;
    }
    .pill.run { background: #c2185b; }
    .panel {
      position: fixed; left: 10px; bottom: calc(64px + env(safe-area-inset-bottom, 0px)); z-index: 2147482999;
      width: min(340px, calc(100vw - 20px)); padding: 14px; border-radius: 16px;
      background: #fff; color: #222; box-shadow: 0 8px 30px rgba(0,0,0,.3); display: none;
    }
    .panel.open { display: block; }
    .hd { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
    .hd b { font-size: 16px; }
    .x { border: none; background: transparent; font-size: 20px; color: #888; cursor: pointer; padding: 0 4px; }
    label { display: block; font-size: 12px; color: #666; margin: 8px 0 4px; }
    input { width: 100%; font-size: 16px; padding: 8px 10px; border: 1px solid #ccc; border-radius: 10px; color: #222; background: #fff; }
    input:disabled { background: #f3f3f3; color: #888; }
    .row { display: flex; align-items: center; gap: 8px; }
    .row input { width: 110px; }
    .row span { font-size: 14px; }
    .hint { font-size: 12px; color: #666; margin-top: 6px; line-height: 1.5; }
    .btn { width: 100%; margin-top: 12px; padding: 11px; border: none; border-radius: 12px; font-size: 15px; font-weight: 700; color: #fff; cursor: pointer; }
    .go { background: #e8609a; }
    .stop { background: #555; }
    .bar { height: 8px; border-radius: 4px; background: #eee; overflow: hidden; margin-top: 10px; }
    .bar i { display: block; height: 100%; width: 0; background: #e8609a; transition: width .3s; }
    .st { font-size: 14px; margin-top: 8px; line-height: 1.5; }
    .msg { font-size: 13px; margin-top: 8px; color: #c2185b; min-height: 1em; }
    .v { font-size: 10px; color: #aaa; margin-top: 8px; text-align: right; }
  `;

  function buildUI() {
    const host = document.createElement('div');
    host.setAttribute('data-kt3dup', '1');
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>${CSS}</style>
      <button class="pill" type="button">⧉ タブ複製</button>
      <div class="panel" role="dialog" aria-label="タブ複製">
        <div class="hd"><b>タブ複製</b><button class="x" type="button" aria-label="閉じる">×</button></div>
        <label>複製するページ</label>
        <input class="url" type="url" inputmode="url" autocomplete="off">
        <label>目標タブ数（新しく開く数）</label>
        <div class="row"><input class="target" type="number" min="1" max="${MAX_TARGET}" step="1" inputmode="numeric"><span>タブ</span></div>
        <div class="hint plan"></div>
        <button class="btn go" type="button">開始</button>
        <button class="btn stop" type="button" style="display:none">停止</button>
        <div class="bar"><i></i></div>
        <div class="st"></div>
        <div class="msg"></div>
        <div class="hint">画面がロックされたり、ほかのタブに移ったりすると一時停止します。このタブに戻ると続きから開きます。</div>
        <div class="v">v${(typeof GM_info !== 'undefined' && GM_info.script && GM_info.script.version) || ''}</div>
      </div>`;
    document.body.appendChild(host);
    const $ = (s) => root.querySelector(s);
    Object.assign(ui, {
      host, pill: $('.pill'), panel: $('.panel'), close: $('.x'), url: $('.url'), target: $('.target'),
      plan: $('.plan'), go: $('.go'), stop: $('.stop'), bar: $('.bar i'), st: $('.st'), msg: $('.msg'),
    });
    ui.url.value = location.href;
    ui.target.value = String(getLastTarget());
    ui.pill.addEventListener('click', () => { ui.panel.classList.toggle('open'); render(); });
    ui.close.addEventListener('click', () => { ui.panel.classList.remove('open'); render(); });
    ui.go.addEventListener('click', start);
    ui.stop.addEventListener('click', () => stop('停止ボタン'));
    ui.target.addEventListener('input', render);
  }

  function fmtLeft(ms) {
    const s = Math.max(0, Math.ceil(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  function render() {
    if (!ui.pill) return;
    const job = loadJob();
    const running = !!job;

    ui.pill.textContent = running ? `⧉ ${job.opened}/${job.target}` : '⧉ タブ複製';
    ui.pill.classList.toggle('run', running);
    ui.url.disabled = running;
    ui.target.disabled = running;
    ui.go.style.display = running ? 'none' : '';
    ui.stop.style.display = running ? '' : 'none';

    const t = running ? job.target : Math.floor(Number(ui.target.value));
    if (t >= 1 && t <= MAX_TARGET) {
      const b = batchesFor(t);
      ui.plan.textContent = `${BATCH_SIZE}タブずつ・1分おき → 全部で${b}回・約${b - 1}分`;
    } else {
      ui.plan.textContent = `1〜${MAX_TARGET}で入れてください`;
    }

    if (running) {
      ui.bar.style.width = `${Math.round((job.opened / job.target) * 100)}%`;
      let line = `${job.opened} / ${job.target} タブ開きました`;
      if (busy) line += '（開いています…）';
      else if (job.opened < job.target) {
        line += document.visibilityState === 'visible'
          ? `／次の${Math.min(BATCH_SIZE, job.target - job.opened)}タブまで ${fmtLeft(job.nextAt - Date.now())}`
          : '／一時停止中';
      }
      ui.st.textContent = line;
    } else {
      ui.bar.style.width = '0';
      ui.st.textContent = '';
    }
    ui.msg.textContent = lastMessage;
  }

  // ---- 起動 ----
  function init() {
    buildUI();
    const resumed = loadJob();
    if (resumed) {             // 再読み込み前の続き
      ui.panel.classList.add('open');
      startTicking();
      scheduleWake(resumed);
      tick();
    }
    render();
    document.addEventListener('visibilitychange', () => { if (loadJob()) tick(); else render(); });
  }

  if (document.body) init();
  else document.addEventListener('DOMContentLoaded', init, { once: true });

  // Tampermonkey のアイコンメニュー
  if (typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand('タブ複製パネルを開く', () => { if (ui.panel) { ui.panel.classList.add('open'); render(); } });
    GM_registerMenuCommand('複製を停止', () => stop('メニュー'));
  }
})();
