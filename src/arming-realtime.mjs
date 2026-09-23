// Realtime guard-mode fast path.
//
// The SDK semantic armingModeChanged event waits for cloud convergence. The raw MODE_SWITCH push
// already carries the selected guard mode in payload.arming, so the bridge can update HA immediately.
const MODE_SWITCH = 9;
const VALID_MODES = new Set([0, 1, 2, 3, 4, 5, 6, 47, 63]);
const OVERRIDE_TTL_MS = 10 * 60_000;

function asMode(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const mode = Number(value);
  return Number.isInteger(mode) && VALID_MODES.has(mode) ? mode : undefined;
}

export function guardModeFromPush(event) {
  if (Number(event?.eventType) !== MODE_SWITCH) return undefined;
  const payload = event?.payload ?? {};
  // eufy-security-client maps payload.arming -> station_guard_mode.
  // payload.mode is the current/effective mode and differs while Schedule is selected.
  const mode = asMode(payload.arming ?? payload.station_guard_mode ?? payload.guard_mode);
  if (mode === undefined) return undefined;
  const deviceSn =
    event?.stationSn ?? payload.station_sn ?? payload.stationSN ?? payload.s ?? event?.deviceSn ?? payload.device_sn;
  if (typeof deviceSn !== "string" || !deviceSn) return undefined;
  return { deviceSn, mode };
}

export function createArmingRealtime(ctx) {
  const overrides = ctx.state.armingOverrides;

  function armingModeOverride(sn, sdkMode) {
    const held = overrides.get(sn);
    if (!held) return undefined;
    if (Date.now() - held.at > OVERRIDE_TTL_MS) {
      overrides.delete(sn);
      return undefined;
    }
    if (Number(sdkMode) === held.mode) {
      overrides.delete(sn);
      return undefined;
    }
    return held.mode;
  }

  function onRawArmingPush(event) {
    const update = guardModeFromPush(event);
    if (!update) return false;
    overrides.set(update.deviceSn, { mode: update.mode, at: Date.now() });
    ctx.bumpActivity();
    ctx.eventLog(
      "MODE_SWITCH raw sn=" +
        update.deviceSn +
        " guard=" +
        update.mode +
        " current=" +
        String(event?.payload?.mode ?? "?") +
        " -> HA",
    );
    ctx.broadcast({
      event: "armingModeChanged",
      deviceSn: update.deviceSn,
      mode: update.mode,
      source: "push",
    });
    return true;
  }

  return { armingModeOverride, onRawArmingPush };
}
