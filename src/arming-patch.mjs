import { ARMING_MEMBERS } from "@mega-yfue/eufy-sdk";

const CUSTOM_MODE_WIRE = Object.freeze({
  custom1: 3,
  custom2: 4,
  custom3: 5,
});
const CUSTOM_WIRES = new Set(Object.values(CUSTOM_MODE_WIRE));
const SETTABLE_WIRES = Object.freeze([0, 1, 3, 4, 5, 63]);

let applied = false;

function customWire(value) {
  if (typeof value === "string" && value in CUSTOM_MODE_WIRE) return CUSTOM_MODE_WIRE[value];
  const wire = Number(value);
  return CUSTOM_WIRES.has(wire) ? wire : undefined;
}

/**
 * Extend the pinned SDK's verified arming writer with Custom 1/2/3.
 *
 * Upstream SDK 0.1.0 deliberately restricts guard-mode writes to 0/1/63 even though
 * its read domain includes 3/4/5. The HA alarm-control-panel implementation uses
 * Custom 1/2/3 and these three modes have been live-validated on HomeBase 3.
 * Keep Schedule (2), Off (6), and Geofence (47) blocked.
 */
export function enableCustomArmingModes() {
  if (applied) return;
  applied = true;

  const mode = ARMING_MEMBERS.mode;
  const originalWrite = mode.write;
  const observation = mode.observation;
  const originalReflects = observation?.reflects;

  if (!originalWrite || !mode.args?.[0] || !originalReflects || mode.param == null) {
    throw new Error("Unsupported @mega-yfue/eufy-sdk arming contract");
  }

  mode.args[0].values = SETTABLE_WIRES;

  mode.write = (value, ctx) => {
    const wire = customWire(value);
    if (wire === undefined) return originalWrite(value, ctx);
    if (!ctx.accountName) {
      throw new Error(
        `arming: missing account identity (user_name) [serial=${ctx.serial ?? "?"}]`,
      );
    }
    return {
      kind: "set-payload",
      cmd: mode.param,
      payload: { mode_type: wire, user_name: ctx.accountName },
      channel: ctx.channel,
      mValue3: 0,
    };
  };

  observation.reflects = (value, ctx) => {
    const wire = customWire(value);
    return wire === undefined
      ? originalReflects(value, ctx)
      : { param: mode.param, expected: wire };
  };
}
