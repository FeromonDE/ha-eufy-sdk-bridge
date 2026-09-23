// Construct the one EufyMega SDK client the bridge logs in with. Kept tiny and dependency-light so the
// heavier modules depend on the instance via `ctx.eufy`, not on how it was built. Event wiring that
// needs other modules (error → session recovery, push liveness) lives in server.mjs, after ctx is whole.
import { EufyMega, FileSessionStore, ConsoleLogger } from "@mega-yfue/eufy-sdk";

export const BRIDGE_P2P_STATION_FRAME = "bridgeP2PStationFrame";
const CMD_GET_ALARM_MODE = 1151;

/**
 * Ask one already-connected HomeBase for its current guard mode.
 *
 * The pinned SDK exposes the live session map on its runtime P2P router, while P2PSession.sendCommand
 * is TypeScript-private only (a normal method in the published JS). We deliberately do not open a
 * session here: wired HomeBases are kept warm by auto-realtime, and a fast polling loop must never turn
 * an offline station into a repeated reconnect/broadcast storm.
 */
export function requestP2PArmingMode(eufy, stationSn) {
  const session = eufy?.p2p?.getSessions?.().get(stationSn);
  if (!session?.isConnected || typeof session.sendCommand !== "function") return false;
  session.sendCommand(CMD_GET_ALARM_MODE);
  return true;
}

/**
 * Preserve the station serial on raw P2P frames.
 *
 * SDK 0.1.0 receives `onP2PFrame(stationSn, frame)` internally but publishes only `emit("p2p", frame)`,
 * discarding the station identity. Guard-mode cmd 1151 is station-scoped, so the bridge cannot attribute
 * it correctly (especially with multiple HomeBases) from the public event alone.
 *
 * TypeScript's `private onP2PFrame` is a normal runtime method in the pinned package, so wrap that exact
 * boundary and publish a bridge-local event before handing the frame back to the SDK unchanged.
 */
export function preserveP2PStationContext(eufy) {
  const original = eufy?.onP2PFrame;
  if (typeof original !== "function") return false;
  eufy.onP2PFrame = function (stationSn, frame) {
    this.emit(BRIDGE_P2P_STATION_FRAME, { stationSn, frame });
    return original.call(this, stationSn, frame);
  };
  return true;
}

/** Build the SDK client from config. `logger` is attached only under BRIDGE_DEBUG_P2P (raw transport logs). */
export function createEufy({ cfg, DEBUG_P2P }) {
  const eufy = new EufyMega({
    email: cfg.email,
    password: cfg.password,
    countryCode: cfg.country,
    store: new FileSessionStore(cfg.session),
    pollMs: cfg.pollMs, // undefined → SDK default; changeable live via config.set
    // Event pre-warm is OFF by default (`[]` = no event opens P2P speculatively) so a battery camera's
    // radio isn't held open ~28s per doorbell/person/pet/package event. BRIDGE_PREWARM=1 → undefined,
    // which lets the SDK use its default high-intent pre-warm events.
    prewarmEvents: cfg.prewarm ? undefined : [],
    logger: DEBUG_P2P ? new ConsoleLogger("info") : undefined,
  });
  if (!preserveP2PStationContext(eufy)) {
    console.warn("[bridge] SDK raw P2P station context hook unavailable — realtime guard-mode 1151 disabled");
  }
  return eufy;
}
