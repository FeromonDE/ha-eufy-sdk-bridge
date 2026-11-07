// eufy echoes the auth token in some errors; the bridge must not print or return it (ha-eufy-sdk-addon#46).
import { test } from "node:test";
import assert from "node:assert/strict";
import { redactSecrets, installConsoleRedaction } from "../src/redact.mjs";
import { createHttpHandler } from "../src/http-routes.mjs";
import { createState } from "../src/state.mjs";
import { loadConfig } from "../src/config.mjs";

const SIGN_ERROR = "RTC sign for T9000P2 refused: HTTP 401 code 401 token not exist, token = abcDEF123.xyz";

test("an echoed token value is redacted, the rest of the message kept", () => {
  assert.equal(
    redactSecrets(SIGN_ERROR),
    "RTC sign for T9000P2 refused: HTTP 401 code 401 token not exist, token = <redacted>",
  );
  assert.equal(redactSecrets("token=abc123 and more"), "token=<redacted> and more");
});

test("a JSON field named token is left alone", () => {
  const body = JSON.stringify({ token: "keep-me", note: "ok" });
  assert.equal(redactSecrets(body), body);
});

test("console output is redacted, including Error messages", () => {
  const lines = [];
  const target = { log: (...a) => lines.push(a), info() {}, warn() {}, error: (...a) => lines.push(a), debug() {} };
  installConsoleRedaction(target);
  target.log(`[bridge] stream(SN) open failed (#1): ${SIGN_ERROR}`);
  target.error(new Error(SIGN_ERROR));
  assert.ok(!JSON.stringify(lines.map((l) => l.map(String))).includes("abcDEF123"));
  assert.match(String(lines[1][0]), /token = <redacted>/);
});

test("an HTTP error body carrying an echoed token is redacted", async () => {
  const state = createState();
  state.flags.ready = true;
  state.streamBackoff.set("SN", { until: Date.now() + 60_000, streak: 1, reason: SIGN_ERROR });
  const handler = createHttpHandler({
    ...loadConfig({ EUFY_EMAIL: "x@y.z", EUFY_PASSWORD: "pw" }),
    state,
    streamBackoffMs: () => 60_000,
    eventLog: () => {},
  });
  const body = await new Promise((resolve) => {
    const res = { writeHead() {}, setHeader() {}, end: (b) => resolve(String(b)), once() {}, off() {} };
    handler({ url: "/stream/SN", headers: { host: "x" }, method: "GET", socket: {}, once() {}, on() {} }, res);
  });
  assert.ok(!body.includes("abcDEF123"), body);
  assert.match(body, /token = <redacted>/);
});
