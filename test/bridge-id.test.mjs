// A stable per-install id, so a host can recognise the same bridge reached at two addresses.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadBridgeId } from "../src/bridge-id.mjs";
import { createHttpHandler } from "../src/http-routes.mjs";
import { createState } from "../src/state.mjs";
import { loadConfig } from "../src/config.mjs";

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bridge-id-")), ".bridge-id");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

test("the id is created once and kept across restarts", () => {
  const file = tmp();
  const id = loadBridgeId(file);
  assert.match(id, UUID);
  assert.equal(loadBridgeId(file), id);
});

test("a damaged id file is replaced with a fresh id", () => {
  const file = tmp();
  fs.writeFileSync(file, "not-an-id\n");
  const id = loadBridgeId(file);
  assert.match(id, UUID);
  assert.equal(fs.readFileSync(file, "utf8").trim(), id);
});

test("/healthz reports the bridge id", async () => {
  const state = createState();
  const handler = createHttpHandler({
    ...loadConfig({ EUFY_EMAIL: "x@y.z", EUFY_PASSWORD: "pw" }),
    state,
    bridgeId: "3f2a0000-0000-4000-8000-000000000001",
    authStatus: () => ({ state: "ok" }),
  });
  const body = await new Promise((resolve) => {
    const res = { writeHead() {}, setHeader() {}, end: (b) => resolve(JSON.parse(b)) };
    handler({ url: "/healthz", headers: { host: "x" }, method: "GET" }, res);
  });
  assert.equal(body.bridgeId, "3f2a0000-0000-4000-8000-000000000001");
});
