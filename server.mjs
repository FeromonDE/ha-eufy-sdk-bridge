// ha-eufy-sdk bridge — one process that logs into eufy ONCE and exposes the SDK to a frontend.
//
//   WS    :PORT/ws             control, state, events, AUTH   (the frontend talks to this)
//   HTTP  :PORT/stream/<sn>    live video (Annex-B)           (go2rtc pulls this)
//   HTTP  :PORT/snapshot/<sn>  a JPEG still
//   HTTP  :PORT/healthz        liveness + auth state + which cameras are streaming
//
// Auth is driven over the WS: if eufy demands 2FA or a captcha, the bridge does NOT exit — it stays up,
// reports `state: "require_2fa" | "require_captcha"` (captcha carries the image), and the frontend
// submits the answer or re-triggers a fresh challenge. Only once logged in does it start go2rtc + serve
// devices. Video is deliberately off the WS: connecting to the stream URL starts the camera.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { WebSocketServer } from "ws";
import { EufyMega, FileSessionStore, LoginStatus } from "@mega-yfue/eufy-sdk";
import { writeGo2rtcConfig } from "./go2rtc-config.mjs";
import { streamClientFor, closeStreamClients } from "./streams.mjs";

// Bump on any breaking protocol change so an older frontend fails loudly rather than subtly.
const SCHEMA_VERSION = 1;

const cfg = {
  email: process.env.EUFY_EMAIL,
  password: process.env.EUFY_PASSWORD,
  country: process.env.EUFY_COUNTRY || "GB",
  host: process.env.BRIDGE_HOST || "0.0.0.0",
  port: Number(process.env.BRIDGE_PORT || 3000),
  session: process.env.EUFY_SESSION || "./data/.eufy-session.json",
  go2rtcConfig: process.env.GO2RTC_CONFIG || "./go2rtc.yaml",
  selfHost: process.env.BRIDGE_SELF_HOST || "127.0.0.1",
  // Cloud poll interval (ms). Unset → the SDK default (600000 = 10 min). A frontend can also change
  // it live via the config.set WS command. 0 disables polling.
  pollMs: process.env.EUFY_POLL_MS ? Number(process.env.EUFY_POLL_MS) : undefined,
};

// Where persisted last-event thumbnails live — the same (mounted) data dir as the session file.
const eventImageDir = path.dirname(cfg.session);
fs.mkdirSync(eventImageDir, { recursive: true });

if (!cfg.email || !cfg.password) {
  console.error("[bridge] EUFY_EMAIL and EUFY_PASSWORD are required");
  process.exit(1);
}

/** The SDK event names broadcast to every connected WS client. */
const FORWARDED_EVENTS = [
  "motion", "personDetected", "strangerDetected", "doorbellPress", "petDetection",
  "packageDelivered", "packageTaken", "packageStranded", "soundDetected", "cryingDetected",
  "vehicleDetected", "dogDetected", "armingModeChanged", "alarm", "lockState",
  "contactState", "batteryLevel", "batteryAlert", "ptzNotify", "smartLightState",
];

const eufy = new EufyMega({
  email: cfg.email,
  password: cfg.password,
  countryCode: cfg.country,
  store: new FileSessionStore(cfg.session),
  pollMs: cfg.pollMs, // undefined → SDK default; changeable live via config.set
});
eufy.on("error", (e) => console.error(`[bridge] sdk error: ${e?.message ?? e}`));

// ── auth state (driven over WS) ──────────────────────────────────────────────────────────────────
let ready = false; // logged in + booted
let lastLogin; // the most recent LoginResult (undefined until first attempt)

/** The normalized auth state a frontend reads — one shape for `auth.status`, the `auth` event and /healthz. */
function authStatus() {
  if (ready) return { state: "ok" };
  if (lastLogin?.status === LoginStatus.Captcha) {
    return { state: "require_captcha", image: lastLogin.image, retry: lastLogin.retry };
  }
  if (lastLogin?.status === LoginStatus.TwoFactor) {
    return { state: "require_2fa", method: lastLogin.method };
  }
  return { state: "pending" };
}

