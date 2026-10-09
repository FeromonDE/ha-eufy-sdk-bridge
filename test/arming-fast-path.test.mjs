import { test } from "node:test";
import assert from "node:assert/strict";

import { setDeviceProperty } from "../src/ws-server.mjs";

test("armingMode uses device arming.setMode instead of generic eufy.setProperty", async () => {
  const calls = [];
  const ctx = {
    eufy: {
      async getDevice(sn) {
        calls.push(["getDevice", sn]);
        return {
          arming: () => ({
            async setMode(value) {
              calls.push(["setMode", value]);
            },
          }),
        };
      },
      async setProperty(...args) {
        calls.push(["setProperty", ...args]);
      },
    },
  };

  await setDeviceProperty(ctx, "HB1", "armingMode", 4);
  assert.deepEqual(calls, [
    ["getDevice", "HB1"],
    ["setMode", 4],
  ]);
});

test("other properties keep using generic setProperty", async () => {
  const calls = [];
  const ctx = {
    eufy: {
      async getDevice() {
        throw new Error("must not resolve device");
      },
      async setProperty(...args) {
        calls.push(args);
      },
    },
  };

  await setDeviceProperty(ctx, "CAM1", "enabled", true);
  assert.deepEqual(calls, [["CAM1", "enabled", true]]);
});

test("armingMode fails loudly when the device has no arming surface", async () => {
  const ctx = {
    eufy: {
      async getDevice() {
        return { arming: () => undefined };
      },
      async setProperty() {},
    },
  };

  await assert.rejects(() => setDeviceProperty(ctx, "CAM1", "armingMode", 1), /no arming control on CAM1/);
});
