import assert from "node:assert/strict";
import test from "node:test";

import { createArmingRealtime, guardModeFromPush } from "../src/arming-realtime.mjs";

test("MODE_SWITCH uses payload.arming as the selected guard mode", () => {
  assert.deepEqual(
    guardModeFromPush({
      eventType: 9,
      stationSn: "HB3",
      payload: { arming: 3, mode: 1 },
    }),
    { deviceSn: "HB3", mode: 3 },
  );
});

test("Schedule keeps guard mode 2 even when current mode differs", () => {
  assert.deepEqual(
    guardModeFromPush({
      eventType: 9,
      stationSn: "HB3",
      payload: { arming: 2, mode: 0 },
    }),
    { deviceSn: "HB3", mode: 2 },
  );
});

test("raw MODE_SWITCH broadcasts immediately and overrides stale SDK state", () => {
  const sent = [];
  const ctx = {
    state: { armingOverrides: new Map() },
    bumpActivity() {},
    eventLog() {},
    broadcast(evt) {
      sent.push(evt);
    },
  };
  const rt = createArmingRealtime(ctx);

  assert.equal(
    rt.onRawArmingPush({
      eventType: 9,
      stationSn: "HB3",
      payload: { arming: 5, mode: 5 },
    }),
    true,
  );
  assert.deepEqual(sent[0], {
    event: "armingModeChanged",
    deviceSn: "HB3",
    mode: 5,
    source: "push",
  });
  assert.equal(rt.armingModeOverride("HB3", 0), 5);
  assert.equal(rt.armingModeOverride("HB3", 5), undefined);
});

test("non-mode pushes are ignored", () => {
  assert.equal(guardModeFromPush({ eventType: 10, stationSn: "HB3", payload: { arming: 3 } }), undefined);
});
