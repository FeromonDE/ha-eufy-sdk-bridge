// Report at boot whether the native WebRTC library loads. The SDK imports node-datachannel only when it
// builds an RTC peer for a HomeBase S1 Pro (T9000), and only after the station's RTC sign succeeded, so a
// missing or wrong-architecture build would otherwise stay invisible until the first T9000 live view or
// command on an account whose sign works. One line at startup says it is there and loads, on this arch.
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

/** Try the import and describe the outcome. `load` is injectable for tests. */
export async function checkWebRtcLibrary(load = () => import("node-datachannel")) {
  const where = `${process.platform}-${process.arch}`;
  try {
    const lib = await load();
    if (typeof (lib.PeerConnection ?? lib.default?.PeerConnection) !== "function") {
      return {
        ok: false,
        line: `[bridge] WebRTC library node-datachannel loaded on ${where} but exposes no PeerConnection`,
      };
    }
    return { ok: true, line: `[bridge] WebRTC library node-datachannel ${version()} loaded (${where})` };
  } catch (e) {
    return {
      ok: false,
      line:
        `[bridge] WebRTC library node-datachannel unavailable on ${where}: ${e?.message ?? e} — ` +
        "HomeBase S1 Pro (T9000) commands and live view need it",
    };
  }
}

/**
 * The installed version and the prebuilt binary package it uses (e.g. `@node-datachannel/linux-arm64-musl`).
 * The package does not export its package.json, so its root is found from the resolved entry point.
 */
function version() {
  try {
    let dir = path.dirname(createRequire(import.meta.url).resolve("node-datachannel"));
    while (!fs.existsSync(path.join(dir, "package.json"))) dir = path.dirname(dir);
    const { version: v } = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    const scope = path.join(path.dirname(dir), "@node-datachannel");
    const builds = fs.existsSync(scope) ? fs.readdirSync(scope) : [];
    return builds.length ? `${v}, ${builds.map((b) => `@node-datachannel/${b}`).join(" + ")}` : v;
  } catch {
    return "(version unknown)";
  }
}
