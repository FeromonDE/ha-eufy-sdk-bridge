// ha-eufy-sdk bridge — one process that logs into eufy ONCE and exposes the SDK to a frontend.
//
//   WS    :PORT/ws             control, state, events   (the frontend talks to this)
//   HTTP  :PORT/stream/<sn>    live video (Annex-B)     (go2rtc pulls this)
//   HTTP  :PORT/snapshot/<sn>  a JPEG still
//   HTTP  :PORT/healthz        liveness + which cameras are streaming
//
// Video is deliberately NOT on the WS: the WS hands back a URL, and connecting to that URL is what
// starts the camera — disconnecting is what stops it. There is no "is it running" flag to drift.
import http from "node:http";
import { WebSocketServer } from "ws";
import { EufyMega, FileSessionStore, LoginStatus } from "eufy-mega";
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
  // How go2rtc (same container) reaches this bridge's /stream endpoint.
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

/** Build the host-facing summary of one device: identity + capabilities + a stream path for a camera. */
async function describeDevice(sn) {
  const dev = await eufy.getDevice(sn);
  const m = dev.describe();
  const isCamera = m.capabilities.includes("camera") || m.capabilities.includes("video");
  return {
    sn: m.sn,
    name: m.name,
    codec: m.codec,
    capabilities: m.capabilities,
    // Flatten each capability's current reads into one {name: value} bag for a host.
    properties: Object.fromEntries(
      m.details.flatMap((c) => c.reads.map((r) => [r.accessor, dev[c.capability]?.()?.[r.accessor]]).filter(([, v]) => v !== undefined)),
    ),
    stream: isCamera ? `/stream/${m.sn}` : undefined,
  };
}

async function deviceList() {
  const devices = await eufy.getDevices();
  return Promise.all(devices.map((d) => describeDevice(d.sn).catch((e) => ({ sn: d.sn, error: String(e?.message ?? e) }))));
}

// ── HTTP: video + snapshot + health ───────────────────────────────────────────────────────────────
const streaming = new Set();

const httpServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const [, kind, sn] = url.pathname.split("/");

  if (url.pathname === "/healthz") {
    return json(res, 200, { ok: true, schemaVersion: SCHEMA_VERSION, streaming: [...streaming] });
  }

  if (kind === "snapshot" && sn) {
    try {
      const dev = await eufy.getDevice(sn);
      const cam = dev.camera?.();
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
      const dev = await client.getDevice(sn);
      const cam = dev.camera?.();
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

// ── WebSocket: control + state + events ────────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server: httpServer, path: "/ws" });
const clients = new Set();

wss.on("connection", (ws) => {
  clients.add(ws);
  send(ws, { event: "ready", schemaVersion: SCHEMA_VERSION });
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
      case "devices.list": return reply({ devices: await deviceList() });
      case "device.state": return reply({ device: await describeDevice(msg.sn) });
      case "device.set": {
        await eufy.setProperty(msg.sn, msg.name, msg.value);
        return reply({});
      }
      case "stream.start": {
        // Returns URLs; does NOT open the camera — the media connection does that.
        return reply({
          path: `/stream/${msg.sn}`,
          http: `http://${cfg.selfHost}:${cfg.port}/stream/${msg.sn}`,
          rtsp: `rtsp://${cfg.selfHost}:8554/${msg.sn}`,
        });
      }
      case "stream.stop": return reply({}); // advisory; the media connection is the real signal
      default: return fail(`unknown cmd: ${cmd}`);
    }
  } catch (e) { return fail(e); }
}

function send(ws, obj) { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj)); }
function broadcast(obj) { const s = JSON.stringify(obj); for (const ws of clients) if (ws.readyState === ws.OPEN) ws.send(s); }

// ── boot ───────────────────────────────────────────────────────────────────────────────────────────
async function main() {
  const result = await eufy.login();
  if (result.status !== LoginStatus.Ok) {
    console.error(`[bridge] login not OK: ${result.status} — resolve interactively (2FA/captcha) with the SDK CLI, then restart`);
    process.exit(1);
  }
  console.log("[bridge] logged in");

  for (const e of FORWARDED_EVENTS) eufy.on(e, (payload) => broadcast({ event: e, ...payload }));

  const devices = await eufy.getDevices();
  await writeGo2rtcConfig(cfg, devices);
  console.log(`[bridge] ${devices.length} devices; go2rtc config → ${cfg.go2rtcConfig}`);

  httpServer.listen(cfg.port, cfg.host, () => console.log(`[bridge] listening on ${cfg.host}:${cfg.port}`));
}

async function shutdown() {
  await closeStreamClients();
  await eufy.disconnect?.();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

main().catch((e) => { console.error("[bridge] fatal:", e); process.exit(1); });
