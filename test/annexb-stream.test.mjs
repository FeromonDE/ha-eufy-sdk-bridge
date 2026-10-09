import assert from "node:assert/strict";
import test from "node:test";

import { normalizeAnnexB, splitAnnexBNals } from "../src/annexb-stream.mjs";

const s3 = (...bytes) => Buffer.from([0, 0, 1, ...bytes]);
const s4 = (...bytes) => Buffer.from([0, 0, 0, 1, ...bytes]);

test("Annex-B splitter accepts mixed 3- and 4-byte start codes", () => {
  const nals = splitAnnexBNals(Buffer.concat([s3(0x67, 1), s4(0x68, 2), s3(0x65, 3)]));
  assert.deepEqual(
    nals.map((n) => [...n]),
    [
      [0x67, 1],
      [0x68, 2],
      [0x65, 3],
    ],
  );
});

test("H264 first frame is normalized to 4-byte SPS, PPS, then IDR", () => {
  const input = Buffer.concat([s3(0x68, 2), s4(0x65, 3), s3(0x67, 1)]);
  const out = normalizeAnnexB(input, "h264", true);
  assert.deepEqual(
    splitAnnexBNals(out).map((n) => n[0] & 0x1f),
    [7, 8, 5],
  );
  assert.deepEqual([...out.subarray(0, 4)], [0, 0, 0, 1]);
});

test("H265 first frame is normalized to VPS, SPS, PPS, then IDR", () => {
  const nal = (type, byte) => Buffer.from([(type << 1) & 0x7e, 1, byte]);
  const input = Buffer.concat([
    Buffer.from([0, 0, 1]),
    nal(33, 2),
    Buffer.from([0, 0, 0, 1]),
    nal(19, 4),
    Buffer.from([0, 0, 1]),
    nal(34, 3),
    Buffer.from([0, 0, 0, 1]),
    nal(32, 1),
  ]);
  const out = normalizeAnnexB(input, "h265", true);
  assert.deepEqual(
    splitAnnexBNals(out).map((n) => (n[0] >> 1) & 0x3f),
    [32, 33, 34, 19],
  );
});
