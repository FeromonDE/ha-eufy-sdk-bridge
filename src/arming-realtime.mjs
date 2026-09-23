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
const ARMING_POLL_MS = 5_000;

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
  const lastModes = new Map();
  let stationSns = [];

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
    if (lastModes.get(update.deviceSn) === update.mode) return false;
    lastModes.set(update.deviceSn, update.mode);
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

  function onCloudArmingPropertyChanged(change) {
    if (change?.property !== "armingMode") return false;
    const deviceSn = change?.deviceSn;
    const mode = asMode(change?.value);
    if (typeof deviceSn !== "string" || !deviceSn || mode === undefined) return false;
    return publish({ deviceSn, mode }, "cloud", "propertyChanged armingMode");
  }

  /**
   * A remote Eufy-app mode change is not guaranteed to generate MODE_SWITCH or an unsolicited 1151 on
   * our second client session. Poll only the wired HomeBase control plane every five seconds instead of
   * shrinking the account-wide cloud poll. Also touch the cached property: if the P2P session is absent
   * or a firmware ignores the query, the SDK's 15 s read-through cache performs a targeted cloud refresh,
   * whose propertyChanged event is translated above.
   */
  function pollArmingModes() {
    for (const sn of stationSns) {
      try {
        ctx.requestP2PArmingMode?.(sn);
      } catch (e) {
        ctx.dbg?.(`arming poll P2P failed sn=${sn}: ${e?.message ?? e}`);
      }
      // Non-blocking. SDK coalesces and rate-limits this to its cache TTL (15 s by default).
      ctx.cachedDevice?.(sn)?.getProperty?.("armingMode");
    }
  }

  function startArmingPoll(summaries) {
    const stations = (summaries ?? []).filter((d) => d?.codec === "station");
    stationSns = stations.map((d) => d.sn);
    for (const station of stations) {
      const mode = asMode(station?.state?.armingMode);
      if (mode !== undefined) lastModes.set(station.sn, mode);
    }
    if (!stationSns.length) return 0;
    pollArmingModes();
    if (!ctx.state.timers.armingPoll) {
      ctx.state.timers.armingPoll = setInterval(pollArmingModes, ARMING_POLL_MS);
      ctx.state.timers.armingPoll.unref?.();
    }
    return stationSns.length;
  }

  return {
    armingModeOverride,
    onRawArmingPush,
    onP2PArmingFrame,
    onCloudArmingPropertyChanged,
    pollArmingModes,
    startArmingPoll,
  };
}
