// Shopee Coins Daily Check-in (shopee.tw) - background service worker.
//
// Two "rounds" of attempts, each with up to MAX_TRIES automatic tries; once today's check-in succeeds, everything stops.
//   Midnight round: one attempt at 00:02, then a retry every hour if it did not succeed.
//   Startup round : every time Chrome starts (the optional boot launcher can open Chrome at sign-in), the counter
//                   is reset, it tries right away and then retries every hour.
// If Shopee has logged you out, it tries to log back in with your Google account. It only picks the account and
// presses "Continue" - it never types a password and stops at 2-step verification or robot checks.
// "Checked in today?" is written to shopee_checkin.json so the boot launcher can skip opening Chrome.

const COINS_URL = 'https://shopee.tw/shopee-coins';
const LOGIN_URL = 'https://shopee.tw/buyer/login?next=' + encodeURIComponent(COINS_URL);
const MAX_TRIES = 3;
const LOG_LIMIT = 30;
const LOCK_MS = 300000; // one run (including an automatic re-login) takes about 3 minutes at most; lock for 5 minutes

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function today() {
  // sv-SE formats as YYYY-MM-DD, in the computer's local time zone
  return new Date().toLocaleDateString('sv-SE');
}

function nowText() {
  return new Date().toLocaleString('sv-SE', { hour12: false });
}

// Logged out: the login page, or Shopee's "Login Required" page (/verify/traffic/error?...is_logged_in=false)
function isLoginUrl(url) {
  url = url || '';
  return /\/buyer\/login/.test(url) || (/\/verify\/traffic\/error/.test(url) && /[?&]is_logged_in=false/.test(url));
}

// Shopee wants a human check (puzzle, SMS, etc.) - we never try to solve these
function isVerifyUrl(url) {
  return /\/verify\//.test(url || '') && !isLoginUrl(url);
}

// Timestamp of the next 00:02 (local time)
function nextDailyTime() {
  const t = new Date();
  t.setHours(0, 2, 0, 0);
  if (t.getTime() <= Date.now()) t.setDate(t.getDate() + 1);
  return t.getTime();
}

function setupAlarm() {
  // Fixed daily check-in at 00:02
  chrome.alarms.create('shopee-daily', { when: nextDailyTime(), periodInMinutes: 1440 });
  // Retry: if the 00:02 attempt failed or Chrome was closed at that time, check again every hour
  chrome.alarms.create('shopee-check', { delayInMinutes: 1, periodInMinutes: 60 });
}

// Between 00:00 and 00:02 Shopee may not have switched to the new day yet and still shows yesterday's
// "come back tomorrow", so do nothing in that window
function tooEarly() {
  const n = new Date();
  return n.getHours() === 0 && n.getMinutes() < 2;
}

chrome.runtime.onInstalled.addListener(() => {
  setupAlarm();
  refreshBadge();
  writeStatus(true);
});

chrome.runtime.onStartup.addListener(async () => {
  setupAlarm();
  // Startup round: every Chrome start gets MAX_TRIES fresh attempts
  const d = today();
  const s = await chrome.storage.local.get(['lastDone']);
  if (s.lastDone !== d) await chrome.storage.local.set({ triesDate: d, tries: 0 });
  refreshBadge();
  writeStatus(false);
  maybeRun(false);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'shopee-daily' || alarm.name === 'shopee-check') maybeRun(false);
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.cmd === 'run') {
    maybeRun(true).then(() => sendResponse({ ok: true }));
    return true;
  }
});

async function maybeRun(force) {
  const d = today();
  const s = await chrome.storage.local.get(['lastDone', 'triesDate', 'tries', 'runningSince']);

  if (!force && s.lastDone === d) return;
  if (!force && tooEarly()) return;

  const tries = s.triesDate === d ? (s.tries || 0) : 0;
  if (!force && tries >= MAX_TRIES) return;

  // Avoid opening two tabs at once (treated as still running within LOCK_MS)
  if (s.runningSince && Date.now() - s.runningSince < LOCK_MS) return;

  await chrome.storage.local.set({ triesDate: d, tries: tries + 1, runningSince: Date.now() });
  try {
    await run();
  } finally {
    await chrome.storage.local.set({ runningSince: 0 });
  }
}

