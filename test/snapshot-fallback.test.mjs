// /snapshot should avoid waking battery cameras in auto mode and should use the persisted event JPEG.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { loadConfig } from "../src/config.mjs";
import { createState } from "../src/state.mjs";
import { createHttpHandler } from "../src/http-routes.mjs";

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x01, 0xff, 0xd9]);

function setup({ live = "ok", stored = "ok", env = {}, persist = true, battery = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snapshot-"));
  if (persist) fs.writeFileSync(path.join(dir, "last-event-CAM1.jpg"), JPEG);
  const calls = { live: 0, stored: 0 };

  const cam = {
    async snapshotLive() {
      calls.live++;
      if (live === "throw") throw new Error("P2P unreachable");
      return { jpeg: Buffer.from("LIVE") };
    },
    async snapshotStored() {
      calls.stored++;
      if (stored === "throw") {
        const e = new Error("No stored snapshot is available");
        e.reason = "not-observed";
        throw e;
      }
      return Buffer.from("STORED");
    },
  };

  const config = loadConfig({ EUFY_EMAIL: "x@y.z", EUFY_PASSWORD: "pw", ...env });
  const state = createState();
  state.flags.ready = true;
  const device = {
    camera: () => cam,
    describe: () => ({
      sn: "CAM1",
      capabilities: battery ? ["camera", "video", "battery"] : ["camera", "video"],
    }),
  };
  const ctx = {
    ...config,
    state,
    eventImageDir: dir,
    eventLog: () => {},
    authStatus: () => ({ state: "ok" }),
    deviceFor: async () => device,
  };
  return { handler: createHttpHandler(ctx), calls };
}

async function get(handler) {
  const out = {};
  const res = {
    writeHead(code, headers) {
      out.code = code;
      out.headers = headers;
    },
    end(body) {
      out.body = body;
    },
  };
  await handler({ url: "/snapshot/CAM1", headers: { host: "localhost" }, on() {} }, res);
  return out;
}

test("SNAPSHOT_LIVE defaults to auto", () => {
  assert.equal(loadConfig({ EUFY_EMAIL: "x@y.z", EUFY_PASSWORD: "pw" }).cfg.snapshotLive, "auto");
});

test("auto serves disk snapshot without waking a battery camera", async () => {
  const { handler, calls } = setup({ battery: true, live: "throw", stored: "throw" });
  const out = await get(handler);
  assert.equal(out.code, 200);
  assert.deepEqual(out.body, JPEG);
  assert.equal(calls.live, 0);
  assert.equal(calls.stored, 0);
});

test("auto still takes a fresh live snapshot from a mains camera", async () => {
  const { handler, calls } = setup({ battery: false });
  const out = await get(handler);
  assert.equal(out.code, 200);
  assert.equal(out.body.toString(), "LIVE");
  assert.equal(calls.live, 1);
  assert.equal(calls.stored, 0);
});

test("SNAPSHOT_LIVE=0 never takes a live snapshot", async () => {
  const { handler, calls } = setup({ env: { SNAPSHOT_LIVE: "0" }, battery: false });
  const out = await get(handler);
  assert.equal(out.code, 200);
  assert.deepEqual(out.body, JPEG);
  assert.equal(calls.live, 0);
  assert.equal(calls.stored, 0);
});

test("SNAPSHOT_LIVE=1 forces a live snapshot on a battery camera", async () => {
  const { handler, calls } = setup({ env: { SNAPSHOT_LIVE: "1" }, battery: true });
  const out = await get(handler);
  assert.equal(out.code, 200);
  assert.equal(out.body.toString(), "LIVE");
  assert.equal(calls.live, 1);
});

test("persisted snapshot is final fallback when live and retained snapshot both fail", async () => {
  const { handler, calls } = setup({ battery: false, live: "throw", stored: "throw" });
  const out = await get(handler);
  assert.equal(out.code, 200);
  assert.deepEqual(out.body, JPEG);
  assert.equal(calls.live, 1);
  assert.equal(calls.stored, 1);
});
