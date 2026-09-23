// Session-per-streaming-camera.
//
// Each camera gets its own EufyMega instance because HomeBase media channel attribution is not reliable
// enough to share one media session across simultaneous cameras. These stream clients are intentionally
// "control quiet": autoRealtime is off, so they do not open their own push/MQTT/poll background planes.
// A client and its resolved Device/camera surface are cached per serial; none of that opens video by itself.
// The camera wakes only when openReadable() is called by /stream/<sn>.
import { EufyMega, FileSessionStore, LoginStatus } from "@mega-yfue/eufy-sdk";

const entries = new Map(); // sn -> { client, device, camera }
const pending = new Map(); // sn -> Promise<entry>

/** Resolve and cache one dedicated stream client + Device/camera surface without starting live media. */
async function streamEntryFor(sn, cfg) {
  const held = entries.get(sn);
  if (held) return held;
  const inFlight = pending.get(sn);
  if (inFlight) return inFlight;

  const load = (async () => {
    const client = new EufyMega({
      email: cfg.email,
      password: cfg.password,
      countryCode: cfg.country,
      store: new FileSessionStore(cfg.session), // shared token; hydrate, do not create a second login
      autoRealtime: false, // no second push/poll/P2P background lifecycle
      stateSnapshotMs: 0,
    });
    client.on("error", (e) => console.error(`[bridge] stream(${sn}) sdk error: ${e?.message ?? e}`));

    const result = await client.login();
    if (result.status !== LoginStatus.Ok)
      throw new Error(`stream client for ${sn} could not hydrate session (${result.status})`);

    const device = await client.getDevice(sn);
    const camera = device.camera?.();
    if (!camera?.openReadable) {
      await client.disconnect?.().catch(() => {});
      throw new Error(`no live video on device ${sn}`);
    }

    const entry = { client, device, camera };
    entries.set(sn, entry);
    return entry;
  })();

  pending.set(sn, load);
  try {
    return await load;
  } finally {
    pending.delete(sn);
  }
}

/** Return a cached camera surface; this does NOT start the video feed. */
export async function streamCameraFor(sn, cfg) {
  return (await streamEntryFor(sn, cfg)).camera;
}

/**
 * Resolve stream clients for known cameras ahead of the first viewer.
 * This hydrates login + resolves Device/camera metadata only; autoRealtime:false means no P2P session and
 * no live feed is opened, so battery cameras stay asleep.
 */
export async function prepareStreamClients(sns, cfg) {
  const settled = await Promise.allSettled(sns.map((sn) => streamEntryFor(sn, cfg)));
  for (let i = 0; i < settled.length; i++) {
    const result = settled[i];
    if (result.status === "rejected")
      console.error(`[bridge] stream(${sns[i]}) prepare failed: ${result.reason?.message ?? result.reason}`);
  }
}

/**
 * Forget one cached stream entry after a failed live open.
 *
 * A per-camera entry otherwise lives for the whole bridge process. If its P2P session wedges, every
 * later open would reuse the same dead client until the bridge is restarted. Dropping only this camera
 * keeps the other cached stream clients untouched; the next request rebuilds a fresh session.
 */
export function dropStreamClient(sn) {
  const entry = entries.get(sn);
  if (!entry) return false;
  entries.delete(sn);
  void entry.client.disconnect?.().catch(() => {}); // best-effort; the next open builds a new client
  return true;
}

/** Tear down every stream client (on shutdown). */
export async function closeStreamClients() {
  await Promise.all([...entries.values()].map(({ client }) => client.disconnect?.().catch(() => {})));
  entries.clear();
  pending.clear();
}
