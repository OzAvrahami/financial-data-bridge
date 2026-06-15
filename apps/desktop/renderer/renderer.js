/**
 * Renderer logic. Runs sandboxed — no Node, no secrets. Talks to the main
 * process only through the `window.bridge` API exposed by preload.cjs.
 *
 * Responsibilities (UI only — all persistence/validation also enforced in main):
 *   - load/edit/save settings (global daysBack + source accounts)
 *   - render the read-only Source Accounts summary
 *   - run settings-driven MOCK fetch actions
 */

const $ = (id) => document.getElementById(id);

const PROVIDERS = ['cal']; // extend as providers are added

// In-memory editor state (mirrors the saved config; secrets are never present).
let editorAccounts = []; // [{ provider, providerAccountId, displayName, enabled, default, daysBack, usernameEnv, passwordEnv }]
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

function setLastRunSummary(html) {
  $('summary-body').innerHTML = html;
}

const DAYS_BACK_MIN = 1;
const DAYS_BACK_MAX = 365;

// Client-side mirror of bridge-core validateDaysBack (UX feedback; main re-validates).
function validateDaysBack(value) {
  if (value === '' || value === null || value === undefined) {
    return { valid: false, error: 'days back is required' };
  }
  const n = Number(String(value).trim());
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    return { valid: false, error: 'days back must be a whole number' };
  }
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
    setStatus(info.status ?? 'Ready', (info.status ?? '').toLowerCase() === 'ready');
  } catch (err) {
    setStatus('Error', false);
    log(`Failed to load environment: ${err.message}`);
  }
}

// ── Settings: load, render editor, render summary ─────────────────────────────

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
    provider:          a.provider ?? 'cal',
    providerAccountId: a.providerAccountId ?? 'default',
    displayName:       a.displayName ?? '',
    enabled:           a.enabled !== false,
    default:           a.default === true,
    daysBack:          Number.isInteger(a.daysBack) ? a.daysBack : '',
    usernameEnv:       a.credentials?.usernameEnv ?? '',
    passwordEnv:       a.credentials?.passwordEnv ?? '',
  };
}

// Read-only summary panel, built from the currently-saved settings.
function renderSourceAccounts() {
  const list = $('accounts-list');
  list.innerHTML = '';
  const accounts = savedSettings.accounts ?? [];
  if (accounts.length === 0) {
    list.innerHTML = '<li class="muted">No accounts configured.</li>';
    return;
  }
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

// Editable account rows.
function renderEditor() {
  const root = $('account-editor');
  root.innerHTML = '';
  if (editorAccounts.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = 'No accounts yet — click “+ Add Account”.';
    root.appendChild(empty);
    return;
  }

  editorAccounts.forEach((acc, i) => {
    const row = document.createElement('div');
    row.className = 'editor-row';

    // default radio
    const def = document.createElement('input');
    def.type = 'radio';
    def.name = 'default-account';
    def.checked = !!acc.default;
    def.addEventListener('change', () => {
      editorAccounts.forEach((a, j) => { a.default = (j === i); });
    });

    // provider select
    const prov = document.createElement('select');
    for (const p of PROVIDERS) {
      const opt = document.createElement('option');
      opt.value = p; opt.textContent = p;
      if (p === acc.provider) opt.selected = true;
      prov.appendChild(opt);
    }
    prov.addEventListener('change', () => { acc.provider = prov.value; });

    const accId   = textInput(acc.providerAccountId, 'e.g. cal_5304', v => acc.providerAccountId = v);
    const display = textInput(acc.displayName, 'e.g. CAL 5304', v => acc.displayName = v);

    const days = document.createElement('input');
    days.type = 'number'; days.min = '1'; days.max = '365'; days.step = '1';
    days.placeholder = 'global';
    days.value = acc.daysBack === '' ? '' : acc.daysBack;
    days.addEventListener('input', () => {
      acc.daysBack = days.value === '' ? '' : Number(days.value);
    });

    const userEnv = textInput(acc.usernameEnv, 'CAL_USERNAME', v => acc.usernameEnv = v);
    const passEnv = textInput(acc.passwordEnv, 'CAL_PASSWORD', v => acc.passwordEnv = v);

    const onWrap = document.createElement('label');
    onWrap.className = 'switch';
    const enabled = document.createElement('input');
    enabled.type = 'checkbox';
    enabled.checked = acc.enabled !== false;
    enabled.addEventListener('change', () => { acc.enabled = enabled.checked; });
    onWrap.appendChild(enabled);

    const del = document.createElement('button');
    del.className = 'btn btn-ghost btn-sm';
    del.textContent = '✕';
    del.title = 'Delete account';
    del.addEventListener('click', () => {
      editorAccounts.splice(i, 1);
      renderEditor();
    });

    row.append(def, prov, accId, display, days, userEnv, passEnv, onWrap, del);
    root.appendChild(row);
  });
}

function textInput(value, placeholder, onChange) {
  const el = document.createElement('input');
  el.type = 'text';
  el.value = value ?? '';
  el.placeholder = placeholder ?? '';
  el.addEventListener('input', () => onChange(el.value));
  return el;
}

// ── Save ───────────────────────────────────────────────────────────────────────

function collectSettings() {
  const accounts = editorAccounts.map(a => {
    const out = {
      provider:          a.provider,
      providerAccountId: a.providerAccountId,
      displayName:       a.displayName,
      enabled:           a.enabled !== false,
      default:           !!a.default,
    };
    if (a.daysBack !== '' && a.daysBack !== null && a.daysBack !== undefined) out.daysBack = Number(a.daysBack);
    if (a.usernameEnv || a.passwordEnv) {
      out.credentials = {};
      if (a.usernameEnv) out.credentials.usernameEnv = a.usernameEnv;
      if (a.passwordEnv) out.credentials.passwordEnv = a.passwordEnv;
    }
    return out;
  });
  return { daysBack: $('days-back').value, accounts };
}

function showDaysBackError(msg) {
  $('days-back-error').textContent = msg || '';
  $('days-back').classList.toggle('invalid', !!msg);
}

async function saveSettings() {
  const dv = validateDaysBack($('days-back').value);
  showDaysBackError(dv.valid ? '' : dv.error);
  if (!dv.valid) { log(`Cannot save — ${dv.error}.`); return; }

  try {
    const res = await window.bridge.saveSettings(collectSettings());
    if (!res || !res.ok) throw new Error(res?.error || 'unknown error');
    savedSettings = res.saved;
    $('days-back').value = res.saved.daysBack;
    editorAccounts = res.saved.accounts.map(toEditorRow);
    renderEditor();
    renderSourceAccounts();
    log(`Settings saved — ${res.saved.accounts.length} account(s), days back ${res.saved.daysBack}.`);
  } catch (err) {
    log(`Failed to save settings: ${err.message}`);
  }
}

function addAccount() {
  editorAccounts.push({
    provider: 'cal', providerAccountId: '', displayName: '',
    enabled: true, default: editorAccounts.length === 0, daysBack: '',
    usernameEnv: '', passwordEnv: '',
  });
  renderEditor();
}

// ── Fetch actions (settings-driven mock) ──────────────────────────────────────

async function runFetch(mode) {
  const dv = validateDaysBack($('days-back').value);
  showDaysBackError(dv.valid ? '' : dv.error);
  if (!dv.valid) {
    log(`Fetch blocked — ${dv.error}.`);
    return;
  }

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
