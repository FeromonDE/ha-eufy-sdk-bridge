// One-time startup warm-ups, both reading the on-HomeBase P2P database. Best-effort: any failure just
// leaves the relevant cache smaller. Run sequentially by the caller (they share a `dbChunk` stream, so
// their accumulators must not overlap) and off the boot critical path (they don't gate `ready`).
import fs from "node:fs";
import path from "node:path";
import { parseFaceRoster, firstJsonObject } from "./faces.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createWarmup(ctx) {
  const { eufy, eventImageDir } = ctx;
  const { faceNames } = ctx.state;

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

  /**
   * Build the face-recognition roster by reading `person_basic_info` off each connected HomeBase over P2P
   * (CMD_DATABASE 1306 / inner cmd 10000, mChannel 255). Faces are account-wide, so every station's rows
   * merge into one map. On any failure the map just stays smaller and `personDetected` falls back to Unknown.
   */
  async function warmFaceRoster() {
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
  }

  /**
   * Warm the "Last event" thumbnails from LOCAL (HomeBase) storage, so images are populated on first HA
   * load even before any live push. Per connected station: query the latest event per device over P2P
   * (history_record_info, cmd 10013 / mChannel 0), then requestImage() each on-HomeBase cover path (plain
   * JPEG) and persist it to <data>/last-event-<sn>.jpg — which /event-image serves. This is the only
   * startup source for local-storage accounts (the cloud events/list + cover_path are empty without cloud storage).
   */
  async function warmLastEventImages() {
    try {
      const devs = await eufy.getDevices();
      const accountId = await accountIdOf(devs);
      for (const [, session] of await awaitSessions()) {
        for (let i = 0; i < 30 && !session.isConnected; i++) await sleep(500); // await handshake
        if (!session.isConnected) continue;

        let chunk = "";
        const onChunk = ({ text }) => (chunk += text);
        session.on("dbChunk", onChunk);
        session.queryDatabase("history_record_info", { accountId, channel: 0, innerCmd: 10013 });
        setTimeout(() => session.isConnected && session.queryDatabase("history_record_info", { accountId, channel: 0, innerCmd: 10013 }), 1500);
        await sleep(6000);
        session.off?.("dbChunk", onChunk);

        const records = firstJsonObject(chunk)?.data ?? [];
        const covers = new Map(); // device_sn -> on-HomeBase cover path
        for (const rec of records) {
          const p = rec?.payload?.crop_hb3_path;
          if (rec?.device_sn && typeof p === "string" && p) covers.set(rec.device_sn, p);
        }
        if (!covers.size) continue;

        const images = new Map(); // file -> jpeg buffer
        const onImage = ({ file, data }) => {
          if (data?.[0] === 0xff && data?.[1] === 0xd8) images.set(file, data);
        };
        session.on("image", onImage);
        for (const [dsn, filePath] of covers) {
          session.requestImage(filePath, { accountId });
          for (let i = 0; i < 40 && !images.has(filePath); i++) await sleep(200); // ≤8s per image
          const data = images.get(filePath);
          if (data) {
            fs.writeFileSync(path.join(eventImageDir, `last-event-${dsn}.jpg`), data);
            console.log(`[bridge] warmed last-event image for ${dsn} (${data.length}B, local)`);
          }
        }
        session.off?.("image", onImage);
      }
    } catch (e) {
      console.error(`[bridge] warm last-event images failed: ${e?.message ?? e}`);
    }
  }

  return { warmFaceRoster, warmLastEventImages };
}
