import { test } from "node:test";
import assert from "node:assert/strict";

import { setDeviceProperty } from "../src/ws-server.mjs";

test("armingMode uses cached Device arming.setMode instead of generic eufy.setProperty", async () => {
  const calls = [];
  const ctx = {
    deviceFor: async (sn) => {
      calls.push(["deviceFor", sn]);
      return {
        arming: () => ({
          setMode: async (value) => {
            calls.push(["setMode", value]);
          },
        }),
      };
    },
    eufy: {
      setProperty: async (...args) => {
        calls.push(["setProperty", ...args]);
      },
    },
  };

  await setDeviceProperty(ctx, "HB1", "armingMode", 4);

  assert.deepEqual(calls, [
    ["deviceFor", "HB1"],
    ["setMode", 4],
  ]);
});

test("other properties keep using generic setProperty", async () => {
  const calls = [];
  const ctx = {
    deviceFor: async () => {
      throw new Error("must not resolve device");
    },
    eufy: {
      setProperty: async (...args) => {
        calls.push(args);
      },
    },
  };

  await setDeviceProperty(ctx, "CAM1", "enabled", true);

  assert.deepEqual(calls, [["CAM1", "enabled", true]]);
});

test("armingMode fails loudly when the cached device has no arming surface", async () => {
  const ctx = {
    deviceFor: async () => ({ arming: () => undefined }),
    eufy: { setProperty: async () => {} },
  };

  await assert.rejects(() => setDeviceProperty(ctx, "CAM1", "armingMode", 1), /no arming control on CAM1/);
});
