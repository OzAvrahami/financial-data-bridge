/**
 * Renderer logic. Runs sandboxed — no Node, no secrets-at-rest. Talks to the main
 * process only through the `window.bridge` API exposed by preload.cjs.
 *
 * Credential model: the user types username/password directly. These are sent to
 * the MAIN process which encrypts them with the OS keychain (Electron safeStorage)
 * under a per-account `credentialKey`. accounts.config.json stores only that key.
 * The renderer NEVER receives a saved password back — only a "saved/not saved"
 * status.
 */

const $ = (id) => document.getElementById(id);

const PROVIDERS = ['cal']; // extend as providers are added

let editorAccounts = []; // editor rows (see toEditorRow); never holds saved secrets
let savedSettings = { daysBack: 4, accounts: [] };

// ── Helpers ───────────────────────────────────────────────────────────────────

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

function setLastRunSummary(html) { $('summary-body').innerHTML = html; }

function newCredentialKey() {
  // Stable, rename-proof key for the secure store.
  return (self.crypto && self.crypto.randomUUID) ? self.crypto.randomUUID()
    : 'cred_' + Date.now() + '_' + Math.random().toString(16).slice(2);
}

const DAYS_BACK_MIN = 1;
const DAYS_BACK_MAX = 365;

// Client-side mirror of bridge-core validateDaysBack (main re-validates).
function validateDaysBack(value) {
  if (value === '' || value === null || value === undefined) return { valid: false, error: 'days back is required' };
  const n = Number(String(value).trim());
  if (!Number.isFinite(n) || !Number.isInteger(n)) return { valid: false, error: 'days back must be a whole number' };
  if (n < DAYS_BACK_MIN) return { valid: false, error: `days back must be at least ${DAYS_BACK_MIN}` };
  if (n > DAYS_BACK_MAX) return { valid: false, error: `days back must be at most ${DAYS_BACK_MAX}` };
  return { valid: true, value: n };
}

// ── Environment header ──────────────────────────────────────────────────────────

async function loadEnv() {
  try {
    const info = await window.bridge.getEnvInfo();
    $('env-status').textContent   = info.status ?? '—';
    $('env-mode').textContent     = info.mode ?? '—';
    $('env-node').textContent     = info.node ?? '—';
    $('env-electron').textContent = info.electron ?? '—';
    if (info.secureStorage) log(`OS secure storage: ${info.secureStorage}.`);
    setStatus(info.status ?? 'Ready', (info.status ?? '').toLowerCase() === 'ready');
  } catch (err) {
    setStatus('Error', false);
    log(`Failed to load environment: ${err.message}`);
  }
}

// ── Settings: load, render ────────────────────────────────────────────────────

async function loadSettings() {
  try {
    const settings = await window.bridge.getSettings();
    if (settings && settings.error) throw new Error(settings.error);
    savedSettings = settings;
    $('days-back').value = settings.daysBack ?? 4;
    editorAccounts = (settings.accounts ?? []).map(toEditorRow);
    renderEditor();
    renderSourceAccounts();
    log(`Settings loaded — ${editorAccounts.length} account(s), days back ${settings.daysBack}.`);
  } catch (err) {
    log(`Failed to load settings: ${err.message}`);
  }
}

function toEditorRow(a) {
  return {
    credentialKey:     a.credentialKey || newCredentialKey(),
    provider:          a.provider ?? 'cal',
    providerAccountId: a.providerAccountId ?? 'default',
    displayName:       a.displayName ?? '',
    enabled:           a.enabled !== false,
    default:           a.default === true,
    daysBack:          Number.isInteger(a.daysBack) ? a.daysBack : '',
    // Preserve any pre-existing credential reference fields (not shown in UI) so saves don't drop them.
    credentialsEnv:    a.credentials ? { ...a.credentials } : undefined,
  };
}

// Read-only summary panel from the currently-saved settings.
function renderSourceAccounts() {
  const list = $('accounts-list');
  list.innerHTML = '';
  const accounts = savedSettings.accounts ?? [];
  if (accounts.length === 0) { list.innerHTML = '<li class="muted">No accounts configured.</li>'; return; }
  for (const a of accounts) {
    const li = document.createElement('li');
    const left = document.createElement('div');
    const name = document.createElement('div');
    name.className = 'acct-name';
    name.textContent = (a.displayName || a.providerAccountId) + (a.default ? '  ★' : '');
    const meta = document.createElement('div');
    meta.className = 'acct-meta';
    const days = Number.isInteger(a.daysBack) ? a.daysBack : savedSettings.daysBack;
    meta.textContent = `${a.provider} · ${a.providerAccountId} · ${days}d`;
    left.append(name, meta);
    const badge = document.createElement('span');
    badge.className = 'badge ' + (a.enabled !== false ? 'badge-on' : 'badge-off');
    badge.textContent = a.enabled !== false ? 'enabled' : 'disabled';
    li.append(left, badge);
    list.appendChild(li);
  }
}

