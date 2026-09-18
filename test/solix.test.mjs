import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import { loadConfig } from "../src/config.mjs";
import { createState } from "../src/state.mjs";
import { createSolix } from "../src/solix.mjs";
import { createWsServer } from "../src/ws-server.mjs";

const baseEnv = { EUFY_EMAIL: "x@y.z", EUFY_PASSWORD: "pw" };

test("config: SOLIX_* enables the solix block; absent ⇒ undefined", () => {
  assert.equal(loadConfig(baseEnv).cfg.solix, undefined);

  const cfg = loadConfig({ ...baseEnv, SOLIX_EMAIL: "s@a.co", SOLIX_PASSWORD: "sp", EUFY_COUNTRY: "GB" }).cfg;
  assert.equal(cfg.solix.email, "s@a.co");
  assert.equal(cfg.solix.country, "GB"); // falls back to EUFY_COUNTRY
  assert.match(cfg.solix.session, /\.solix-session\.json$/);

  // needs BOTH email and password
  assert.equal(loadConfig({ ...baseEnv, SOLIX_EMAIL: "s@a.co" }).cfg.solix, undefined);
});

test("ws Solix controls: disabled rejection, missing fields, happy path, setSocLimits validation", async () => {
  const ctx = { ...loadConfig(baseEnv), state: createState(), eufy: {} };
  Object.assign(ctx, createWsServer(ctx, http.createServer()));
  const sent = [];
  const ws = { readyState: 1, OPEN: 1, send: (s) => sent.push(JSON.parse(s)) };
  const call = (m) => ctx.handleMessage(ws, Buffer.from(JSON.stringify(m)));
  const last = () => sent[sent.length - 1];

  // No ctx.solixSetSocLimits handler ⇒ uniform "not enabled" rejection.
  await call({ id: 1, cmd: "solix.setSocLimits", deviceSn: "AE", chargeUpperLimit: 90 });
  assert.equal(last().ok, false);
  assert.match(last().error, /solix is not enabled/);

  // Enable by attaching a fake handler (createWsServer closes over ctx, read at call time).
  let saw;
  ctx.solixSetSocLimits = async (sn, changes) => {
    saw = { sn, changes };
    return { ...changes, ok: 1 };
  };

  // Missing deviceSn ⇒ usage hint that names the command.
  await call({ id: 2, cmd: "solix.setSocLimits", chargeUpperLimit: 90 });
  assert.match(last().error, /solix\.setSocLimits needs/);

  // deviceSn present but neither limit ⇒ the command's own OR-validation fires.
  await call({ id: 3, cmd: "solix.setSocLimits", deviceSn: "AE" });
  assert.equal(last().ok, false);
  assert.match(last().error, /solix\.setSocLimits needs/);

  // Happy path: handler gets numeric changes; reply echoes deviceSn + the merged params.
  await call({ id: 4, cmd: "solix.setSocLimits", deviceSn: "AE", dischargeLowerLimit: "10", chargeUpperLimit: 95 });
  assert.deepEqual(saw, { sn: "AE", changes: { dischargeLowerLimit: 10, chargeUpperLimit: 95 } });
  assert.equal(last().ok, true);
  assert.equal(last().deviceSn, "AE");
  assert.deepEqual(last().params, { dischargeLowerLimit: 10, chargeUpperLimit: 95, ok: 1 });
});

test("createSolix is a no-op when solix is not configured, and WS reports disabled", async () => {
  const config = loadConfig(baseEnv);
  const ctx = { ...config, state: createState(), eufy: {} };
  Object.assign(ctx, createSolix(ctx)); // returns {} → no startSolix/solixStatus
  assert.equal(ctx.startSolix, undefined);

  const httpServer = http.createServer();
  Object.assign(ctx, createWsServer(ctx, httpServer));
  const sent = [];
  const ws = { readyState: 1, OPEN: 1, send: (s) => sent.push(JSON.parse(s)) };
  await ctx.handleMessage(ws, Buffer.from(JSON.stringify({ id: 1, cmd: "solix.status" })));
  await ctx.handleMessage(ws, Buffer.from(JSON.stringify({ id: 2, cmd: "solix.devices" })));
  const status = sent.find((m) => m.id === 1);
  const devices = sent.find((m) => m.id === 2);
  assert.deepEqual(status.solix, { enabled: false, state: "disabled", deviceCount: 0 });
  assert.deepEqual(devices.devices, []);
  httpServer.close();
});
