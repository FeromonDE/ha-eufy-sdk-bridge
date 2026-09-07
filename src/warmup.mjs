// Startup warm-ups + the on-detection "Last event" image refresh, all reading the on-HomeBase P2P
// database. Best-effort: any failure just leaves the relevant cache smaller / the image stale. Every
// DB read here shares the session's single `dbChunk`/`image` stream, so they MUST NOT overlap — a
// shared lock (`withDbLock`) serialises the face-roster warm, the boot image warm, and every live
// refresh into one at-a-time queue. Kicked off the boot critical path (they don't gate `ready`).
import fs from "node:fs";
import path from "node:path";
import { parseFaceRoster, firstJsonObject } from "./faces.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// How long after a detection to wait before pulling the fresh cover: the HomeBase needs a moment to
// finish writing the new event's crop before `history_record_info` reports it. Also debounces a burst
// (auto-track fires many pushes) down to one refresh. Override with EVENT_IMAGE_REFRESH_DELAY_MS.
const REFRESH_DELAY_MS = Number(process.env.EVENT_IMAGE_REFRESH_DELAY_MS) || 3000;

export function createWarmup(ctx) {
  const { eufy, eventImageDir } = ctx;
  const { faceNames } = ctx.state;

  // ── shared serialisation for every P2P DB read (they share one dbChunk/image stream per session) ──
  let dbChain = Promise.resolve();
  function withDbLock(fn) {
    const result = dbChain.then(fn, fn); // run after the previous op settles, success or failure
    dbChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** The admin/account id the P2P DB queries key off — from a shared device's member record, else the login. */
  async function accountIdOf(devs) {
    return devs.find((d) => d.raw?.member?.admin_user_id)?.raw?.member?.admin_user_id ?? eufy.api?.auth?.userId ?? "";
  }

  /** Sessions come up asynchronously after login — wait (up to ~20s) for at least one to appear. */
  async function awaitSessions() {
    let sessions = eufy.getP2pSessions();
    for (let i = 0; i < 20 && sessions.size === 0; i++) {
      await sleep(1000);
      sessions = eufy.getP2pSessions();
    }
    return sessions;
  }

  // Standard "read the whole table" query the app uses (inner cmd 10000). We only need the newest few
  // rows, so `count` is modest — but ordering isn't guaranteed, so we still sort by `start_time` below.
  const HISTORY_TABLE_QUERY = {
    count: 200,
    start_date: "",
    end_date: "",
    start_id: 0,
    end_id: 1,
    flag: 0,
    need_ai: 1,
    res_unzip: 1,
    update_time: "0",
    start_time: "0",
    alarm_id: "",
  };

  /** The on-HomeBase crop path for a history record — field name varies by firmware, so try each. */
  function cropPathOf(rec) {
    const pl = rec?.payload ?? rec;
    const p = pl?.crop_hb3_path || pl?.crop_path || pl?.thumb_path || pl?.thumbnail_path || pl?.pic_path;
    return typeof p === "string" && p ? p : undefined;
  }

  /** Recency key for a history record (epoch-ish); higher = newer. 0 when the firmware omits it. */
  function recordTime(rec) {
    const pl = rec?.payload ?? {};
    return Number(rec?.start_time ?? rec?.create_time ?? pl.start_time ?? pl.create_time ?? 0) || 0;
  }

  /**
   * Query each device's LATEST event cover over P2P and return `device_sn -> on-HomeBase cover path`
   * (the plain-JPEG crop the /event-image serves).
   *
   * Uses the DIRECT table read of `history_record_info` (inner cmd **10000**, mChannel **255** — the
   * station channel), NOT the old `10013`. Per the reversed P2P catalog (eufy-mega docs/p2p/faces.md)
   * 10013 is only a "sync/poke" that returns a cached "latest" snapshot which never advances as new
   * events complete — which is why the crop came back byte-identical run-to-run and "Last event" never
   * moved; ch0 also returns nothing on a HomeBase (DB reads live on 255). We then pick, per device, the
   * record with the greatest `start_time` and use its crop path.
   *
   * Sent twice (the first can be dropped during handshake). Caller must hold the DB lock.
   */
  async function queryStationCovers(session, accountId) {
    let chunk = "";
    const onChunk = ({ text }) => (chunk += text);
    session.on("dbChunk", onChunk);
    const send = () =>
      session.isConnected &&
      session.queryDatabase("history_record_info", { accountId, innerCmd: 10000, query: HISTORY_TABLE_QUERY });
    send();
    setTimeout(send, 1500);
    await sleep(6000);
    session.off?.("dbChunk", onChunk);

    const records = firstJsonObject(chunk)?.data ?? [];
    // Keep the newest record per device (max start_time), then take its crop path. Ties (or a firmware
    // that omits start_time) fall back to last-wins, matching the old behaviour for that degenerate case.
    const newest = new Map(); // device_sn -> { ts, path }
    for (const rec of records) {
      const dsn = rec?.device_sn;
      const p = cropPathOf(rec);
      if (!dsn || !p) continue;
      const ts = recordTime(rec);
      const cur = newest.get(dsn);
      if (!cur || ts >= cur.ts) newest.set(dsn, { ts, path: p });
    }
    const covers = new Map();
    for (const [dsn, { path: p }] of newest) covers.set(dsn, p);
    return covers;
  }

  /** Request one on-HomeBase cover path over P2P and return its JPEG bytes (≤8s), or undefined. */
  async function fetchImage(session, filePath, accountId) {
    const images = new Map();
    const onImage = ({ file, data }) => {
      if (data?.[0] === 0xff && data?.[1] === 0xd8) images.set(file, data);
    };
    session.on("image", onImage);
    session.requestImage(filePath, { accountId });
    for (let i = 0; i < 40 && !images.has(filePath); i++) await sleep(200);
    session.off?.("image", onImage);
    return images.get(filePath);
  }

  /** Persist bytes to last-event-<sn>.jpg only when they differ from what's on disk; report whether it changed. */
  function persistIfChanged(dsn, data) {
    const file = path.join(eventImageDir, `last-event-${dsn}.jpg`);
    let prev;
    try {
      prev = fs.readFileSync(file);
    } catch {
      prev = undefined;
    }
    if (prev && prev.equals(data)) return false;
    fs.writeFileSync(file, data);
    return true;
  }

  /**
   * Build the face-recognition roster by reading `person_basic_info` off each connected HomeBase over P2P
   * (CMD_DATABASE 1306 / inner cmd 10000, mChannel 255). Faces are account-wide, so every station's rows
   * merge into one map. On any failure the map just stays smaller and `personDetected` falls back to Unknown.
   */
  async function warmFaceRoster() {
    return withDbLock(async () => {
      try {
        const devs = await eufy.getDevices();
        const accountId = await accountIdOf(devs);
        for (const [, session] of await awaitSessions()) {
          for (let i = 0; i < 30 && !session.isConnected; i++) await sleep(500);
          if (!session.isConnected) continue;

          let chunk = "";
          const onChunk = ({ text }) => (chunk += text);
          session.on("dbChunk", onChunk);
          session.requestFaces({ accountId });
          setTimeout(() => session.isConnected && session.requestFaces({ accountId }), 1500);
          await sleep(6000);
          session.off?.("dbChunk", onChunk);

          let added = 0;
          for (const [id, rec] of parseFaceRoster(chunk)) {
            if (!faceNames.has(id)) added++;
            faceNames.set(id, rec);
          }
          if (added) console.log(`[bridge] face roster: +${added} person(s) (${faceNames.size} total)`);
        }
      } catch (e) {
        console.error(`[bridge] warm face roster failed: ${e?.message ?? e}`);
      }
    });
  }

  /**
   * Warm the "Last event" thumbnails from LOCAL (HomeBase) storage, so images are populated on first HA
   * load even before any live push. This is the only startup source for local-storage accounts (the cloud
   * events/list + cover_path are empty without cloud storage), and — because push notifications on such
   * accounts carry no `pic_url` — {@link refreshLastEventImageFor} is also the only LIVE source, so this
   * path and that one share the same helpers.
   */
  async function warmLastEventImages() {
    return withDbLock(async () => {
      try {
        const devs = await eufy.getDevices();
        const accountId = await accountIdOf(devs);
        for (const [, session] of await awaitSessions()) {
          for (let i = 0; i < 30 && !session.isConnected; i++) await sleep(500); // await handshake
          if (!session.isConnected) continue;

          const covers = await queryStationCovers(session, accountId);
          if (!covers.size) continue;

          for (const [dsn, filePath] of covers) {
            const data = await fetchImage(session, filePath, accountId);
            if (data && persistIfChanged(dsn, data)) {
              console.log(`[bridge] warmed last-event image for ${dsn} (${data.length}B, local)`);
            }
          }
        }
      } catch (e) {
        console.error(`[bridge] warm last-event images failed: ${e?.message ?? e}`);
      }
    });
  }

  /**
   * Pull the freshest local cover for ONE device from HomeBase storage and persist it to
   * last-event-<sn>.jpg. This is what actually advances "Last event" on a local-storage account: the SDK's
   * push-thumbnail cache (`camera.snapshotStored()`) stays empty because such accounts' pushes carry no
   * cloud `pic_url`, so /event-image would otherwise serve the boot-warmed image forever. Returns true when
   * the bytes changed (so the caller can nudge HA to re-fetch). Serialised against every other DB read.
   */
  function refreshLastEventImageFor(sn) {
    return withDbLock(async () => {
      if (!sn) return false;
      try {
        const sessions = eufy.getP2pSessions();
        if (!sessions.size) return false;
        const devs = await eufy.getDevices();
        const accountId = await accountIdOf(devs);
        for (const [, session] of sessions) {
          if (!session.isConnected) continue;
          const covers = await queryStationCovers(session, accountId);
          const filePath = covers.get(sn);
          if (!filePath) continue; // this device isn't on this station — try the next
          const data = await fetchImage(session, filePath, accountId);
          if (!data) {
            ctx.eventLog?.(`local refresh: ${sn} — cover fetch returned no image`);
            return false;
          }
          if (persistIfChanged(sn, data)) {
            ctx.eventLog?.(`local refresh: ${sn} → last-event image updated (${data.length}B, local)`);
            return true;
          }
          ctx.eventLog?.(`local refresh: ${sn} — cover unchanged (${data.length}B)`);
          return false;
        }
        ctx.eventLog?.(`local refresh: ${sn} — no local cover found on any connected station`);
        return false;
      } catch (e) {
        console.error(`[bridge] local refresh for ${sn} failed: ${e?.message ?? e}`);
        return false;
      }
    });
  }

  // Debounce per device: a burst of pushes (auto-track fires many) collapses to one delayed refresh,
  // which also gives the HomeBase time to write the new event's cover before we query for it.
  const pendingRefresh = new Map(); // sn -> timer
  function onDetectionRefresh(sn) {
    if (!sn || pendingRefresh.has(sn)) return;
    const timer = setTimeout(() => {
      pendingRefresh.delete(sn);
      void refreshLastEventImageFor(sn).then((changed) => {
        // Tell HA to re-pull /event-image now that the disk file advanced — the detection broadcast that
        // triggered this already fired (and fetched the still-stale image), so without this nudge HA would
        // not update until its next poll.
        if (changed) ctx.broadcast?.({ event: "eventImageUpdated", deviceSn: sn });
      });
    }, REFRESH_DELAY_MS);
    timer.unref?.();
    pendingRefresh.set(sn, timer);
  }

  return { warmFaceRoster, warmLastEventImages, refreshLastEventImageFor, onDetectionRefresh };
}
