// Keep credentials out of what the bridge emits. eufy's servers echo the account's auth token back in some
// error messages ("token not exist, token = <token>"), the SDK passes that text through, and the bridge
// would otherwise print it in its log and return it in HTTP / WebSocket error bodies, which users paste
// into public issues. Redaction happens where text leaves the bridge, so no call site can forget it.

// `token = <value>` / `token=<value>` as eufy writes it. A JSON key (`"token":`) is not matched, so device
// data that carries such a field is left alone.
const TOKEN_ASSIGNMENT = /(\btoken\s*=\s*)[^\s,;)"'\\]+/gi;

/** `text` with any echoed token value replaced by `<redacted>`. */
export function redactSecrets(text) {
  return typeof text === "string" ? text.replace(TOKEN_ASSIGNMENT, "$1<redacted>") : text;
}

/** Route console output through {@link redactSecrets}, covering the bridge's and the SDK's own logging. */
export function installConsoleRedaction(target = console) {
  for (const method of ["log", "info", "warn", "error", "debug"]) {
    const original = target[method].bind(target);
    target[method] = (...args) =>
      original(...args.map((a) => (a instanceof Error ? redactError(a) : redactSecrets(a))));
  }
}

function redactError(e) {
  const copy = new Error(redactSecrets(e.message));
  copy.name = e.name;
  copy.stack = redactSecrets(e.stack);
  return copy;
}
