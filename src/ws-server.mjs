// The WebSocket control plane: state, events, and auth over one socket. Attaches to the shared HTTP
// server so a client can reach /ws to drive 2FA/captcha before the bridge is authenticated. Owns the
// client set and the two fan-out helpers (`send`, `broadcast`) that the rest of the bridge publishes
// through — returned so server.mjs can hang them on ctx for auth.mjs / boot.mjs / http-routes.mjs.
import { WebSocketServer } from "ws";

export function createWsServer(ctx, httpServer) {
  const { cfg, eufy, SCHEMA_VERSION, DEBUG, dbg } = ctx;
  const { flags, clients } = ctx.state;

  const send = (ws, obj) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
  };
  const broadcast = (obj) => {
    const s = JSON.stringify(obj);
    for (const ws of clients) if (ws.readyState === ws.OPEN) ws.send(s);
  };

  const wss = new WebSocketServer({ server: httpServer, path: "/ws" });
  wss.on("connection", (ws) => {
    clients.add(ws);
    // On connect, tell the client the schema AND the current auth state, so a frontend knows immediately
    // whether it must drive a 2FA/captcha step before anything else works.
    send(ws, { event: "hello", schemaVersion: SCHEMA_VERSION, auth: ctx.authStatus() });
    ws.on("close", () => clients.delete(ws));
    ws.on("message", (raw) => handleMessage(ws, raw).catch((e) => console.error("[bridge] ws:", e)));
  });

  async function handleMessage(ws, raw) {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return send(ws, { ok: false, error: "bad json" }); }
    const { id, cmd } = msg;
    if (DEBUG) {
      const bits = [`cmd=${cmd}`];
      if (msg.sn != null) bits.push(`sn=${msg.sn}`);
      if (msg.name != null) bits.push(`name=${msg.name}`);
      if (msg.value !== undefined) bits.push(`value=${JSON.stringify(msg.value)}`);
      dbg("ws recv", bits.join(" ")); // NB: 2FA code / captcha (msg.code/msg.captcha) never logged
    }
    const reply = (extra) => send(ws, { id, ok: true, ...extra });
    const fail = (error) => send(ws, { id, ok: false, error: String(error?.message ?? error) });
    try {
      switch (cmd) {
        // ── auth ──
        case "auth.status":
          return reply({ auth: ctx.authStatus() });
        case "auth.submit": {
          // A 2FA code (`code`) or a captcha answer (`captcha`). The pending id/token is held in the SDK.
          if (msg.captcha != null) await ctx.applyLogin(await eufy.solveCaptcha(String(msg.captcha)));
          else if (msg.code != null) await ctx.applyLogin(await eufy.submitVerifyCode(String(msg.code)));
          else return fail("auth.submit needs { code } (2FA) or { captcha } (captcha answer)");
          return reply({ auth: ctx.authStatus() });
        }
        case "auth.retrigger":
          // Re-request a fresh challenge (new captcha image / new 2FA code).
          await ctx.applyLogin(await eufy.login());
          return reply({ auth: ctx.authStatus() });

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
          if (!flags.ready) return fail("not authenticated — query auth.status and complete 2FA/captcha first");
          break;
        default:
          return fail(`unknown cmd: ${cmd}`);
      }
      switch (cmd) {
        case "devices.list": return reply({ devices: await ctx.deviceList() });
        case "device.state": return reply({ device: await ctx.describeDevice(msg.sn) });
        case "device.properties": {
          const dev = await eufy.getDevice(msg.sn);
          return reply({ sn: msg.sn, properties: ctx.propertySpecs(dev) });
        }
        case "device.set": {
          const t0 = Date.now();
          dbg(`device.set → setProperty sn=${msg.sn} name=${msg.name} value=${JSON.stringify(msg.value)}`);
          try {
            await eufy.setProperty(msg.sn, msg.name, msg.value);
            dbg(`device.set OK sn=${msg.sn} name=${msg.name} (${Date.now() - t0}ms)`);
          } catch (e) {
            console.error(`[bridge] device.set FAILED sn=${msg.sn} name=${msg.name} (${Date.now() - t0}ms): ${e?.name ?? "Error"}: ${e?.message ?? e}`);
            throw e; // outer catch surfaces it to the frontend (+ triggers session recovery if kicked)
          }
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
    } catch (e) { if (e?.name === "SessionExpiredError") ctx.maybeRecoverSession(); return fail(e); }
  }

  return { send, broadcast, handleMessage };
}
