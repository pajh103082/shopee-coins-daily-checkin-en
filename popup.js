const LABEL = {
  done: 'Checked in',
  already: 'Already checked in today',
  clicked: 'Clicked check-in but could not confirm it (will look again next hour)',
  login: 'You need to log in to Shopee',
  relogin: 'Logged back in to Shopee with Google',
  'relogin-fail': 'Could not log back in with Google - please log in to Shopee once yourself',
  'google-manual': 'Google needs you - please log in to Shopee once yourself',
  verify: 'Shopee asks for verification - open the coins page and handle it yourself',
  notfound: 'Check-in button not found (the site may have changed)',
  timeout: 'Page load timed out',
  error: 'Error'
};

function today() {
  return new Date().toLocaleDateString('sv-SE');
}

async function render() {
  const s = await chrome.storage.local.get(['lastDone', 'log']);
  document.getElementById('today').textContent =
    s.lastDone === today() ? 'Today: done ✓' : 'Today: not checked in yet';

  const ul = document.getElementById('log');
  ul.innerHTML = '';
  for (const item of (s.log || []).slice(0, 10)) {
    const li = document.createElement('li');
    const t = document.createElement('div');
    t.className = 't';
    t.textContent = item.time;
    const m = document.createElement('div');
    m.textContent = (LABEL[item.status] || item.status) + (item.text ? ': ' + item.text : '');
    li.append(t, m);
    ul.append(li);
  }
}

document.getElementById('run').addEventListener('click', async () => {
  const btn = document.getElementById('run');
  btn.disabled = true;
  btn.textContent = 'Checking in…';
  await chrome.runtime.sendMessage({ cmd: 'run' });
  btn.disabled = false;
  btn.textContent = 'Check in now';
  render();
});

const SPONSOR_URL = 'https://ko-fi.com/sagiriben';

document.getElementById('sponsorBtn').addEventListener('click', () => {
  chrome.tabs.create({ url: SPONSOR_URL });
  window.close();
});

async function loadSettings() {
  const s = await chrome.storage.local.get(['autoLogin', 'googleEmail']);
  document.getElementById('autoLogin').checked = s.autoLogin !== false;
  document.getElementById('googleEmail').value = s.googleEmail || '';
}

document.getElementById('autoLogin').addEventListener('change', (e) => {
  chrome.storage.local.set({ autoLogin: e.target.checked });
});
document.getElementById('googleEmail').addEventListener('input', (e) => {
  chrome.storage.local.set({ googleEmail: e.target.value.trim() });
});

loadSettings();
render();
