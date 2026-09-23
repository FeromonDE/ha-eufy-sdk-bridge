import assert from "node:assert/strict";
import test from "node:test";

import { ARMING_MEMBERS } from "@mega-yfue/eufy-sdk";

import { enableCustomArmingModes } from "../src/arming-patch.mjs";

test("Custom 1/2/3 extend the arming write domain only", () => {
  enableCustomArmingModes();

  assert.deepEqual(ARMING_MEMBERS.mode.args[0].values, [0, 1, 3, 4, 5, 63]);
  assert.equal(ARMING_MEMBERS.mode.args[0].values.includes(2), false);
  assert.equal(ARMING_MEMBERS.mode.args[0].values.includes(6), false);
  assert.equal(ARMING_MEMBERS.mode.args[0].values.includes(47), false);
});

test("Custom 1/2/3 build the same guard-mode payload shape", () => {
  enableCustomArmingModes();

  const ctx = {
    accountName: "user@example.com",
    channel: 0,
    serial: "T8030TEST",
  };

  for (const wire of [3, 4, 5]) {
    assert.deepEqual(ARMING_MEMBERS.mode.write(wire, ctx), {
      kind: "set-payload",
      cmd: 1224,
      payload: { mode_type: wire, user_name: "user@example.com" },
      channel: 0,
      mValue3: 0,
    });
    assert.deepEqual(ARMING_MEMBERS.mode.observation.reflects(wire, ctx), {
      param: 1224,
      expected: wire,
    });
  }
});
