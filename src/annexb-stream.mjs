import { Transform } from "node:stream";

const START4 = Buffer.from([0x00, 0x00, 0x00, 0x01]);

/** Split one Annex-B access unit into NAL bodies, accepting 3- and 4-byte start codes. */
export function splitAnnexBNals(buf) {
  const starts = [];
  for (let i = 0; i < buf.length - 2; ) {
    if (i + 3 < buf.length && buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 0 && buf[i + 3] === 1) {
      starts.push([i, 4]);
      i += 4;
    } else if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 1) {
      starts.push([i, 3]);
      i += 3;
    } else {
      i++;
    }
  }

  const nals = [];
  for (let i = 0; i < starts.length; i++) {
    const from = starts[i][0] + starts[i][1];
    const to = i + 1 < starts.length ? starts[i + 1][0] : buf.length;
    if (to > from) nals.push(buf.subarray(from, to));
  }
  return nals;
}

const h264Type = (nal) => nal[0] & 0x1f;
const h265Type = (nal) => (nal[0] >> 1) & 0x3f;

function firstFrameOrder(codec, nals) {
  if (codec === "h264") {
    const sps = nals.filter((n) => h264Type(n) === 7);
    const pps = nals.filter((n) => h264Type(n) === 8);
    if (!sps.length) return undefined;
    const rest = nals.filter((n) => ![7, 8].includes(h264Type(n)));
    return [...sps, ...pps, ...rest];
  }
  if (codec === "h265") {
    const vps = nals.filter((n) => h265Type(n) === 32);
    const sps = nals.filter((n) => h265Type(n) === 33);
    const pps = nals.filter((n) => h265Type(n) === 34);
    if (!vps.length) return undefined;
    const rest = nals.filter((n) => ![32, 33, 34].includes(h265Type(n)));
    return [...vps, ...sps, ...pps, ...rest];
  }
  return undefined;
}

/** Normalize all NAL separators to the four-byte form go2rtc 1.9.9 expects. */
export function normalizeAnnexB(data, codec, first = false) {
  const nals = splitAnnexBNals(data);
  if (!nals.length) return undefined;
  const ordered = first ? firstFrameOrder(codec, nals) : nals;
  if (!ordered?.length) return undefined;
  return Buffer.concat(ordered.flatMap((nal) => [START4, nal]));
}

/**
 * LiveVideoFrame object stream -> raw Annex-B byte stream.
 * Wait for a keyframe carrying decoder config, then emit only normalized four-byte start codes.
 */
export function createAnnexBNormalizer() {
  let started = false;
  return new Transform({
    writableObjectMode: true,
    transform(frame, _encoding, callback) {
      try {
        if (!frame || !Buffer.isBuffer(frame.data)) return callback();
        if (!started) {
          if (!frame.keyframe) return callback();
          const first = normalizeAnnexB(frame.data, frame.codec, true);
          if (!first) return callback();
          started = true;
          return callback(null, first);
        }
        return callback(null, normalizeAnnexB(frame.data, frame.codec, false));
      } catch (err) {
        return callback(err);
      }
    },
  });
}
