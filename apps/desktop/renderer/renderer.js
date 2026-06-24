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
let savedSettings = { daysBack: 4, accounts: [], finance: { enabled: false, apiUrl: '', credentialKey: 'finance-default' } };

const FINANCE_CREDENTIAL_KEY = 'finance-default';

// Whether a finance API key is currently saved (last known from the status check)
// and the path to the most recent finance sync audit report, for the Open Report
// button. Together with the enabled flag + URL these gate the Sync buttons.
let financeKeySaved = false;
let lastReportPath = null;

// Friendly text for the per-transaction finance status reasons emitted by the
// bridge-core sync engine. Keep in sync with syncTransactionsToFinance().
const FINANCE_REASON_TEXT = {
  run_mode_fetch_only:            'Fetch Only run — finance was not contacted',
  finance_disabled:               'finance integration is disabled',
  missing_api_url:                'the finance API URL is not set',
  missing_api_key:                'no finance API key is saved',
  fetch_failed:                   'the fetch failed, so nothing was synced',
  transaction_not_completed:      'transaction is not completed yet',
  charge_amount_zero_or_negative: 'no positive charge amount',
  already_sent_successfully:      'already sent to finance previously',
  already_sent_content_changed:   'already sent, but details changed since — review needed',
  duplicate_in_current_batch:     'duplicate within this batch',
  api_validation_failed:          'finance API rejected the transaction',
  api_error:                      'finance API/network error',
};
function reasonText(reason) {
  return FINANCE_REASON_TEXT[reason] || reason || 'unknown reason';
}

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
    loadFinanceUI(settings.finance);
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
  return { daysBack: $('days-back').value, accounts, finance: collectFinance() };
}

// ── Financial System Integration ───────────────────────────────────────────────

function financeCredentialKey() {
  return (savedSettings.finance && savedSettings.finance.credentialKey) || FINANCE_CREDENTIAL_KEY;
}

function collectFinance() {
  return {
    enabled:       $('finance-enabled').checked,
    apiUrl:        $('finance-url').value.trim(),
    credentialKey: financeCredentialKey(),
  };
}

function loadFinanceUI(finance = {}) {
  $('finance-enabled').checked = finance.enabled === true;
  $('finance-url').value = finance.apiUrl ?? '';
  refreshFinanceStatus();
}

async function refreshFinanceStatus() {
  const badge = $('finance-status');
  try {
    const s = await window.bridge.getFinanceStatus(financeCredentialKey());
    financeKeySaved = !!(s && s.saved);
    if (s && s.available === false) { badge.textContent = 'secure storage unavailable'; badge.className = 'badge badge-off'; }
    else if (s && s.saved)          { badge.textContent = 'Saved';     badge.className = 'badge badge-on'; }
    else                             { badge.textContent = 'Not saved'; badge.className = 'badge badge-off'; }
  } catch { financeKeySaved = false; badge.textContent = 'unknown'; badge.className = 'badge badge-off'; }
  updateSyncAvailability();
}

async function onSaveFinanceSecret() {
  const secret = $('finance-key').value;
  if (!secret) { log('Enter an API key before saving.'); return; }
  // Persist the URL/enabled flag first so the credentialKey reference is recorded.
  const ok = await persistSettings({ silent: true });
  if (!ok) { log('Could not save finance settings; key not stored.'); return; }
  try {
    const res = await window.bridge.saveFinanceSecret(financeCredentialKey(), secret);
    if (!res || !res.ok) throw new Error(res?.error || 'unknown error');
    $('finance-key').value = ''; // never keep the secret in the DOM
    log('Finance API key saved (encrypted by OS).');
    refreshFinanceStatus();
  } catch (err) { log(`Failed to save finance key: ${err.message}`); }
}

async function onDeleteFinanceSecret() {
  try {
    const res = await window.bridge.deleteFinanceSecret(financeCredentialKey());
    if (!res || !res.ok) throw new Error(res?.error || 'unknown error');
    $('finance-key').value = '';
    log(res.removed ? 'Finance API key deleted.' : 'No finance API key was stored.');
    refreshFinanceStatus();
  } catch (err) { log(`Failed to delete finance key: ${err.message}`); }
}

