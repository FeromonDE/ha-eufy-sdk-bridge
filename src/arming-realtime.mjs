// Realtime guard-mode fast paths.
//
// The SDK semantic armingModeChanged event waits for cloud convergence. HomeBase also reports its
// current alarm mode directly on the persistent P2P control channel as CMD_GET_ALARM_MODE (1151).
// That frame is the preferred fast path; raw MODE_SWITCH push remains a fallback for devices/accounts
// that deliver it.
const MODE_SWITCH = 9;
const CMD_GET_ALARM_MODE = 1151;
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

export function guardModeFromP2PFrame(stationSn, frame) {
  if (Number(frame?.commandId) !== CMD_GET_ALARM_MODE) return undefined;
  if (typeof stationSn !== "string" || !stationSn) return undefined;
  if (!Buffer.isBuffer(frame?.data) || frame.data.length < 1) return undefined;
  const mode = asMode(frame.data.readUInt8(0));
  return mode === undefined ? undefined : { deviceSn: stationSn, mode };
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

  function publish(update, source, detail) {
    overrides.set(update.deviceSn, { mode: update.mode, at: Date.now() });
    ctx.bumpActivity();
    ctx.eventLog(`${detail} sn=${update.deviceSn} mode=${update.mode} -> HA`);
    ctx.broadcast({
      event: "armingModeChanged",
      deviceSn: update.deviceSn,
      mode: update.mode,
      source,
    });
    return true;
  }

  function onRawArmingPush(event) {
    const update = guardModeFromPush(event);
    if (!update) return false;
    return publish(update, "push", "MODE_SWITCH raw");
  }

  function onP2PArmingFrame(stationSn, frame) {
    const update = guardModeFromP2PFrame(stationSn, frame);
    if (!update) return false;
    return publish(update, "p2p", "CMD_GET_ALARM_MODE 1151");
  }

  return { armingModeOverride, onRawArmingPush, onP2PArmingFrame };
}
