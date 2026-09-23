// Battery-saving stream lifecycle. Keep a camera's P2P live feed only while it's worth streaming: if no
// detection arrives for cfg.streamIdleMs, tear the feed down AND suspend reopening (go2rtc's HTTP
// source then receives a 503 until the suspension lifts). The suspension lifts on the next detection OR once the consumer stops
// pulling — so a stuck 24/7 consumer keeps the radio off while a viewer that returns is served at once.
// Separately, turn a BATTERY camera's native `rtspStream` publish OFF when it's been idle, since that
// publishes continuously and flattens the battery even when nobody consumes it.

export function createStreamIdle(ctx) {
  const { cfg, eufy, SUSPEND_RELEASE_MS } = ctx;
  const { flags } = ctx.state;
  const { lastDetect, activeStreams, idleSuspended, lastPullAttempt, rtspLastActive } = ctx.state;

  /** Record a detection and lift any idle-suspension so the stream may reopen on the next go2rtc pull. */
  function noteDetection(sn) {
    if (!sn) return;
    const now = Date.now();
    lastDetect.set(sn, now);
    rtspLastActive.set(sn, now); // a detection counts as activity for the battery rtspStream auto-off
    if (idleSuspended.delete(sn)) console.log(`[bridge] stream(${sn}) idle-suspension lifted by detection`);
  }

  /**
   * Battery-saver sweep: turn the device's native `rtspStream` publish OFF on a BATTERY camera that has
   * been idle (no detection, no active bridge stream) for cfg.rtspIdleOffMs. Uses cached state (no cloud call).
   */
  async function rtspIdleSweep() {
    if (!cfg.rtspIdleOffMs || !flags.ready || flags.recovering) return;
    const now = Date.now();
    let devices;
    try {
      devices = await ctx.deviceList();
    } catch {
      return;
    }
    for (const d of devices) {
      const sn = d.sn;
      if (!(d.capabilities ?? []).includes("battery")) continue; // battery cameras only
      if (d.state?.rtspStream !== true) continue; // only if currently publishing
      if (activeStreams.has(sn)) {
        rtspLastActive.set(sn, now);
        continue;
      } // being streamed = active
      const lastSeen = rtspLastActive.get(sn);
      if (lastSeen === undefined) {
        rtspLastActive.set(sn, now);
        continue;
      } // give a full window from first sight
      if (now - lastSeen < cfg.rtspIdleOffMs) continue;
      console.log(
        `[bridge] ${sn} battery + rtspStream idle ${Math.round((now - lastSeen) / 1000)}s — turning rtspStream OFF (battery-save)`,
      );
      try {
        await eufy.setProperty(sn, "rtspStream", false);
        rtspLastActive.set(sn, now); // reset so we don't re-fire before the state refreshes
      } catch (e) {
        console.error(`[bridge] ${sn} rtspStream auto-off failed: ${e?.message ?? e}`);
      }
    }
  }

  /** Periodic sweep: auto-off any active feed whose last detection (or open, whichever is later) is stale. */
  function streamIdleTick() {
    if (!cfg.streamIdleMs) return;
    const now = Date.now();
    // Auto-off any actively-pulled feed that has seen no detection for the whole idle window.
    for (const [sn, st] of activeStreams) {
      const lastSeen = Math.max(st.startedAt, lastDetect.get(sn) ?? 0);
      if (now - lastSeen >= cfg.streamIdleMs) {
        console.log(`[bridge] stream(${sn}) idle ${Math.round((now - lastSeen) / 1000)}s (no detection) — auto-off`);
        idleSuspended.add(sn);
        lastPullAttempt.set(sn, now); // it was being pulled right now; start the "consumer gave up" clock fresh
        st.feed.destroy(); // fires the feed's cleanup, which drops it from activeStreams/streaming
      }
    }
    // Lift a suspension once the consumer stops asking: go2rtc only pulls /stream while HA has a viewer,
    // so no pull for SUSPEND_RELEASE_MS means nobody's watching — let the next genuine open succeed
    // without waiting for motion. A stuck consumer (recording / always-on card) keeps pulling into the
    // 503, so it stays suspended and the camera's radio stays off.
    for (const sn of idleSuspended) {
      if (now - (lastPullAttempt.get(sn) ?? 0) >= SUSPEND_RELEASE_MS) {
        idleSuspended.delete(sn);
        console.log(`[bridge] stream(${sn}) idle-suspension lifted — consumer stopped pulling`);
      }
    }
  }

  return { noteDetection, streamIdleTick, rtspIdleSweep };
}