/** Apply a LoginResult: complete the boot on success, and always tell every client the new auth state. */
async function applyLogin(result) {
  lastLogin = result;
  if (result.status === LoginStatus.Ok) await completeBoot();
  broadcast({ event: "auth", ...authStatus() });
}

let booting = false;
// ── realtime liveness watchdog ───────────────────────────────────────────────────────────────────
// The SDK's poll loop re-arms via `pollOnce().finally(schedulePoll)`, so a cloud call that HANGS (no
// timeout, half-open socket) never settles → the loop stalls forever while the WS server stays up and
// serves the last cached state. `deviceState` fires on every healthy poll (proof-of-life even when no
// value changed), so its silence is the stall signal. On a stall we re-establish realtime in place
// (disconnect → login, keeping the WS server + HA connections), and exit for a clean restart if that
// fails. Wire the container with `restart: unless-stopped` so the exit path self-heals too.
let lastActivity = Date.now();
let recovering = false;
let watchdogTimer = null;
const bumpActivity = () => {
  lastActivity = Date.now();
};
/** No poll heartbeat for max(3 polls, 30 min) ⇒ treat the realtime/poll channel as stalled. */
function stallThresholdMs() {
  return Math.max(3 * (eufy.pollIntervalMs || 600_000), 30 * 60_000);
}
async function watchdogTick() {
  if (!ready || recovering) return;
  const idleMs = Date.now() - lastActivity;
  if (idleMs < stallThresholdMs()) return;
  recovering = true;
  console.error(`[bridge] realtime/poll stalled (${Math.round(idleMs / 1000)}s idle) — re-establishing`);
  try {
    await eufy.disconnect();
    const result = await eufy.login();
    await applyLogin(result); // refreshes auth state; completeBoot is a no-op once ready
    if (result.status !== LoginStatus.Ok) {
      console.error(`[bridge] re-login not OK (${result.status}) — exiting for a clean restart`);
      process.exit(1);
    }
    eufy.setPollInterval(eufy.pollIntervalMs); // re-arm the poll loop under the new realtime epoch
    lastActivity = Date.now();
    console.log("[bridge] realtime re-established after stall");
  } catch (e) {
    console.error(`[bridge] stall recovery failed (${e?.message ?? e}) — exiting for a clean restart`);
    process.exit(1);
  } finally {
    recovering = false;
  }
}

/** Runs once, after a successful login: wire events, write go2rtc.yaml, start go2rtc, go ready. */
async function completeBoot() {
  if (ready || booting) return;
  booting = true;
  try {
    eufy.on("deviceState", bumpActivity); // poll heartbeat — the watchdog's liveness signal
    for (const e of FORWARDED_EVENTS)
      eufy.on(e, (payload) => {
        bumpActivity();
        broadcast({ event: e, ...payload });
      });
    // Use the same capability-based view the WS/HA side uses: a camera is a device describeDevice
    // gave a `stream`, NOT deviceClass==="camera" (the SDK downgrades a camera behind a HomeBase to
    // "other"), so go2rtc registers exactly the cameras HA shows.
    const summaries = await deviceList();
    const cams = await writeGo2rtcConfig(cfg, summaries);
    startGo2rtc();
    ready = true;
    lastActivity = Date.now(); // start the liveness clock at boot, before the first poll
    watchdogTimer ??= setInterval(() => void watchdogTick(), 2 * 60_000);
    console.log(`[bridge] ready — ${summaries.length} devices, ${cams.length} camera stream(s)`);
    broadcast({ event: "ready", schemaVersion: SCHEMA_VERSION });
  } finally {
    booting = false;
  }
}

