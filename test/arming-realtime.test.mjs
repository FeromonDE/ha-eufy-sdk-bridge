import assert from "node:assert/strict";
import test from "node:test";

import { createArmingRealtime, guardModeFromP2PFrame, guardModeFromPush } from "../src/arming-realtime.mjs";

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

test("HomeBase P2P CMD_GET_ALARM_MODE 1151 reports mode from byte zero", () => {
  assert.deepEqual(
    guardModeFromP2PFrame("HB3", {
      commandId: 1151,
      data: Buffer.from([4]),
    }),
    { deviceSn: "HB3", mode: 4 },
  );
  assert.deepEqual(
    guardModeFromP2PFrame("HB3", {
      commandId: 1151,
      data: Buffer.from([63]),
    }),
    { deviceSn: "HB3", mode: 63 },
  );
});

test("P2P 1151 broadcasts immediately and overrides stale SDK state", () => {
  const sent = [];
  const logs = [];
  const ctx = {
    state: { armingOverrides: new Map() },
    bumpActivity() {},
    eventLog(line) {
      logs.push(line);
    },
    broadcast(evt) {
      sent.push(evt);
    },
  };
  const rt = createArmingRealtime(ctx);

  assert.equal(
    rt.onP2PArmingFrame("HB3", {
      commandId: 1151,
      data: Buffer.from([5]),
    }),
    true,
  );
  assert.deepEqual(sent[0], {
    event: "armingModeChanged",
    deviceSn: "HB3",
    mode: 5,
    source: "p2p",
  });
  assert.match(logs[0], /CMD_GET_ALARM_MODE 1151/);
  assert.equal(rt.armingModeOverride("HB3", 0), 5);
  assert.equal(rt.armingModeOverride("HB3", 5), undefined);
});

test("raw MODE_SWITCH remains a fallback fast path", () => {
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
      payload: { arming: 3, mode: 3 },
    }),
    true,
  );
  assert.equal(sent[0].mode, 3);
  assert.equal(sent[0].source, "push");
});

test("unrelated P2P and push events are ignored", () => {
  assert.equal(guardModeFromP2PFrame("HB3", { commandId: 1152, data: Buffer.from([3]) }), undefined);
  assert.equal(guardModeFromPush({ eventType: 10, stationSn: "HB3", payload: { arming: 3 } }), undefined);
});


test("cloud arming propertyChanged is translated immediately and deduped", () => {
  const sent = [];
  const logs = [];
  const ctx = {
    state: { armingOverrides: new Map(), timers: { armingPoll: null } },
    bumpActivity() {},
    eventLog(line) {
      logs.push(line);
    },
    broadcast(evt) {
      sent.push(evt);
    },
  };
  const rt = createArmingRealtime(ctx);

  assert.equal(
    rt.onCloudArmingPropertyChanged({
      deviceSn: "HB3",
      property: "armingMode",
      value: 4,
    }),
    true,
  );
  assert.equal(sent.length, 1);
  assert.equal(sent[0].mode, 4);
  assert.equal(sent[0].source, "cloud");
  assert.match(logs[0], /propertyChanged armingMode/);

  assert.equal(
    rt.onCloudArmingPropertyChanged({
      deviceSn: "HB3",
      property: "armingMode",
      value: 4,
    }),
    false,
  );
  assert.equal(sent.length, 1);
});

test("guard-mode poll targets only HomeBase and publishes param 1224 changes", async () => {
  const calls = [];
  const sent = [];
  let mode = 1;
  const ctx = {
    state: { armingOverrides: new Map(), timers: { armingPoll: null } },
    bumpActivity() {},
    eventLog() {},
    broadcast(evt) {
      sent.push(evt);
    },
    eufy: {
      api: {
        async getDeviceParamList(sn) {
          calls.push(sn);
          return {
            params: [
              { param_type: 9999, param_value: "ignore" },
              { param_type: 1224, param_value: String(mode) },
            ],
          };
        },
      },
    },
  };
  const rt = createArmingRealtime(ctx);

  assert.equal(
    rt.startArmingPoll([
      { sn: "HB3", codec: "station", state: { armingMode: 1 } },
      { sn: "CAM1", codec: "camera", state: { armingMode: 1 } },
    ]),
    1,
  );
  clearInterval(ctx.state.timers.armingPoll);
  ctx.state.timers.armingPoll = null;
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(calls, ["HB3"]);
  assert.equal(sent.length, 0);

  mode = 3;
  await rt.pollArmingModes();

  assert.deepEqual(calls, ["HB3", "HB3"]);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], {
    event: "armingModeChanged",
    deviceSn: "HB3",
    mode: 3,
    source: "cloud",
  });

  await rt.pollArmingModes();
  assert.equal(sent.length, 1);
});
