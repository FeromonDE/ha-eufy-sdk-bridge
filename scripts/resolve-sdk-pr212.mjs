import fs from "node:fs";
import path from "node:path";

const root = process.argv[2];
if (!root) throw new Error("usage: node resolve-sdk-pr212.mjs <eufy-sdk checkout>");

const file = path.join(root, "src/transport/p2p/p2p-session.ts");
let source = fs.readFileSync(file, "utf8");

const conflict = `<<<<<<< HEAD
/** Additional UDP source ports registered alongside the session's own during cloud lookup. */
const PUNCH_PROBE_SOCKETS = 7;

=======
/** Chosen maximum wait for a missing datagram; 250 ms is not a measured device resend delay. */
const REORDER_WAIT_MS = 250;
/** Maximum later datagrams held behind a hole, bounding retained memory and the delay before resuming. */
const REORDER_MAX_DATAGRAMS = 128;
>>>>>>> refs/remotes/origin/pr-212
`;

const resolved = `/** Additional UDP source ports registered alongside the session's own during cloud lookup. */
const PUNCH_PROBE_SOCKETS = 7;

/** Chosen maximum wait for a missing datagram; 250 ms is not a measured device resend delay. */
const REORDER_WAIT_MS = 250;
/** Maximum later datagrams held behind a hole, bounding retained memory and the delay before resuming. */
const REORDER_MAX_DATAGRAMS = 128;
`;

if (!source.includes(conflict)) {
  throw new Error("Expected #211/#212 constants conflict was not found");
}
source = source.replace(conflict, resolved);

if (/^(<<<<<<<|=======|>>>>>>>)/m.test(source)) {
  throw new Error("Unexpected additional merge conflict remains after resolving PR #212");
}

fs.writeFileSync(file, source);
console.log("Resolved the reviewed #211/#212 constants overlap.");