// ── Editable account cards ────────────────────────────────────────────────────

function field(labelText, inputEl) {
  const wrap = document.createElement('label');
  wrap.className = 'fld';
  const lab = document.createElement('span');
  lab.className = 'fld-label';
  lab.textContent = labelText;
  wrap.append(lab, inputEl);
  return wrap;
}

function textInput(value, placeholder, onChange, type = 'text') {
  const el = document.createElement('input');
  el.type = type;
  el.value = value ?? '';
  el.placeholder = placeholder ?? '';
  if (onChange) el.addEventListener('input', () => onChange(el.value));
  return el;
}

function renderEditor() {
  const root = $('account-editor');
  root.innerHTML = '';
  if (editorAccounts.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = 'No accounts yet — click "+ Add Account".';
    root.appendChild(empty);
    return;
  }

  editorAccounts.forEach((acc, i) => {
    const card = document.createElement('div');
    card.className = 'acct-card';

    // Header: default + enabled + delete
    const head = document.createElement('div');
    head.className = 'acct-card-head';

    const defLabel = document.createElement('label');
    defLabel.className = 'inline';
    const def = document.createElement('input');
    def.type = 'radio'; def.name = 'default-account'; def.checked = !!acc.default;
    def.addEventListener('change', () => { editorAccounts.forEach((a, j) => a.default = (j === i)); });
    defLabel.append(def, document.createTextNode(' Default'));

    const onLabel = document.createElement('label');
    onLabel.className = 'inline';
    const enabled = document.createElement('input');
    enabled.type = 'checkbox'; enabled.checked = acc.enabled !== false;
    enabled.addEventListener('change', () => { acc.enabled = enabled.checked; });
    onLabel.append(enabled, document.createTextNode(' Enabled'));

    const del = document.createElement('button');
    del.className = 'btn btn-ghost btn-sm';
    del.textContent = 'Delete';
    del.addEventListener('click', () => { editorAccounts.splice(i, 1); renderEditor(); });

    const spacer = document.createElement('div'); spacer.className = 'spacer';
    head.append(defLabel, onLabel, spacer, del);

    // Metadata fields
    const meta = document.createElement('div');
    meta.className = 'acct-fields';

    const prov = document.createElement('select');
    for (const p of PROVIDERS) {
      const opt = document.createElement('option');
      opt.value = p; opt.textContent = p; if (p === acc.provider) opt.selected = true;
      prov.appendChild(opt);
    }
    prov.addEventListener('change', () => { acc.provider = prov.value; });

    const days = textInput(acc.daysBack === '' ? '' : acc.daysBack, 'global', v => {
      acc.daysBack = v === '' ? '' : Number(v);
    }, 'number');
    days.min = '1'; days.max = '365'; days.step = '1';

    meta.append(
      field('Provider', prov),
      field('Account ID', textInput(acc.providerAccountId, 'e.g. cal_5304', v => acc.providerAccountId = v)),
      field('Display name', textInput(acc.displayName, 'e.g. CAL 5304', v => acc.displayName = v)),
      field('Days back', days),
    );

    // Credentials block
    const cred = document.createElement('div');
    cred.className = 'acct-cred';

    const status = document.createElement('span');
    status.className = 'badge';
    status.textContent = 'checking…';
    refreshStatus(acc.credentialKey, status);

    const userInput = textInput('', 'username', null);
    const passInput = textInput('', 'password', null, 'password');

    const saveCred = document.createElement('button');
    saveCred.className = 'btn btn-secondary btn-sm';
    saveCred.textContent = 'Save Credentials';
    saveCred.addEventListener('click', () => onSaveCredentials(acc, userInput, passInput, status));

    cred.append(
      field('Username', userInput),
      field('Password', passInput),
      saveCred,
      status,
    );

    card.append(head, meta, cred);
    root.appendChild(card);
  });
}

async function refreshStatus(credentialKey, statusEl) {
  try {
    const s = await window.bridge.getCredentialStatus(credentialKey);
    if (s && s.available === false) {
      statusEl.textContent = 'secure storage unavailable';
      statusEl.className = 'badge badge-off';
    } else if (s && s.saved) {
      statusEl.textContent = 'Saved';
      statusEl.className = 'badge badge-on';
    } else {
      statusEl.textContent = 'Not saved';
      statusEl.className = 'badge badge-off';
    }
  } catch {
    statusEl.textContent = 'unknown';
    statusEl.className = 'badge badge-off';
  }
}

async function onSaveCredentials(acc, userInput, passInput, statusEl) {
  const username = userInput.value;
  const password = passInput.value;
  if (!username && !password) { log('Enter a username and password before saving credentials.'); return; }

  // Persist account metadata first so the credentialKey is recorded in the config.
  const okSettings = await persistSettings({ silent: true });
  if (!okSettings) { log('Could not save account settings; credentials not stored.'); return; }

  try {
    const res = await window.bridge.saveCredentials(acc.credentialKey, { username, password });
    if (!res || !res.ok) throw new Error(res?.error || 'unknown error');
    userInput.value = '';
    passInput.value = '';     // never keep the secret in the DOM
    statusEl.textContent = 'Saved';
    statusEl.className = 'badge badge-on';
    log(`Credentials saved (encrypted by OS) for ${acc.displayName || acc.providerAccountId}.`);
  } catch (err) {
    log(`Failed to save credentials: ${err.message}`);
  }
}

