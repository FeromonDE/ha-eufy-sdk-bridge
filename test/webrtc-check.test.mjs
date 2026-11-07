// The boot check reports whether node-datachannel loads, so an arch problem shows without a T9000 session.
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkWebRtcLibrary } from "../src/webrtc-check.mjs";

test("the bundled library loads on this platform", async () => {
  const { ok, line } = await checkWebRtcLibrary();
  assert.equal(ok, true, line);
  assert.match(line, /node-datachannel \d+\.\d+\.\d+, @node-datachannel\/[\w-]+ loaded \(\w+-\w+\)/);
});

test("a failing import is reported with its reason, not thrown", async () => {
  const { ok, line } = await checkWebRtcLibrary(async () => {
    throw new Error("Error loading shared library ld-linux-aarch64.so.1");
  });
  assert.equal(ok, false);
  assert.match(line, /unavailable on .*: Error loading shared library/);
  assert.match(line, /HomeBase S1 Pro \(T9000\)/);
});
