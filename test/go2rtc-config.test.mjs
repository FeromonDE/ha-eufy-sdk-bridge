import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { writeGo2rtcConfig } from "../go2rtc-config.mjs";

test("go2rtc consumes the normalized HTTP stream directly without ffmpeg", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "eufy-go2rtc-"));
  try {
    const file = path.join(dir, "go2rtc.yaml");
    await writeGo2rtcConfig(
      { selfHost: "127.0.0.1", port: 3000, go2rtcConfig: file },
      [{ sn: "CAM1", stream: "/stream/CAM1" }],
    );
    const yaml = await readFile(file, "utf8");
    assert.match(yaml, /CAM1: http:\/\/127\.0\.0\.1:3000\/stream\/CAM1/);
    assert.doesNotMatch(yaml, /ffmpeg:/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
