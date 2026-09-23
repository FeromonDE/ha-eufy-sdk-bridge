// A failed openReadable() must evict only that camera's cached stream entry so the next request
// builds a fresh P2P session instead of reusing a wedged one.
import { test } from "node:test";
import assert from "node:assert/strict";

import { loadConfig } from "../src/config.mjs";
import { createState } from "../src/state.mjs";
import { dropStreamClient } from "../streams.mjs";
import { createHttpHandler } from "../src/http-routes.mjs";

function setup() {
  const config = loadConfig({ EUFY_EMAIL: "x@y.z", EUFY_PASSWORD: "pw" });
  const state = createState();
  state.flags.ready = true;
  const dropped = [];
  const ctx = {
    ...config,
    state,
    authStatus: () => ({ state: "ok" }),
    broadcast: () => {},
    eventLog: () => {},
    streamCameraFor: async () => ({
      openReadable: async () => {
        throw new Error("P2P connect timeout");
      },
    }),
    dropStreamClient: (sn) => dropped.push(sn),
  };
  return { handler: createHttpHandler(ctx), dropped };
}

async function pull(handler) {
  const out = {};
  const req = { url: "/stream/CAM1", headers: { host: "localhost" }, on() {} };
  const res = {
    writeHead(code) {
      out.code = code;
    },
    end(body) {
      out.body = body;
    },
  };
  await handler(req, res);
  return out;
}

test("failed live open drops the cached per-camera stream entry", async () => {
  const { handler, dropped } = setup();
  const out = await pull(handler);
  assert.equal(out.code, 502);
  assert.deepEqual(dropped, ["CAM1"]);
});

test("dropStreamClient is harmless for a camera that has no cached entry", () => {
  assert.equal(dropStreamClient("NEVER-OPENED"), false);
});
