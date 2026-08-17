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

/**
 * person_id -> { name, familiar } — the HomeBase edge-AI face roster, built once at startup.
 *
 * A `personDetected` push only carries a numeric `person_id` (== the roster's person_id, verified
 * against the app), NOT the recognised person's name. The name lives in the on-HomeBase
 * `person_basic_info` table, reachable over P2P. We resolve it here so `personDetected` events can
 * carry a real `person_name`. `stranger\d+` names are auto-assigned to unfamiliar faces.
 */
const faceNames = new Map();

/** Parse `person_basic_info` rows out of a reassembled P2P DB reply (name precedes person_id). */
function parseFaceRoster(text) {
  const rows = text.matchAll(
    /\{"age":\d+,[^{}]*?"name":"([^"]*)"[^{}]*?"person_id":(\d+),"relation":"([^"]*)"/g,
  );
  const out = new Map();
  for (const m of rows) {
    const id = Number(m[2]);
    if (!out.has(id)) out.set(id, { name: m[1], familiar: !/^stranger\d+$/.test(m[1]) });
  }
  return out;
}

/**
 * Attach the recognised person's name to a `personDetected` payload.
 *
 * The push carries only `person_id`; look it up in the roster to add `person_name` + `recognized`.
 * `person_id <= 0` (or -1) means "a person, but no face match" → left unresolved (recognized:false).
 * Unmapped positive ids are logged so a first real recognition confirms the id-space live.
 */
function enrichPersonName(event, payload) {
  if (event !== "personDetected") return payload;
  const pid = Number(payload?.person_id);
  if (!Number.isFinite(pid) || pid <= 0) return { ...payload, recognized: false };
  const rec = faceNames.get(pid);
  if (!rec) {
    console.log(`[bridge] personDetected person_id=${pid} not in roster (${faceNames.size} known)`);
    return { ...payload, recognized: false };
  }
  return { ...payload, person_name: rec.name, recognized: rec.familiar };
}

const eufy = new EufyMega({
  email: cfg.email,
  password: cfg.password,
  countryCode: cfg.country,
  store: new FileSessionStore(cfg.session),
  pollMs: cfg.pollMs, // undefined → SDK default; changeable live via config.set
});
eufy.on("error", (e) => console.error(`[bridge] sdk error: ${e?.message ?? e}`));

// Push (FCM) liveness — the watchdog's poll heartbeat can't see a dead push channel (events ride
// push, state rides poll), so track push connect/disconnect explicitly.
let pushConnected = false;
let pushSince = Date.now();
eufy.on("pushConnect", () => {
  pushConnected = true;
  pushSince = Date.now();
});
eufy.on("pushDisconnect", () => {
  pushConnected = false;
  pushSince = Date.now();
});

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
const PUSH_STALL_MS = 5 * 60_000; // push down (or never up) this long ⇒ recover — events are dead.
async function watchdogTick() {
  if (!ready || recovering) return;
  const idleMs = Date.now() - lastActivity;
  const pushDeadMs = pushConnected ? 0 : Date.now() - pushSince;
  const pollStalled = idleMs >= stallThresholdMs();
  const pushStalled = pushDeadMs >= PUSH_STALL_MS;
  if (!pollStalled && !pushStalled) return;
  recovering = true;
  const why = pollStalled
    ? `poll idle ${Math.round(idleMs / 1000)}s`
    : `push down ${Math.round(pushDeadMs / 1000)}s`;
  console.error(`[bridge] realtime stalled (${why}) — re-establishing`);
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
    pushSince = Date.now(); // give push a fresh window to reconnect before flagging it again
    console.log("[bridge] realtime re-established after stall");
  } catch (e) {
    console.error(`[bridge] stall recovery failed (${e?.message ?? e}) — exiting for a clean restart`);
    process.exit(1);
  } finally {
    recovering = false;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The first complete brace-balanced JSON object in a string (the P2P DB reply has trailing padding). */
function firstJsonObject(text) {
  const start = text.indexOf("{");
  if (start < 0) return undefined;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) {
      try {
        return JSON.parse(text.slice(start, i + 1));
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

/**
 * Build the face-recognition roster (`faceNames`) at startup by reading `person_basic_info` off each
 * connected HomeBase over P2P (CMD_DATABASE 1306 / inner cmd 10000, mChannel 255). Faces are
 * account-wide, so every station's rows merge into one map. Best-effort: on any failure the map just
 * stays smaller and `personDetected` events fall back to "Unknown".
 */
async function warmFaceRoster() {
  try {
    const devs = await eufy.getDevices();
    const accountId =
      devs.find((d) => d.raw?.member?.admin_user_id)?.raw?.member?.admin_user_id ?? eufy.api?.auth?.userId ?? "";
    let sessions = eufy.getP2pSessions();
    for (let i = 0; i < 20 && sessions.size === 0; i++) {
      await sleep(1000);
      sessions = eufy.getP2pSessions();
    }
    for (const [, session] of sessions) {
      for (let i = 0; i < 30 && !session.isConnected; i++) await sleep(500);
      if (!session.isConnected) continue;

      let chunk = "";
      const onChunk = ({ text }) => (chunk += text);
      session.on("dbChunk", onChunk);
      session.requestFaces({ accountId });
      setTimeout(() => session.isConnected && session.requestFaces({ accountId }), 1500);
      await sleep(6000);
      session.off?.("dbChunk", onChunk);

      let added = 0;
      for (const [id, rec] of parseFaceRoster(chunk)) {
        if (!faceNames.has(id)) added++;
        faceNames.set(id, rec);
      }
      if (added) console.log(`[bridge] face roster: +${added} person(s) (${faceNames.size} total)`);
    }
  } catch (e) {
    console.error(`[bridge] warm face roster failed: ${e?.message ?? e}`);
  }
}

/**
 * Warm the "Last event" thumbnails at startup from LOCAL (HomeBase) storage, so the images are
 * populated on first HA load even before any live push. Per connected station: query the latest
 * event per device over P2P (history_record_info, cmd 10013 / mChannel 0), then requestImage() each
 * on-HomeBase cover path (plain JPEG) and persist it to <data>/last-event-<sn>.jpg — which
 * /event-image already serves. This is the only startup source for local-storage accounts (the cloud
 * events/list + device cover_path are empty without cloud storage).
 */
async function warmLastEventImages() {
  try {
    const devs = await eufy.getDevices();
    const accountId =
      devs.find((d) => d.raw?.member?.admin_user_id)?.raw?.member?.admin_user_id ?? eufy.api?.auth?.userId ?? "";
    // Sessions come up asynchronously after login — give them a moment to appear.
    let sessions = eufy.getP2pSessions();
    for (let i = 0; i < 20 && sessions.size === 0; i++) {
      await sleep(1000);
      sessions = eufy.getP2pSessions();
    }
    for (const [ssn, session] of sessions) {
      for (let i = 0; i < 30 && !session.isConnected; i++) await sleep(500); // await handshake
      if (!session.isConnected) continue;

      let chunk = "";
      const onChunk = ({ text }) => (chunk += text);
      session.on("dbChunk", onChunk);
      session.queryDatabase("history_record_info", { accountId, channel: 0, innerCmd: 10013 });
      setTimeout(() => session.isConnected && session.queryDatabase("history_record_info", { accountId, channel: 0, innerCmd: 10013 }), 1500);
      await sleep(6000);
      session.off?.("dbChunk", onChunk);

      const records = firstJsonObject(chunk)?.data ?? [];
      const covers = new Map(); // device_sn -> on-HomeBase cover path
      for (const rec of records) {
        const p = rec?.payload?.crop_hb3_path;
        if (rec?.device_sn && typeof p === "string" && p) covers.set(rec.device_sn, p);
      }
      if (!covers.size) continue;

      const images = new Map(); // file -> jpeg buffer
      const onImage = ({ file, data }) => {
        if (data?.[0] === 0xff && data?.[1] === 0xd8) images.set(file, data);
      };
      session.on("image", onImage);
      for (const [dsn, filePath] of covers) {
        session.requestImage(filePath, { accountId });
        for (let i = 0; i < 40 && !images.has(filePath); i++) await sleep(200); // ≤8s per image
        const data = images.get(filePath);
        if (data) {
          fs.writeFileSync(path.join(eventImageDir, `last-event-${dsn}.jpg`), data);
          console.log(`[bridge] warmed last-event image for ${dsn} (${data.length}B, local)`);
        }
      }
      session.off?.("image", onImage);
    }
  } catch (e) {
    console.error(`[bridge] warm last-event images failed: ${e?.message ?? e}`);
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
        broadcast({ event: e, ...enrichPersonName(e, payload) });
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
    // Both read the P2P DB via a shared `dbChunk` stream — run sequentially so their accumulators
    // don't cross-contaminate. Non-blocking so `ready` isn't held up.
    void (async () => {
      await warmFaceRoster(); // resolve person_id -> name for face-recognition events
      await warmLastEventImages(); // populate "Last event" from local HomeBase storage on first load
    })();
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
      pushConnected, // FCM push channel — events (motion/doorbell/…) ride this
      pushIdleSec: pushConnected ? 0 : Math.round((Date.now() - pushSince) / 1000),
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
