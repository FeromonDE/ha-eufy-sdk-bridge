// A stable identity for this bridge install, so a host can tell "the same bridge under another address"
// from a second bridge: an add-on is discovered at its Supervisor address (172.30.32.1) while a host may
// have added it under a LAN IP or hostname. Generated once and kept beside the eufy session file, so it
// survives restarts and image updates for as long as the data volume does.
import fs from "node:fs";
import { randomUUID } from "node:crypto";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** This install's id from `file`, created (and persisted) on first use. */
export function loadBridgeId(file) {
  try {
    const id = fs.readFileSync(file, "utf8").trim();
    if (UUID.test(id)) return id;
  } catch {
    // first run: no file yet
  }
  const id = randomUUID();
  try {
    fs.writeFileSync(file, `${id}\n`, { mode: 0o600 });
  } catch (e) {
    console.warn(`[bridge] could not persist the bridge id to ${file}: ${e?.message ?? e} — it changes on restart`);
  }
  return id;
}