async function run() {
  let tabId = null;
  let ownWindowId = null;
  try {
    // If there is no Chrome window at all (e.g. Chrome is still starting), open a minimized window for the coins page
    const wins = await chrome.windows.getAll({ windowTypes: ['normal'] });
    if (wins.length === 0) {
      const w = await chrome.windows.create({ url: COINS_URL, state: 'minimized', focused: false });
      ownWindowId = w.id;
      tabId = w.tabs[0].id;
    } else {
      const tab = await chrome.tabs.create({ url: COINS_URL, active: false });
      tabId = tab.id;
    }

    const ok = await waitComplete(tabId, 30000);
    if (!ok) {
      await record({ status: 'timeout', text: 'The page did not finish loading in 30 seconds' });
      return;
    }

    // At most two passes: first pass finds we are logged out -> log in with Google -> back to the coins page and check in
    let relogged = false;
    for (;;) {
      const t = await chrome.tabs.get(tabId);
      if (isVerifyUrl(t.url)) {
        await record({ status: 'verify', text: '' });
        return;
      }

      let result;
      if (isLoginUrl(t.url)) {
        result = { status: 'login', text: '' };
      } else {
        const [res] = await chrome.scripting.executeScript({ target: { tabId }, func: checkIn });
        result = res && res.result ? res.result : { status: 'error', text: 'No result returned' };
      }

      // Logged out (the coins page usually stays where it is and shows "log in to get coins" instead of redirecting)
      if (result.status === 'login' && !relogged) {
        relogged = true;
        if (!/\/buyer\/login/.test(t.url || '')) {
          await chrome.tabs.update(tabId, { url: LOGIN_URL });
          if (!(await waitComplete(tabId, 30000))) {
            await record({ status: 'timeout', text: 'The login page did not finish loading in 30 seconds' });
            return;
          }
        }
        const login = await googleRelogin(tabId);
        await record(login);
        if (login.status !== 'relogin') return;

        await chrome.tabs.update(tabId, { url: COINS_URL });
        if (!(await waitComplete(tabId, 30000))) {
          await record({ status: 'timeout', text: 'After logging in, the page did not finish loading in 30 seconds' });
          return;
        }
        continue;
      }

      if (result.status === 'login' && relogged) result.text = 'Still shows as logged out after logging in';
      await record(result);
      return;
    }
  } catch (e) {
    await record({ status: 'error', text: String(e && e.message ? e.message : e) });
  } finally {
    if (ownWindowId !== null) {
      try { await chrome.windows.remove(ownWindowId); } catch (_) {}
    } else if (tabId !== null) {
      try { await chrome.tabs.remove(tabId); } catch (_) {}
    }
  }
}