/** Spawn the bundled go2rtc against the generated config. Non-fatal if the binary isn't present (dev). */
let go2rtcProc;
function startGo2rtc() {
  if (go2rtcProc) return;
  try {
    go2rtcProc = spawn("go2rtc", ["-config", cfg.go2rtcConfig], { stdio: "inherit" });
    go2rtcProc.on("error", (e) => console.error(`[bridge] go2rtc not started (${e.message}) — WS/control still up`));
    go2rtcProc.on("exit", (code) => { console.error(`[bridge] go2rtc exited (${code})`); go2rtcProc = undefined; });
  } catch (e) {
    console.error(`[bridge] go2rtc spawn failed: ${e?.message ?? e}`);
  }
}

/**
 * Build the host-facing summary of one device: identity + capabilities + a stream path for a camera.
 *
 * describe() now states identity directly: `name` is the owner's device name (falling back to the
 * product name when unnamed), `model` is the T-code, `modelName` is the product. A host shows `name`
 * as the device name and `model`/`modelName` as its model — no cross-referencing the device list.
 */
async function describeDevice(sn) {
  const dev = await eufy.getDevice(sn);
  const m = dev.describe();
  const isCamera = m.capabilities.includes("camera") || m.capabilities.includes("video");
  return {
    sn: m.sn,
    name: m.name, // owner's device name (e.g. "Dining room"), from device_name
    model: m.model || m.modelName, // T-code (e.g. "T8410"); product name as fallback
    modelName: m.modelName, // product display name (e.g. "Indoor Cam Pan & Tilt")
    codec: m.codec,
    capabilities: m.capabilities,
    state: propertyState(dev), // live property values ({ battery: 74, motion: false, … })
    stream: isCamera ? `/stream/${m.sn}` : undefined,
    canReboot: m.codec === "station", // HomeBase-only; drives a Reboot button in HA
  };
}

/** Live property values as a flat `{ name: value }` map (reading schedules a background refresh). */
function propertyState(dev) {
  const out = {};
  for (const [name, pv] of Object.entries(dev.getProperties())) out[name] = pv.value;
  return out;
}

/**
 * The device's property manifest — the host-relevant half of each PropertySpec, so a frontend can
 * build the right entity (writable bool → switch, enum → select, number → number, else sensor)
 * without knowing eufy wire ids. Wire-only fields (paramType, decode, aliases) are omitted.
 */
function propertySpecs(dev) {
  return (dev.properties ?? []).map((p) => ({
    name: p.name,
    type: p.type, // "bool" | "number" | "string" | "enum"
    unit: p.unit, // "%", "°C", "dBm", …
    kind: p.kind, // percent | celsius | dbm | seconds | …
    writable: p.writable, // a setter exists (device.set accepts it)
    enumValues: p.enumValues, // { raw: label } for enums
    description: p.description,
  }));
}

async function deviceList() {
  const devices = await eufy.getDevices();
  return Promise.all(
    devices.map((d) => describeDevice(d.sn).catch((e) => ({ sn: d.sn, error: String(e?.message ?? e) }))),
  );
}

// ── HTTP: video + snapshot + health ───────────────────────────────────────────────────────────────
const streaming = new Set();

const httpServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const [, kind, sn] = url.pathname.split("/");

  if (url.pathname === "/healthz") {
    const idleSec = Math.round((Date.now() - lastActivity) / 1000);
    return json(res, 200, {
      ok: true,
      schemaVersion: SCHEMA_VERSION,
      auth: authStatus(),
      streaming: [...streaming],
      lastActivitySec: idleSec, // seconds since the last poll heartbeat / realtime event
      stalled: ready && idleSec * 1000 >= stallThresholdMs(),
    });
  }
  if (!ready) return json(res, 503, { error: "not authenticated", auth: authStatus() });

  // A current still: a fresh live burst, falling back to the retained push thumbnail.
  if (kind === "snapshot" && sn) {
    try {
      const cam = (await eufy.getDevice(sn)).camera?.();
      if (!cam) return json(res, 404, { error: "no camera on this device" });
      let jpeg;
      try {
        ({ jpeg } = await cam.snapshotLive());
      } catch {
        jpeg = await cam.snapshotStored?.(); // may throw when nothing is retained
      }
      if (!jpeg) return json(res, 404, { error: "no image available" });
      res.writeHead(200, { "content-type": "image/jpeg", "content-length": jpeg.length });
      return res.end(jpeg);
    } catch (e) {
      return json(res, 502, { error: String(e?.message ?? e) });
    }
  }

  // The latest detection thumbnail the SDK downloaded + retained (no live capture). The SDK's
  // cache is in-memory (cleared on restart / watchdog recovery), so we also persist each served
  // thumbnail to disk and fall back to it when nothing is retained — the "Last event" image then
  // survives restarts instead of blanking until the next detection.
  if (kind === "event-image" && sn) {
    const file = path.join(eventImageDir, `last-event-${sn}.jpg`);
    try {
      const cam = (await eufy.getDevice(sn)).camera?.();
      if (!cam?.snapshotStored) return json(res, 404, { error: "no camera on this device" });
      const jpeg = await cam.snapshotStored();
      fs.writeFile(file, jpeg, () => {}); // best-effort persist for restart survival
      res.writeHead(200, { "content-type": "image/jpeg", "content-length": jpeg.length });
      return res.end(jpeg);
    } catch (e) {
      // Nothing retained live — serve the last persisted thumbnail if we have one.
      try {
        const cached = await fs.promises.readFile(file);
        res.writeHead(200, { "content-type": "image/jpeg", "content-length": cached.length });
        return res.end(cached);
      } catch {
        // No live and no persisted image. Surface the SDK reason (not-observed / pending /
        // download-failed / invalid-image) so a caller can tell "no event yet" from a failure.
        return json(res, 404, { error: String(e?.message ?? e), reason: e?.reason });
      }
    }
  }

  if (kind === "stream" && sn) {
    try {
      const client = await streamClientFor(sn, cfg); // its OWN P2P session — see streams.mjs
      const cam = (await client.getDevice(sn)).camera?.();
      if (!cam?.openReadable) return json(res, 404, { error: "no live video on this device" });
      const feed = await cam.openReadable(); // node Readable of Annex-B
      streaming.add(sn);
      res.writeHead(200, { "content-type": "video/H264", "cache-control": "no-cache" });
      feed.pipe(res);
      const cleanup = () => { feed.destroy(); streaming.delete(sn); };
      req.on("close", cleanup);
      feed.on("error", cleanup);
      return;
    } catch (e) {
      return json(res, 502, { error: String(e?.message ?? e) });
    }
  }

  return json(res, 404, { error: "not found" });
});

function json(res, code, body) {
  const s = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(s) });
  res.end(s);
}

// ── WebSocket: control + state + events + auth ─────────────────────────────────────────────────────
const wss = new WebSocketServer({ server: httpServer, path: "/ws" });
const clients = new Set();

wss.on("connection", (ws) => {
  clients.add(ws);
  // On connect, tell the client the schema AND the current auth state, so a frontend knows immediately
  // whether it must drive a 2FA/captcha step before anything else works.
  send(ws, { event: "hello", schemaVersion: SCHEMA_VERSION, auth: authStatus() });
  ws.on("close", () => clients.delete(ws));
  ws.on("message", (raw) => handleMessage(ws, raw).catch((e) => console.error("[bridge] ws:", e)));
});