// ── Save settings ───────────────────────────────────────────────────────────────

function collectSettings() {
  const accounts = editorAccounts.map(a => {
    const out = {
      credentialKey:     a.credentialKey,
      provider:          a.provider,
      providerAccountId: a.providerAccountId,
      displayName:       a.displayName,
      enabled:           a.enabled !== false,
      default:           !!a.default,
    };
    if (a.daysBack !== '' && a.daysBack !== null && a.daysBack !== undefined) out.daysBack = Number(a.daysBack);
    if (a.credentialsEnv) out.credentials = a.credentialsEnv; // preserve dev .env refs
    return out;
  });
  return { daysBack: $('days-back').value, accounts };
}

function showDaysBackError(msg) {
  $('days-back-error').textContent = msg || '';
  $('days-back').classList.toggle('invalid', !!msg);
}

async function persistSettings({ silent = false } = {}) {
  const dv = validateDaysBack($('days-back').value);
  showDaysBackError(dv.valid ? '' : dv.error);
  if (!dv.valid) { if (!silent) log(`Cannot save — ${dv.error}.`); return false; }
  try {
    const res = await window.bridge.saveSettings(collectSettings());
    if (!res || !res.ok) throw new Error(res?.error || 'unknown error');
    savedSettings = res.saved;
    $('days-back').value = res.saved.daysBack;
    // Keep editor in sync, but DO NOT re-render here (avoids clobbering inputs mid-edit).
    renderSourceAccounts();
    if (!silent) log(`Settings saved — ${res.saved.accounts.length} account(s), days back ${res.saved.daysBack}.`);
    return true;
  } catch (err) {
    log(`Failed to save settings: ${err.message}`);
    return false;
  }
}

async function saveSettings() {
  const ok = await persistSettings({ silent: false });
  if (ok) { editorAccounts = savedSettings.accounts.map(toEditorRow); renderEditor(); }
}

function addAccount() {
  editorAccounts.push({
    credentialKey: newCredentialKey(),
    provider: 'cal', providerAccountId: '', displayName: '',
    enabled: true, default: editorAccounts.length === 0, daysBack: '',
  });
  renderEditor();
}

// ── Fetch actions (settings-driven mock) ──────────────────────────────────────

async function runFetch(mode) {
  const dv = validateDaysBack($('days-back').value);
  showDaysBackError(dv.valid ? '' : dv.error);
  if (!dv.valid) { log(`Fetch blocked — ${dv.error}.`); return; }

  log(`${mode === 'default' ? 'Fetch default account' : 'Fetch all accounts'} requested (days back ${dv.value})…`);
  try {
    const res = await window.bridge.runFetch({ mode, daysBack: dv.value });
    if (!res || !res.ok) {
      log(`Fetch error: ${res?.error || 'unknown error'}`);
      setLastRunSummary(`<span class="err">${escapeHtml(res?.error || 'Fetch failed')}</span>`);
      return;
    }
    const names = res.accounts.map(a => `${a.displayName || a.providerAccountId} (${a.daysBack}d)`);
    log(`MOCK ${res.mode} fetch — would run ${res.accounts.length} account(s): ${names.join(', ')}.`);
    res.accounts.forEach(a => log(`  • ${a.provider} · ${a.providerAccountId} — days back ${a.daysBack} (simulated, 0 transactions)`));
    setLastRunSummary(
      `<div><strong>Mock ${escapeHtml(res.mode)} run</strong> — ${res.accounts.length} account(s), days back ${res.daysBack}.</div>` +
      `<div class="muted">${escapeHtml(names.join(', '))}</div>` +
      `<div class="muted">No real automation performed (fetch is still mocked).</div>`
    );
  } catch (err) {
    log(`Fetch failed: ${err.message}`);
  }
}

// ── Wiring + boot ────────────────────────────────────────────────────────────────

function wire() {
  $('btn-add-account').addEventListener('click', addAccount);
  $('btn-save-settings').addEventListener('click', saveSettings);
  $('btn-fetch-all').addEventListener('click', () => runFetch('all'));
  $('btn-fetch-default').addEventListener('click', () => runFetch('default'));
  $('btn-clear-log').addEventListener('click', () => { $('log').innerHTML = ''; log('Log cleared.'); });
  $('days-back').addEventListener('input', () => {
    const dv = validateDaysBack($('days-back').value);
    showDaysBackError(dv.valid ? '' : dv.error);
  });
}

window.addEventListener('DOMContentLoaded', async () => {
  wire();
  log('Financial Data Bridge desktop started.');
  await loadEnv();
  await loadSettings();
});
