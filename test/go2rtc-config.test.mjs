import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { writeGo2rtcConfig } from "../go2rtc-config.mjs";

const cams = [
  { sn: "CAM1", stream: "/stream/CAM1" },
  { sn: "SENSOR1" },
];

async function generate() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "go2rtc-"));
  const file = path.join(dir, "go2rtc.yaml");
  const sns = await writeGo2rtcConfig(
    { go2rtcConfig: file, selfHost: "127.0.0.1", port: 3000 },
    cams,
  );
  return { yaml: fs.readFileSync(file, "utf8"), sns };
}

test("go2rtc consumes the normalized HTTP stream directly without ffmpeg", async () => {
  const { yaml, sns } = await generate();
  assert.deepEqual(sns, ["CAM1"]);
  assert.match(yaml, /CAM1: http:\/\/127\.0\.0\.1:3000\/stream\/CAM1/);
  assert.doesNotMatch(yaml, /ffmpeg:/);
});

test("a device without a stream path is left out", async () => {
  const { yaml } = await generate();
  assert.ok(
    !yaml.includes("SENSOR1"),
    "non-camera devices must not become go2rtc streams",
  );
});