async function handleMessage(ws, raw) {
  let msg;
  try { msg = JSON.parse(raw.toString()); } catch { return send(ws, { ok: false, error: "bad json" }); }
  const { id, cmd } = msg;
  const reply = (extra) => send(ws, { id, ok: true, ...extra });
  const fail = (error) => send(ws, { id, ok: false, error: String(error?.message ?? error) });
  try {
    switch (cmd) {
      // ── auth ──
      case "auth.status":
        return reply({ auth: authStatus() });
      case "auth.submit": {
        // A 2FA code (`code`) or a captcha answer (`captcha`). The pending id/token is held in the SDK.
        if (msg.captcha != null) await applyLogin(await eufy.solveCaptcha(String(msg.captcha)));
        else if (msg.code != null) await applyLogin(await eufy.submitVerifyCode(String(msg.code)));
        else return fail("auth.submit needs { code } (2FA) or { captcha } (captcha answer)");
        return reply({ auth: authStatus() });
      }
      case "auth.retrigger":
        // Re-request a fresh challenge (new captcha image / new 2FA code).
        await applyLogin(await eufy.login());
        return reply({ auth: authStatus() });

      // ── device control (require auth) ──
      case "devices.list":
      case "device.state":
      case "device.properties":
      case "device.set":
      case "device.reboot":
      case "config.get":
      case "config.set":
      case "stream.start":
      case "stream.stop":
        if (!ready) return fail("not authenticated — query auth.status and complete 2FA/captcha first");
        break;
      default:
        return fail(`unknown cmd: ${cmd}`);
    }
    switch (cmd) {
      case "devices.list": return reply({ devices: await deviceList() });
      case "device.state": return reply({ device: await describeDevice(msg.sn) });
      case "device.properties": {
        const dev = await eufy.getDevice(msg.sn);
        return reply({ sn: msg.sn, properties: propertySpecs(dev) });
      }
      case "device.set": {
        await eufy.setProperty(msg.sn, msg.name, msg.value);
        return reply({});
      }
      case "device.reboot": {
        // HomeBase-only; SDK throws for a non-hub serial. The hub drops offline for a minute or two.
        await eufy.reboot(msg.sn);
        return reply({});
      }
      case "config.get":
        // Current effective cloud poll interval (ms). 0 means polling is disabled.
        return reply({ pollMs: eufy.pollIntervalMs });
      case "config.set": {
        // Change the cloud poll interval live. Expect a non-negative integer (ms); 0 disables.
        const ms = Number(msg.pollMs);
        if (!Number.isFinite(ms) || ms < 0) return fail("pollMs must be a non-negative number (ms)");
        eufy.setPollInterval(ms);
        return reply({ pollMs: eufy.pollIntervalMs });
      }
      case "stream.start":
        // Returns URLs; does NOT open the camera — the media connection does that.
        return reply({
          path: `/stream/${msg.sn}`,
          http: `http://${cfg.selfHost}:${cfg.port}/stream/${msg.sn}`,
          rtsp: `rtsp://${cfg.selfHost}:8554/${msg.sn}`,
        });
      case "stream.stop": return reply({}); // advisory; the media connection is the real signal
    }
  } catch (e) { return fail(e); }
}

function send(ws, obj) { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj)); }
function broadcast(obj) { const s = JSON.stringify(obj); for (const ws of clients) if (ws.readyState === ws.OPEN) ws.send(s); }

// ── boot ───────────────────────────────────────────────────────────────────────────────────────────
async function main() {
  // Serve FIRST — the WS must be reachable so a client can drive 2FA/captcha before we're authed.
  httpServer.listen(cfg.port, cfg.host, () => console.log(`[bridge] listening on ${cfg.host}:${cfg.port}`));
  try {
    await applyLogin(await eufy.login());
  } catch (e) {
    console.error(`[bridge] login attempt failed: ${e?.message ?? e} — retry via WS 'auth.retrigger'`);
  }
  if (ready) console.log("[bridge] logged in from a stored session");
  else console.log(`[bridge] auth required: ${authStatus().state} — drive it over WS /ws (auth.status / auth.submit)`);
}

async function shutdown() {
  if (watchdogTimer) clearInterval(watchdogTimer);
  go2rtcProc?.kill();
  await closeStreamClients();
  await eufy.disconnect?.();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

main().catch((e) => { console.error("[bridge] fatal:", e); process.exit(1); });
