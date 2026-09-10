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
