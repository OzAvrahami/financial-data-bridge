/**
 * Renderer logic. Runs sandboxed — no Node, no secrets. Talks to the main
 * process only through the small `window.bridge` API exposed by preload.cjs.
 *
 * Fetch actions are mocked in this step (log lines only); no real automation.
 */

const $ = (id) => document.getElementById(id);

function log(message) {
  const time = new Date().toLocaleTimeString();
  const line = document.createElement('div');
  line.innerHTML = `<span class="line-time">[${time}]</span> ${escapeHtml(message)}`;
  const el = $('log');
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function setStatus(text, ready) {
  $('status-text').textContent = text;
  $('status-dot').classList.toggle('ready', !!ready);
}

function setLastRunSummary(html) {
  $('summary-body').innerHTML = html;
}

// ── Load safe environment + account data via the preload bridge ────────────────

async function loadEnv() {
  try {
    const info = await window.bridge.getEnvInfo();
    $('env-status').textContent   = info.status ?? '—';
    $('env-mode').textContent     = info.mode ?? '—';
    $('env-node').textContent     = info.node ?? '—';
    $('env-electron').textContent = info.electron ?? '—';
    setStatus(info.status ?? 'Ready', (info.status ?? '').toLowerCase() === 'ready');
    log('Environment loaded.');
  } catch (err) {
    setStatus('Error', false);
    log(`Failed to load environment: ${err.message}`);
  }
}

async function loadAccounts() {
  const list = $('accounts-list');
  try {
    const accounts = await window.bridge.listAccounts();
    if (accounts && accounts.error) throw new Error(accounts.error);

    list.innerHTML = '';
    if (!accounts || accounts.length === 0) {
      list.innerHTML = '<li class="muted">No accounts configured.</li>';
      return;
    }
    for (const a of accounts) {
      const li = document.createElement('li');
      const name = document.createElement('span');
      name.className = 'acct-name';
      name.textContent = a.displayName || a.providerAccountId;
      const meta = document.createElement('span');
      meta.className = 'acct-meta';
      meta.textContent = `${a.provider} · ${a.providerAccountId}`;
      li.append(name, meta);
      list.appendChild(li);
    }
    log(`Loaded ${accounts.length} source account(s).`);
  } catch (err) {
    list.innerHTML = `<li class="muted">Could not load accounts: ${escapeHtml(err.message)}</li>`;
    log(`Failed to load accounts: ${err.message}`);
  }
}

// ── Mock actions ───────────────────────────────────────────────────────────────

function wireButtons() {
  $('btn-fetch-all').addEventListener('click', () => {
    log('Fetch all accounts clicked (mock — no real fetch performed).');
    setLastRunSummary('<span class="muted">Mock run: Fetch All Accounts — 0 transactions (not wired yet).</span>');
  });

  $('btn-fetch-default').addEventListener('click', () => {
    log('Fetch default account clicked (mock — no real fetch performed).');
    setLastRunSummary('<span class="muted">Mock run: Fetch Default Account — 0 transactions (not wired yet).</span>');
  });

  $('btn-clear-log').addEventListener('click', () => {
    $('log').innerHTML = '';
    log('Log cleared.');
  });
}

// ── Boot ────────────────────────────────────────────────────────────────────────

window.addEventListener('DOMContentLoaded', async () => {
  wireButtons();
  log('Financial Data Bridge desktop started.');
  await loadEnv();
  await loadAccounts();
});
