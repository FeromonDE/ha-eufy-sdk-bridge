// Failure-backoff for /stream opens: after a failed open (P2P unreachable), the bridge must refuse to
// reopen for an exponentially-growing window so go2rtc's ~30s ffmpeg retries don't wake the camera radio
// every cycle. Cleared on a successful open or a detection. See stream-idle.mjs + http-routes.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createStreamIdle } from "../src/stream-idle.mjs";
import { createState } from "../src/state.mjs";
import { loadConfig, STREAM_FAIL_BACKOFF_MAX_MS } from "../src/config.mjs";

// A stream-idle unit under a controllable clock. Returns the factory result + a `tick(ms)` clock advance.
function build(streamFailBackoffMs = 30_000) {
  const state = createState();
  const ctx = {
    cfg: { streamFailBackoffMs, streamIdleMs: 300_000 },
    SUSPEND_RELEASE_MS: 30_000,
    STREAM_FAIL_BACKOFF_MAX_MS,
    state,
    eufy: {},
  };
  const idle = createStreamIdle(ctx);
  let now = 1_000_000;
  const realNow = Date.now;
  Date.now = () => now;
  return { idle, state, advance: (ms) => (now += ms), restore: () => (Date.now = realNow) };
}

test("a failed open arms backoff; a pull inside the window is refused without a radio wake", () => {
  const { idle, advance, restore } = build();
  try {
    assert.equal(idle.streamBackoffMs("SN1"), 0, "no backoff before any failure");
    idle.noteStreamFailure("SN1");
    assert.equal(idle.streamBackoffMs("SN1"), 30_000, "first failure ⇒ base 30s");
    advance(29_000);
    assert.equal(idle.streamBackoffMs("SN1"), 1_000, "still backing off inside the window");
  } finally {
    restore();
  }
});

test("backoff doubles per consecutive failure and caps at the max", () => {
  const { idle, advance, restore } = build();
  try {
    idle.noteStreamFailure("SN1");
    assert.equal(idle.streamBackoffMs("SN1"), 30_000); // #1: 30s
    advance(30_000);
    assert.equal(idle.streamBackoffMs("SN1"), 0); // window elapsed → one attempt allowed
    idle.noteStreamFailure("SN1");
    assert.equal(idle.streamBackoffMs("SN1"), 60_000); // #2: 60s
    advance(60_000);
    idle.noteStreamFailure("SN1");
    assert.equal(idle.streamBackoffMs("SN1"), 120_000); // #3: 120s
    // Many more failures never exceed the cap.
    for (let i = 0; i < 10; i++) {
      advance(STREAM_FAIL_BACKOFF_MAX_MS);
      idle.noteStreamFailure("SN1");
    }
    assert.equal(idle.streamBackoffMs("SN1"), STREAM_FAIL_BACKOFF_MAX_MS);
  } finally {
    restore();
  }
});

test("a successful open clears the backoff immediately", () => {
  const { idle, restore } = build();
  try {
    idle.noteStreamFailure("SN1");
    assert.ok(idle.streamBackoffMs("SN1") > 0);
    idle.noteStreamOpened("SN1");
    assert.equal(idle.streamBackoffMs("SN1"), 0);
  } finally {
    restore();
  }
});

test("a detection clears the backoff (camera is reachable, let a viewer in at once)", () => {
  const { idle, restore } = build();
  try {
    idle.noteStreamFailure("SN1");
    assert.ok(idle.streamBackoffMs("SN1") > 0);
    idle.noteDetection("SN1");
    assert.equal(idle.streamBackoffMs("SN1"), 0);
  } finally {
    restore();
  }
});

test("streamFailBackoffMs=0 disables backoff entirely", () => {
  const { idle, state, restore } = build(0);
  try {
    idle.noteStreamFailure("SN1");
    assert.equal(idle.streamBackoffMs("SN1"), 0);
    assert.equal(state.streamBackoff.size, 0, "no state recorded when disabled");
  } finally {
    restore();
  }
});

test("STREAM_FAIL_BACKOFF_MS config: default, custom, and 0-to-disable", () => {
  const base = { EUFY_EMAIL: "x@y.z", EUFY_PASSWORD: "pw" };
  assert.equal(loadConfig(base).cfg.streamFailBackoffMs, 30_000);
  assert.equal(loadConfig({ ...base, STREAM_FAIL_BACKOFF_MS: "5000" }).cfg.streamFailBackoffMs, 5_000);
  assert.equal(loadConfig({ ...base, STREAM_FAIL_BACKOFF_MS: "0" }).cfg.streamFailBackoffMs, 0);
});
