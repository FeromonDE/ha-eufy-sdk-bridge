// Construct the one EufyMega SDK client the bridge logs in with. Kept tiny and dependency-light so the
// heavier modules depend on the instance via `ctx.eufy`, not on how it was built. Event wiring that
// needs other modules (error → session recovery, push liveness) lives in server.mjs, after ctx is whole.
import { EufyMega, FileSessionStore, ConsoleLogger } from "@mega-yfue/eufy-sdk";

/** Build the SDK client from config. `logger` is attached only under BRIDGE_DEBUG_P2P (raw transport logs). */
export function createEufy({ cfg, DEBUG_P2P }) {
  return new EufyMega({
    email: cfg.email,
    password: cfg.password,
    countryCode: cfg.country,
    store: new FileSessionStore(cfg.session),
    pollMs: cfg.pollMs, // undefined → SDK default; changeable live via config.set
    logger: DEBUG_P2P ? new ConsoleLogger("info") : undefined,
  });
}
