import test from "node:test";
import assert from "node:assert/strict";

import { requestP2PArmingMode } from "../src/client.mjs";

test("requestP2PArmingMode sends cmd 1151 only on an already-connected station session", () => {
  const sent = [];
  const session = {
    isConnected: true,
    sendCommand(cmd) {
      sent.push(cmd);
    },
  };
  const eufy = {
    p2p: {
      getSessions() {
        return new Map([["HB3", session]]);
      },
    },
  };

  assert.equal(requestP2PArmingMode(eufy, "HB3"), true);
  assert.deepEqual(sent, [1151]);
});

test("requestP2PArmingMode does not open or use a disconnected station", () => {
  let called = 0;
  const eufy = {
    p2p: {
      getSessions() {
        return new Map([
          [
            "HB3",
            {
              isConnected: false,
              sendCommand() {
                called++;
              },
            },
          ],
        ]);
      },
    },
  };

  assert.equal(requestP2PArmingMode(eufy, "HB3"), false);
  assert.equal(requestP2PArmingMode(eufy, "MISSING"), false);
  assert.equal(called, 0);
});