async function onTestFinanceConnection() {
  const result = $('finance-test-result');
  result.textContent = 'Testing…';
  result.className = 'hint';
  try {
    const res = await window.bridge.testFinanceConnection({
      apiUrl: $('finance-url').value.trim(),
      credentialKey: financeCredentialKey(),
    });
    if (res && res.ok) { result.textContent = `✔ ${res.message}`; result.className = 'hint'; }
    else { result.textContent = `✖ ${res?.message || 'Connection failed'}`; result.className = 'hint err'; }
    log(`Finance connection test: ${res?.message || 'no result'}`);
  } catch (err) {
    result.textContent = `✖ ${err.message}`; result.className = 'hint err';
    log(`Finance connection test failed: ${err.message}`);
  }
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

// ── Fetch actions (real bridge-core automation) ───────────────────────────────

let fetchRunning = false;

function setFetchRunning(on) {
  fetchRunning = on;
  $('btn-fetch-all').disabled = on;
  $('btn-fetch-default').disabled = on;
  updateSyncAvailability();
}

/**
 * Enable the Sync to Finance buttons only when finance is fully configured
 * (enabled + URL + saved key) and no run is in flight. Keeps the user from
 * triggering a finance send that the engine would only reject. The Open Report
 * button is enabled whenever a report from this session exists.
 */
function updateSyncAvailability() {
  const enabled = $('finance-enabled')?.checked === true;
  const hasUrl  = ($('finance-url')?.value || '').trim().length > 0;
  const ready   = enabled && hasUrl && financeKeySaved;
  const syncAll = $('btn-sync-all');
  const syncDef = $('btn-sync-default');
  if (syncAll) syncAll.disabled = !ready || fetchRunning;
  if (syncDef) syncDef.disabled = !ready || fetchRunning;

  const hint = $('sync-disabled-hint');
  if (hint) {
    if (ready) hint.textContent = '';
    else if (!enabled) hint.textContent = 'Enable finance integration above to sync.';
    else if (!hasUrl)  hint.textContent = 'Set the API URL to enable syncing.';
    else if (!financeKeySaved) hint.textContent = 'Save the API key to enable syncing.';
  }

  const openBtn = $('btn-open-report');
  if (openBtn) openBtn.disabled = !lastReportPath;
}

// Render a single secret-free progress event from the engine into the Run Log.
function formatProgress(evt) {
  const who = evt.displayName || evt.providerAccountId || evt.provider || 'account';
  switch (evt.type) {
    case 'account-start':
      return `▶ ${who} — starting (days back ${evt.daysBack ?? 'global'})…`;
    case 'visible-browser-notice':
      return `   ${who} — CAL login requires a visible browser window. Keep it open until login completes.`;
    case 'login':
      return `   ${who} — ${evt.sessionReused ? 'reused saved session' : 'logged in'}.`;
    case 'fetched':
      return `   ${who} — fetched ${evt.transactionsFetched} transaction(s)`
        + (evt.pendingSkipped ? `, ${evt.pendingSkipped} pending skipped` : '')
        + (evt.skipped ? `, ${evt.skipped} extraction skip(s)` : '') + '.';
    case 'dedup':
      return `   ${who} — ${evt.created} new, ${evt.updated} updated, ${evt.unchanged} unchanged, ${evt.duplicates} duplicate(s).`;
    case 'export':
      return evt.exported > 0
        ? `   ${who} — exported ${evt.exported} transaction(s)` + (evt.filePath ? ` → ${evt.filePath}` : '') + '.'
        : `   ${who} — nothing new to export.`;
    case 'account-done':
      return `✔ ${who} — done (${evt.status}).`;
    case 'account-error':
      return `✖ ${who} — ${evt.error}`;
    case 'finance-start':
      return `▶ Finance sync — evaluating ${evt.considered} transaction(s) against the finance ledger…`;
    case 'finance-progress':
      return null; // per-send ticks would be noisy; the done event reports totals
    case 'finance-done':
      return `✔ Finance sync — sent ${evt.sent}, already sent ${evt.alreadySent}, `
        + `skipped ${evt.skipped}, failed ${evt.failed} (of ${evt.considered}).`;
    case 'finance-not-attempted':
      return `• Finance sync not attempted — ${reasonText(evt.reason)}.`;
    case 'finance-error':
      return `✖ Finance sync — ${evt.error}`;
    default:
      return null;
  }
}

function renderRunSummary(res) {
  const s = res.summary || {};
  const accounts = res.accounts || [];
  const sum = (key) => accounts.reduce((n, a) => n + (a[key] || 0), 0);
  const fetched   = sum('transactionsFetched');
  const created   = sum('created');
  const updated   = sum('updated');
  const unchanged = sum('unchanged');
  const savedLocally = s.totalTransactionsExported ?? sum('exported');
  const isSync = res.financeMode === 'sync';

  const head =
    `<div><strong>${isSync ? 'Sync to Finance' : 'Fetch Only'} run</strong>`
    + ` (${escapeHtml(res.mode)} accounts) — `
    + `${s.succeeded ?? 0}/${s.totalAccounts ?? accounts.length} ok, ${s.failed ?? 0} failed `
    + `(days back ${res.daysBack}).</div>`;

  // Common fetch/local block (identical wording for both modes).
  const localBlock =
    `<div class="muted">• CAL fetched ${fetched} transaction(s): `
    + `${created} new, ${updated} updated, ${unchanged} unchanged.</div>`
    + `<div class="muted">• Saved locally: ${savedLocally} transaction(s).</div>`;

  const rows = accounts.map(a => {
    const who = escapeHtml(a.displayName || a.providerAccountId);
    if (a.status === 'failed') {
      return `<div class="muted">&nbsp;&nbsp;✖ ${who} — ${escapeHtml(a.error || 'failed')}</div>`;
    }
    return `<div class="muted">&nbsp;&nbsp;✔ ${who} — ${a.exported} saved `
      + `(${a.created} new, ${a.updated} updated, ${a.unchanged} unchanged, `
      + `${a.duplicates} dup, ${a.pendingSkipped} pending)</div>`;
  }).join('');

  // Finance block differs by mode.
  let financeBlock;
  const f = res.finance || {};
  if (!isSync) {
    financeBlock = `<div class="muted">• Finance sync: <strong>not executed</strong> — mode is Fetch Only.</div>`;
  } else if (f.notAttempted) {
    financeBlock = `<div class="muted">• Finance sync: <strong>not attempted</strong> — ${escapeHtml(reasonText(f.reason))}.</div>`;
  } else if (f.error) {
    financeBlock = `<div class="err">• Finance sync failed — ${escapeHtml(f.error)}.</div>`;
  } else {
    const c = f.counts || {};
    const cls = (c.failed > 0) ? 'err' : 'muted';
    financeBlock =
      `<div class="${cls}">• Finance sync — considered ${c.considered ?? 0}: `
      + `<strong>sent ${c.sent ?? 0}</strong>, already sent ${c.alreadySent ?? 0}, `
      + `skipped ${c.skipped ?? 0}, failed ${c.failed ?? 0}.</div>`
      + (f.reportPath
          ? `<div class="muted">&nbsp;&nbsp;Audit report: <code>${escapeHtml(f.reportPath)}</code> — use “Open Last Report”.</div>`
          : '');
  }

  setLastRunSummary(head + localBlock + rows + financeBlock);
}

async function runFetch(mode, financeMode = 'fetch-only') {
  if (fetchRunning) { log('A run is already in progress — please wait for it to finish.'); return; }

  const dv = validateDaysBack($('days-back').value);
  showDaysBackError(dv.valid ? '' : dv.error);
  if (!dv.valid) { log(`Run blocked — ${dv.error}.`); return; }

  const isSync = financeMode === 'sync';
  const scope  = mode === 'default' ? 'default account' : 'all accounts';
  setFetchRunning(true);
  setStatus(isSync ? 'Syncing…' : 'Fetching…', false);
  log(`${isSync ? 'Sync to Finance' : 'Fetch Only'} (${scope}) started (days back ${dv.value})…`);
  try {
    const res = await window.bridge.runFetch({ mode, financeMode, daysBack: dv.value });
    if (!res || !res.ok) {
      log(`Run error: ${res?.error || 'unknown error'}`);
      setLastRunSummary(`<span class="err">${escapeHtml(res?.error || 'Run failed')}</span>`);
      return;
    }
    // Remember the audit report so "Open Last Report" can reveal it.
    if (res.finance && res.finance.reportPath) {
      lastReportPath = res.finance.reportPath;
    }
    renderRunSummary(res);

    const f = res.finance || {};
    let financeMsg = '';
    if (isSync && f.counts) {
      financeMsg = ` Finance: sent ${f.counts.sent}, already sent ${f.counts.alreadySent}, `
        + `skipped ${f.counts.skipped}, failed ${f.counts.failed}.`;
    } else if (isSync && f.notAttempted) {
      financeMsg = ` Finance not attempted (${reasonText(f.reason)}).`;
    }
    log(`Run complete — ${res.summary?.succeeded ?? 0} ok, ${res.summary?.failed ?? 0} failed, `
      + `${res.summary?.totalTransactionsExported ?? 0} saved locally.${financeMsg}`);
  } catch (err) {
    log(`Run failed: ${err.message}`);
    setLastRunSummary(`<span class="err">${escapeHtml(err.message)}</span>`);
  } finally {
    setFetchRunning(false);
    setStatus('Ready', true);
  }
}

async function onOpenReport() {
  if (!lastReportPath) { log('No finance report yet — run a Sync to Finance first.'); return; }
  try {
    const res = await window.bridge.revealReport(lastReportPath);
    if (!res || !res.ok) log(`Could not open report: ${res?.error || 'unknown error'}`);
  } catch (err) { log(`Could not open report: ${err.message}`); }
}

// ── Wiring + boot ────────────────────────────────────────────────────────────────

function wire() {
  $('btn-add-account').addEventListener('click', addAccount);
  $('btn-save-settings').addEventListener('click', saveSettings);
  $('btn-fetch-all').addEventListener('click', () => runFetch('all'));
  $('btn-fetch-default').addEventListener('click', () => runFetch('default'));
  $('btn-clear-log').addEventListener('click', () => { $('log').innerHTML = ''; log('Log cleared.'); });
  $('btn-finance-save').addEventListener('click', onSaveFinanceSecret);
  $('btn-finance-delete').addEventListener('click', onDeleteFinanceSecret);
  $('btn-finance-test').addEventListener('click', onTestFinanceConnection);
  $('btn-sync-all').addEventListener('click', () => runFetch('all', 'sync'));
  $('btn-sync-default').addEventListener('click', () => runFetch('default', 'sync'));
  $('btn-open-report').addEventListener('click', onOpenReport);
  // Keep the Sync buttons' enabled state in sync with the finance config inputs.
  $('finance-enabled').addEventListener('change', updateSyncAvailability);
  $('finance-url').addEventListener('input', updateSyncAvailability);
  $('days-back').addEventListener('input', () => {
    const dv = validateDaysBack($('days-back').value);
    showDaysBackError(dv.valid ? '' : dv.error);
  });
}

window.addEventListener('DOMContentLoaded', async () => {
  wire();
  // Stream live, secret-free progress from the engine into the Run Log.
  if (window.bridge.onFetchProgress) {
    window.bridge.onFetchProgress((evt) => {
      const line = formatProgress(evt);
      if (line) log(line);
    });
  }
  log('Financial Data Bridge desktop started.');
  await loadEnv();
  await loadSettings();
});
