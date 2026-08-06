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
};

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
/** Runs once, after a successful login: wire events, write go2rtc.yaml, start go2rtc, go ready. */
async function completeBoot() {
  if (ready || booting) return;
  booting = true;
  try {
    for (const e of FORWARDED_EVENTS) eufy.on(e, (payload) => broadcast({ event: e, ...payload }));
    const devices = await eufy.getDevices();
    await writeGo2rtcConfig(cfg, devices);
    startGo2rtc();
    ready = true;
    console.log(`[bridge] ready — ${devices.length} devices`);
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
 * `name` is the user's device name (`device_name`, e.g. "Dining room") from the cloud record, NOT the
 * resolved model that `describe()` returns (e.g. the model code) — that's what a host wants to show. `friendly`
 * is passed in from the device-list pass; the single-device path looks it up.
 */
async function describeDevice(sn, friendly) {
  const dev = await eufy.getDevice(sn);
  const m = dev.describe();
  if (!friendly) friendly = (await eufy.getDevices()).find((d) => d.sn === sn)?.name;
  const isCamera = m.capabilities.includes("camera") || m.capabilities.includes("video");
  return {
    sn: m.sn,
    name: friendly || m.name, // user-given name wins; the model is only a fallback
    model: m.name, // keep the model available too, so a host can show both if it wants
    codec: m.codec,
    capabilities: m.capabilities,
    stream: isCamera ? `/stream/${m.sn}` : undefined,
  };
}

async function deviceList() {
  const devices = await eufy.getDevices();
  return Promise.all(
    devices.map((d) => describeDevice(d.sn, d.name).catch((e) => ({ sn: d.sn, error: String(e?.message ?? e) }))),
  );
}

// ── HTTP: video + snapshot + health ───────────────────────────────────────────────────────────────
const streaming = new Set();

const httpServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const [, kind, sn] = url.pathname.split("/");

  if (url.pathname === "/healthz") {
    return json(res, 200, { ok: true, schemaVersion: SCHEMA_VERSION, auth: authStatus(), streaming: [...streaming] });
  }
  if (!ready) return json(res, 503, { error: "not authenticated", auth: authStatus() });

  if (kind === "snapshot" && sn) {
    try {
      const cam = (await eufy.getDevice(sn)).camera?.();
      if (!cam?.snapshot) return json(res, 404, { error: "no camera on this device" });
      const { jpeg } = await cam.snapshot();
      res.writeHead(200, { "content-type": "image/jpeg", "content-length": jpeg.length });
      return res.end(jpeg);
    } catch (e) {
      return json(res, 502, { error: String(e?.message ?? e) });
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
      case "device.set":
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
      case "device.set": {
        await eufy.setProperty(msg.sn, msg.name, msg.value);
        return reply({});
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
  go2rtcProc?.kill();
  await closeStreamClients();
  await eufy.disconnect?.();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

main().catch((e) => { console.error("[bridge] fatal:", e); process.exit(1); });