function waitComplete(tabId, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(false);
    }, timeoutMs);

    function listener(id, info) {
      if (id === tabId && info.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve(true);
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

// ---------- Log back in with Google ----------
// Shopee's flow: login page "Google" button -> an accounts.google.com popup -> choose account -> "Continue"
// -> the popup closes and Shopee is logged in.
// Only "choose account" and "Continue" are automated. Password, 2-step verification and robot checks always stop here
// so the user can handle them.
async function googleRelogin(shopeeTabId) {
  const cfg = await chrome.storage.local.get(['autoLogin', 'googleEmail']);
  if (cfg.autoLogin === false) return { status: 'login', text: 'Automatic re-login is turned off' };

  // The "Google" button is clicked by script, so Chrome would block Shopee's popup as "no user gesture";
  // allow popups for shopee.tw first
  try {
    await chrome.contentSettings.popups.set({ primaryPattern: 'https://shopee.tw/*', setting: 'allow' });
  } catch (_) {}

  const before = new Set((await chrome.tabs.query({ url: 'https://accounts.google.com/*' })).map((x) => x.id));

  const [r] = await chrome.scripting.executeScript({ target: { tabId: shopeeTabId }, func: clickGoogleButton });
  if (!r || !r.result) return { status: 'relogin-fail', text: 'No Google button on the login page (the site may have changed)' };

  let googleTabId = null;
  let closedAt = 0;
  let lastState = '';
  const deadline = Date.now() + 90000;

  while (Date.now() < deadline) {
    await sleep(1500);

    // The Shopee tab left the login page = logged in
    let shopee;
    try {
      shopee = await chrome.tabs.get(shopeeTabId);
    } catch (_) {
      return { status: 'relogin-fail', text: 'The Shopee tab was closed' };
    }
    if (!/\/buyer\/login/.test(shopee.url || '')) {
      await closeTab(googleTabId);
      if (isVerifyUrl(shopee.url)) return { status: 'verify', text: 'Shopee asked for verification after the Google login' };
      return { status: 'relogin', text: '' };
    }

    // Find the Google popup Shopee opened (prefer openerTabId, otherwise a Google tab that appeared after the click)
    if (googleTabId === null) {
      if (closedAt && Date.now() - closedAt > 20000) break;
      const tabs = (await chrome.tabs.query({ url: 'https://accounts.google.com/*' })).filter((x) => !before.has(x.id));
      const g = tabs.find((x) => x.openerTabId === shopeeTabId) || tabs[0];
      if (g) googleTabId = g.id;
      continue;
    }

    let g;
    try {
      g = await chrome.tabs.get(googleTabId);
    } catch (_) {
      // The popup closed by itself (usually login finished); wait for the Shopee tab to move on
      googleTabId = null;
      closedAt = Date.now();
      continue;
    }
    if (g.status !== 'complete' || !/^https:\/\/accounts\.google\.com\//.test(g.url || '')) continue;

    let res;
    try {
      [res] = await chrome.scripting.executeScript({ target: { tabId: googleTabId }, func: googleStep, args: [cfg.googleEmail || ''] });
    } catch (_) {
      continue; // the page is navigating
    }
    const st = res && res.result ? res.result : { state: 'wait' };
    if (st.state === 'manual') {
      await closeTab(googleTabId);
      return { status: 'google-manual', text: st.text || '' };
    }
    if (st.state !== 'wait') lastState = st.state;
  }

  await closeTab(googleTabId);
  return { status: 'relogin-fail', text: lastState ? 'Last step: ' + lastState : 'The Google login popup never appeared' };
}

async function closeTab(tabId) {
  if (tabId === null || tabId === undefined) return;
  try { await chrome.tabs.remove(tabId); } catch (_) {}
}

// Injected into Shopee's login page: click the "Google" login button (must not use outside variables)
async function clickGoogleButton() {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const b = Array.from(document.querySelectorAll('button, [role="button"]'))
      .find((e) => e.offsetParent !== null && (e.innerText || '').trim() === 'Google');
    if (b) {
      b.click();
      return true;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

// Injected into the Google popup: does one step per call and returns the state (must not use outside variables)
// account = picked an account; continue = pressed Continue; wait = still loading or just clicked; manual = user must handle it
function googleStep(email) {
  const visible = (el) => !!el && el.offsetParent !== null;
  const textOf = (el) => (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
  const root = document.documentElement;

  // Do not click the same page again within 6 seconds
  if (root.dataset.shopeeAuto && Date.now() - Number(root.dataset.shopeeAuto) < 6000) return { state: 'wait' };
  const mark = () => { root.dataset.shopeeAuto = String(Date.now()); };

  // Password, identity check or robot check -> never automated
  if (Array.from(document.querySelectorAll('input[type="password"]')).some(visible) || /\/challenge\//.test(location.pathname)) {
    return { state: 'manual', text: 'Google asks for a password or identity verification' };
  }
  if (document.querySelector('iframe[src*="recaptcha"], iframe[title*="reCAPTCHA"]')) {
    return { state: 'manual', text: 'Google shows a robot check' };
  }
  if (Array.from(document.querySelectorAll('input[type="email"]')).some(visible)) {
    return { state: 'manual', text: 'This Chrome is not signed in to a Google account' };
  }

  // Choose-an-account page
  const accounts = Array.from(document.querySelectorAll('[data-identifier], [data-email]')).filter(visible);
  if (accounts.length) {
    const idOf = (el) => (el.getAttribute('data-identifier') || el.getAttribute('data-email') || '').trim().toLowerCase();
    const want = (email || '').trim().toLowerCase();
    let pick = null;
    if (want) {
      pick = accounts.find((el) => idOf(el) === want) || null;
      if (!pick) return { state: 'manual', text: 'The account chooser does not list ' + want };
    } else {
      const ids = new Set(accounts.map(idOf).filter(Boolean));
      if (ids.size !== 1) return { state: 'manual', text: 'Several Google accounts found - enter the one to use in the extension popup' };
      pick = accounts[0];
    }
    mark();
    pick.click();
    return { state: 'account' };
  }

  // "Sign in to Shopee with Google" confirmation page
  const okRe = /^(Continue|Allow|繼續|继续|允許|允许)$/i;
  const btn = Array.from(document.querySelectorAll('button, [role="button"]')).find((el) => visible(el) && okRe.test(textOf(el)));
  if (btn) {
    mark();
    btn.click();
    return { state: 'continue' };
  }
  return { state: 'wait' };
}

// Injected into the Shopee coins page (must not use outside variables).
// The check-in widget on shopee.tw shows Traditional Chinese text even when the site language is English,
// so Chinese is matched first; English is a fallback in case Shopee translates it later.
async function checkIn() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const coinRe = /蝦幣|coins?\b/i;
  const doneRe = /明天|明日|已簽到|已領取|tomorrow|checked[ -]?in|already claimed/i;
  const actRe = /簽到|領取|check[ -]?in|claim/i;

  function findCoinText() {
    const nodes = Array.from(document.querySelectorAll('button, [role="button"], div, span'));
    const hits = [];
    for (const el of nodes) {
      if (el.offsetParent === null) continue;
      const t = (el.innerText || '').replace(/\s+/g, ' ').trim();
      if (t.length === 0 || t.length > 40) continue;
      if (!coinRe.test(t)) continue;
      if (!doneRe.test(t) && !actRe.test(t)) continue;
      // Skip links to other pages (e.g. the "check in for coins" game icons below); the check-in button is not a link
      const link = el.closest('a[href]');
      if (link && !/^(#|javascript:)/.test(link.getAttribute('href') || '')) continue;
      hits.push({ el, t });
    }
    // The shortest text is usually the innermost button
    hits.sort((a, b) => a.t.length - b.t.length);
    return hits[0] || null;
  }

  // When logged out the coins page does not redirect; it shows a "log in to get coins" button instead
  function loggedOut() {
    return Array.from(document.querySelectorAll('button, [role="button"]')).some((el) => {
      if (el.offsetParent === null) return false;
      const t = (el.innerText || '').replace(/\s+/g, ' ').trim();
      return /登入以(獲得|領取|獲取)蝦幣/.test(t.replace(/\s/g, '')) || /^log ?in to (get|earn|claim|receive)\b.*coins?/i.test(t);
    });
  }

  function clickable(el) {
    let cur = el;
    for (let i = 0; i < 6 && cur; i++) {
      if (cur.tagName === 'BUTTON' || cur.getAttribute('role') === 'button') return cur;
      if (getComputedStyle(cur).cursor === 'pointer') return cur;
      cur = cur.parentElement;
    }
    return el;
  }

  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    if (/\/buyer\/login/.test(location.pathname)) return { status: 'login', text: '' };
    if (loggedOut()) return { status: 'login', text: 'The page shows "log in to get coins"' };

    const hit = findCoinText();
    if (hit) {
      if (doneRe.test(hit.t)) return { status: 'already', text: hit.t };

      clickable(hit.el).click();
      await sleep(3000);

      const after = findCoinText();
      if (after && doneRe.test(after.t)) return { status: 'done', text: after.t };
      return { status: 'clicked', text: hit.t };
    }
    await sleep(1000);
  }
  return { status: 'notfound', text: '' };
}

async function record(result) {
  const d = today();
  const s = await chrome.storage.local.get(['log', 'lastDone']);
  const log = s.log || [];
  log.unshift({ time: nowText(), status: result.status, text: result.text || '' });
  const update = { log: log.slice(0, LOG_LIMIT), lastStatus: result.status };
  if (result.status === 'done' || result.status === 'already') update.lastDone = d;
  await chrome.storage.local.set(update);
  await refreshBadge();
  await writeStatus(false);
}

async function refreshBadge() {
  const s = await chrome.storage.local.get(['lastDone', 'lastStatus']);
  if (s.lastDone === today()) {
    await chrome.action.setBadgeText({ text: '✓' });
    await chrome.action.setBadgeBackgroundColor({ color: '#2e7d32' });
  } else if (s.lastStatus && s.lastStatus !== 'done' && s.lastStatus !== 'already') {
    await chrome.action.setBadgeText({ text: '!' });
    await chrome.action.setBadgeBackgroundColor({ color: '#c62828' });
  } else {
    await chrome.action.setBadgeText({ text: '' });
  }
}

// ---------- Status file (read by the optional boot launcher) ----------
// Saved with chrome.downloads into a folder under Chrome's download folder ("statusDir" in status_config.json).
// The download bar is turned off while saving and the entry is removed from the download history afterwards,
// so no download prompt appears (the file itself stays). Nothing is written when the content has not changed.
const STATUS_NAME = 'shopee_checkin.json';
const DEFAULT_STATUS_DIR = 'ChromeExtensionStatus';

async function statusPath() {
  try {
    const j = await (await fetch(chrome.runtime.getURL('status_config.json'))).json();
    const d = String(j.statusDir || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    if (d && !d.split('/').includes('..') && !/^[a-z]:/i.test(d)) return d + '/' + STATUS_NAME;
  } catch (_) {}
  return DEFAULT_STATUS_DIR + '/' + STATUS_NAME;
}

async function writeStatus(force) {
  try {
    const s = await chrome.storage.local.get(['lastDone', 'statusWritten']);
    const obj = { lastDone: s.lastDone || '' };
    const path = await statusPath();
    const key = path + JSON.stringify(obj);
    if (!force && s.statusWritten === key) return;
    obj.updated = nowText();
    if (await saveJsonFile(path, obj)) await chrome.storage.local.set({ statusWritten: key });
  } catch (e) {
    console.warn('Could not write the status file', e);
  }
}

async function saveJsonFile(path, obj) {
  const url = 'data:application/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(obj, null, 2));
  let id = null;
  try {
    try { await chrome.downloads.setUiOptions({ enabled: false }); } catch (_) {}
    id = await chrome.downloads.download({ url, filename: path, conflictAction: 'overwrite', saveAs: false });
    return await waitDownload(id, 15000);
  } catch (e) {
    console.warn('Save failed', e);
    return false;
  } finally {
    if (id !== null) { try { await chrome.downloads.erase({ id }); } catch (_) {} }
    try { await chrome.downloads.setUiOptions({ enabled: true }); } catch (_) {}
  }
}

function waitDownload(id, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      chrome.downloads.onChanged.removeListener(listener);
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    function listener(d) {
      if (d.id === id && d.state) {
        if (d.state.current === 'complete') finish(true);
        if (d.state.current === 'interrupted') finish(false);
      }
    }
    chrome.downloads.onChanged.addListener(listener);
    chrome.downloads.search({ id }).then(([it]) => {
      if (it && it.state === 'complete') finish(true);
      if (it && it.state === 'interrupted') finish(false);
    });
  });
}
