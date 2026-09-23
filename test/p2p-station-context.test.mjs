import { EventEmitter } from "node:events";
import test from "node:test";
import assert from "node:assert/strict";

import { BRIDGE_P2P_STATION_FRAME, preserveP2PStationContext } from "../src/client.mjs";

test("preserveP2PStationContext publishes station serial before SDK handles the frame", () => {
  const eufy = new EventEmitter();
  const calls = [];
  eufy.onP2PFrame = function (stationSn, frame) {
    calls.push(["original", stationSn, frame]);
  };
  eufy.on(BRIDGE_P2P_STATION_FRAME, (payload) => calls.push(["bridge", payload]));

  assert.equal(preserveP2PStationContext(eufy), true);
  const frame = { commandId: 1151, data: Buffer.from([4]) };
  eufy.onP2PFrame("HB3", frame);

  assert.deepEqual(calls, [
    ["bridge", { stationSn: "HB3", frame }],
    ["original", "HB3", frame],
  ]);
});

test("preserveP2PStationContext fails safely if SDK internals change", () => {
  assert.equal(preserveP2PStationContext(new EventEmitter()), false);
});
