// ==UserScript==
// @name         カフェるん「カワいいね!」連続実行（実行→閉じる→次のタブ）
// @namespace    https://shop.caferun.jp/sunadai
// @version      0.4.0
// @description  /member/keep/cast/ に「実行」ボタンを表示。押すと「カワいいね!」ボタンだけを順に押して2秒後にタブを閉じ、次に表示されたタブでも自動で同じ処理を繰り返す。「カワいいね!」を検知できないタブに来たら停止
// @match        https://shop.caferun.jp/member/keep/cast/*
// @run-at       document-idle
// @grant        window.close
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_addValueChangeListener
// @grant        GM_registerMenuCommand
// @noframes
// @updateURL    https://raw.githubusercontent.com/Dai-Sunakawa/userscripts/main/kawaiine-renzoku.user.js
// @downloadURL  https://raw.githubusercontent.com/Dai-Sunakawa/userscripts/main/kawaiine-renzoku.user.js
// ==/UserScript==

(function () {
  'use strict';

  // ---- 設定 ----
  const CLOSE_DELAY_MS    = 2000;          // 最後のクリック後にタブを閉じるまでの待ち時間
  const CLICK_INTERVAL_MS = 300;           // 複数ボタンを押すときの間隔（同時送信を避ける）
  const FIND_TIMEOUT_MS   = 8000;          // 自動実行時、ボタンが描画されるのを待つ上限。超えたら「検知できず」として連続実行を停止
  const CHAIN_TTL_MS      = 5 * 60 * 1000; // 連続実行モードの有効期限（実行ボタンを押してから5分で自動解除）
  const RELOAD_GUARD_MS   = 60 * 1000;     // クリック直後にこのタブが再読み込みされた場合、再クリックせず閉じるだけにする猶予
  const CHAIN_KEY         = 'kawaiine_chain_started_at';   // タブ間で共有（Tampermonkey ストレージ）
  const RELOAD_KEY        = 'kawaiine_clicked_at';         // このタブだけ（sessionStorage）
  const RUNNER_ATTR       = 'data-kawaiine-runner';

  // ボタンの表示文字: 「カワいいね!」「かわいいね！」+ 任意でハート記号と件数、それ以外の文字が付くものは対象外
  // 例) 「カワいいね!♥208」→ 対象 / 「カワいいねランキング」「カワいいねを押すと…」→ 対象外
  const LABEL_RE = /^(カワ|かわ)いいね[!！]?[^\p{L}\p{N}]{0,3}[\d,]{0,8}$/u;

  // 「ボタンらしい要素」だけを候補にする（見出し・説明文・ナビの文字列は拾わない）
  const CLICKABLE_SELECTOR = [
    'button',
    'input[type="button"]',
    'input[type="submit"]',
    'a',
    '[role="button"]',
    '[onclick]',
    '[class*="btn"]',
    '[class*="button"]',
    '[class*="like"]',
    '[class*="iine"]',
    '[class*="kawaii"]',
  ].join(', ');

  // この中にある要素は押さない（サイトのヘッダー・ナビ・フッター）
  const EXCLUDE_ANCESTOR_SELECTOR = 'header, nav, footer, #header, #footer, .header, .footer, .gnav, .global-nav';

  const log = (...a) => console.log('[caferun-kawaiine]', ...a);

  function closeTab() {
    log('タブを閉じます');
    window.close();
  }

  // ---- 連続実行モード（タブ間で共有するフラグ）----
  function chainActive() {
    const t = Number(GM_getValue(CHAIN_KEY, 0));
    return t > 0 && Date.now() - t < CHAIN_TTL_MS;
  }
  function startChain() { GM_setValue(CHAIN_KEY, Date.now()); }
  function stopChain(reason) {
    GM_deleteValue(CHAIN_KEY);
    log('連続実行を停止:', reason);
  }

  // クリック直後にページ遷移/再読み込みが起きた場合は、再クリックせず閉じるだけ（同じタブ内での無限ループ防止）
  const lastClick = Number(sessionStorage.getItem(RELOAD_KEY) || 0);
  if (lastClick && Date.now() - lastClick < RELOAD_GUARD_MS) {
    sessionStorage.removeItem(RELOAD_KEY);
    log('クリック直後の再読み込み。再クリックせず閉じます');
    setTimeout(closeTab, CLOSE_DELAY_MS);
    return;
  }

  // ---- ボタン検出 ----
  function isVisible(el) {
    const r  = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
  }

  function isDisabled(el) {
    return el.disabled || el.getAttribute('aria-disabled') === 'true' || el.classList.contains('disabled');
  }

  function labelOf(el) {
    if (el instanceof HTMLInputElement) return (el.value || '').replace(/\s+/g, '');
    let text = (el.textContent || '').replace(/\s+/g, '');
    if (!text) {
      const img = el.querySelector('img[alt]');
      text = (el.getAttribute('aria-label') || el.getAttribute('title') || (img && img.alt) || '').replace(/\s+/g, '');
    }
    return text;
  }

  function findButtons() {
    const hits = [];
    for (const el of document.querySelectorAll(CLICKABLE_SELECTOR)) {
      if (el.closest(`[${RUNNER_ATTR}]`)) continue;          // 自分が追加した実行ボタンは対象外
      if (!LABEL_RE.test(labelOf(el))) continue;
      if (el.closest(EXCLUDE_ANCESTOR_SELECTOR)) continue;
      if (isDisabled(el) || !isVisible(el)) continue;
      hits.push(el);
    }
    // 親子関係にあるものは最も内側だけ残す（<a> の中の <span> など）
    return hits.filter(el => !hits.some(other => other !== el && el.contains(other)));
  }

  // ボタンが後から描画される場合に備えて、見つかるまで（上限あり）待つ
  function waitForButtons(timeoutMs) {
    return new Promise(resolve => {
      if (findButtons().length > 0) return resolve(true);
      const observer = new MutationObserver(() => {
        if (findButtons().length > 0) { observer.disconnect(); clearTimeout(timer); resolve(true); }
      });
      observer.observe(document.documentElement, { childList: true, subtree: true });
      const timer = setTimeout(() => { observer.disconnect(); resolve(findButtons().length > 0); }, timeoutMs);
    });
  }

  function clickTarget(el) {
    const clickable = el.closest('button, a, input, [role="button"], [onclick]') || el;
    clickable.click();
    return clickable;
  }

  // ---- 実行処理 ----
  let running = false;
  function run(opts) {
    const auto = !!(opts && opts.auto);
    if (running) return;
    const targets = findButtons();
    if (targets.length === 0) {
      if (auto || chainActive()) {
        stopChain('「カワいいね!」ボタンを検知できないタブに到達');
        setRunnerText('カワいいね! 未検知 → 連続実行を終了しました', true);
      } else {
        setRunnerText('カワいいね! ボタンが見つかりません', true);
      }
      log('「カワいいね!」ボタンが見つかりませんでした。このタブは閉じません');
      return;
    }
    running = true;
    if (!auto) startChain();                               // 実行ボタンから始めたときだけ連続実行モードを開始
    sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
    log(`${auto ? '自動' : '手動'}実行: 対象 ${targets.length} 件`, targets);
    setRunnerText(`実行中… 0/${targets.length}`, true);
    targets.forEach((b, i) => {
      setTimeout(() => {
        const t = clickTarget(b);
        log(`クリック ${i + 1}/${targets.length}:`, labelOf(t), t);
        setRunnerText(`実行中… ${i + 1}/${targets.length}`, true);
      }, i * CLICK_INTERVAL_MS);
    });
    const closeAt = (targets.length - 1) * CLICK_INTERVAL_MS + CLOSE_DELAY_MS;
    setTimeout(() => setRunnerText('完了。閉じて次のタブへ', true), closeAt - CLOSE_DELAY_MS);
    setTimeout(closeTab, closeAt);
  }

  // 連続実行モード中にこのタブが「表示状態」になったら自動実行（前のタブが閉じて、このタブが前面に来たとき）
  let autoTriggered = false;
  function maybeAutoRun(trigger) {
    if (autoTriggered || running) return;
    if (document.visibilityState !== 'visible') return;
    if (!chainActive()) return;
    autoTriggered = true;
    log('連続実行モード: 自動開始 (' + trigger + ')');
    setRunnerText('連続実行中… ボタンを検出しています', true);
    waitForButtons(FIND_TIMEOUT_MS).then(found => {
      if (found) run({ auto: true });
      else {
        stopChain('「カワいいね!」ボタンを検知できないタブに到達');
        setRunnerText('カワいいね! 未検知 → 連続実行を終了しました', true);
      }
    });
  }

  // ---- 画面左下の実行ボタン ----
  let runner = null;
  function setRunnerText(text, disabled) {
    if (!runner) return;
    runner.textContent = text;
    runner.disabled = !!disabled;
    runner.style.opacity = disabled ? '0.7' : '1';
    runner.style.cursor  = disabled ? 'default' : 'pointer';
  }

  function refreshRunnerCount() {
    if (!runner || running || autoTriggered || runner.disabled) return;
    const n = findButtons().length;
    setRunnerText(`▶ カワいいね! 実行（${n}件）→ 閉じて次のタブへ`, false);
  }

  function createRunner() {
    runner = document.createElement('button');
    runner.type = 'button';
    runner.setAttribute(RUNNER_ATTR, '1');
    runner.title = '「カワいいね!」ボタンを順に押して2秒後にこのタブを閉じ、次に表示されたタブでも繰り返します（検知できなくなったら停止）';
    Object.assign(runner.style, {
      position: 'fixed',
      left: '16px',
      bottom: '16px',
      zIndex: '2147483647',
      padding: '12px 18px',
      fontSize: '15px',
      fontWeight: 'bold',
      color: '#fff',
      background: '#e8609a',
      border: 'none',
      borderRadius: '999px',
      boxShadow: '0 3px 10px rgba(0,0,0,0.25)',
      cursor: 'pointer',
    });
    runner.addEventListener('click', () => run({ auto: false }));
    document.body.appendChild(runner);
    refreshRunnerCount();
    setInterval(refreshRunnerCount, 1000); // 一覧が後から描画された場合に件数を追従
  }

  function init() {
    createRunner();
    maybeAutoRun('load');
    document.addEventListener('visibilitychange', () => maybeAutoRun('visibilitychange'));
    window.addEventListener('focus', () => maybeAutoRun('focus'));
    // 他のタブで連続実行が開始/停止されたら表示を更新
    if (typeof GM_addValueChangeListener === 'function') {
      GM_addValueChangeListener(CHAIN_KEY, () => { if (!running && !autoTriggered) refreshRunnerCount(); });
    }
  }

  if (document.body) init();
  else document.addEventListener('DOMContentLoaded', init, { once: true });

  // Tampermonkey のアイコンメニュー
  if (typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand('カワいいね! を実行して閉じる（連続実行開始）', () => run({ auto: false }));
    GM_registerMenuCommand('連続実行を停止', () => {
      stopChain('メニューから停止');
      autoTriggered = false;
      if (!running) setRunnerText('連続実行を停止しました', true);
    });
  }
})();
