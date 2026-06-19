/**
 * Secret redaction helpers.
 *
 * Used anywhere a secret (API key/token) or a secret-bearing URL could otherwise
 * end up in an error message, log line, IPC payload, or UI string. These never
 * throw — redaction must not become a new failure mode.
 */

/**
 * Replace every occurrence of each known secret with [REDACTED].
 * @param {string} text
 * @param {Array<string|null|undefined>} secrets
 */
export function redactSecrets(text, secrets = []) {
  let out = String(text ?? '');
  for (const s of secrets) {
    if (s && typeof s === 'string' && s.length > 0) {
      out = out.split(s).join('[REDACTED]');
    }
  }
  return out;
}

/**
 * Reduce a URL to scheme://host/path, dropping userinfo, query, and fragment —
 * any of which can carry tokens. Returns a safe placeholder if unparseable.
 */
export function safeUrl(url) {
  try {
    const u = new URL(String(url));
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return '[invalid-url]';
  }
}

/** Truncate long text (e.g. an HTTP response body) to a bounded snippet. */
export function truncate(text, max = 200) {
  const s = String(text ?? '');
  return s.length > max ? `${s.slice(0, max)}…[truncated]` : s;
}
