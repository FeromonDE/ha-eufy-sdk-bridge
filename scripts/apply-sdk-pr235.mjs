import fs from "node:fs";
import path from "node:path";

const root = process.argv[2];
if (!root) throw new Error("usage: node apply-sdk-pr235.mjs <eufy-sdk checkout>");

function replaceOnce(source, before, after, label) {
  const first = source.indexOf(before);
  if (first < 0) throw new Error(`PR #235 backport anchor missing: ${label}`);
  if (source.indexOf(before, first + before.length) >= 0) {
    throw new Error(`PR #235 backport anchor is not unique: ${label}`);
  }
  return source.slice(0, first) + after + source.slice(first + before.length);
}

const sessionPath = path.join(root, "src/transport/p2p/p2p-session.ts");
let session = fs.readFileSync(sessionPath, "utf8");

session = replaceOnce(
  session,
  `  private lastPongData?: Buffer;
  /** When this connection last received a PONG — \`undefined\` until the first, see {@link pathSilentMs}. */
  private lastPongAt?: number;`,
  `  private lastPongData?: Buffer;
  /** When the connected peer last answered with P2P traffic, beginning with its CAM_ID. */
  private lastPeerAt?: number;`,
  "last peer timestamp field",
);

session = replaceOnce(
  session,
  `  /**
   * How long this connection's path has been silent, or nothing where it has never answered.
   *
   * A PONG is the station stating that the path is alive. \`undefined\` is neither alive nor dead: it is a station
   * that has said nothing either way.
   */
  get pathSilentMs(): number | undefined {
    return this.lastPongAt === undefined ? undefined : Date.now() - this.lastPongAt;
  }

  /**
   * Whether this path can still be committed to, on the evidence the heartbeat gives.
   *
   * False where a pong arrived and then stopped for {@link PATH_SILENCE_MS}. A station that has never ponged is
   * not known to be dead, so it answers true.
   *`,
  `  /**
   * How long this connection's path has been silent, or nothing where it has never answered.
   *
   * A CAM_ID, PONG, PING, ACK or DATA from the connected peer proves the path is alive. \`undefined\` means the
   * peer has not answered yet.
   */
  get pathSilentMs(): number | undefined {
    return this.lastPeerAt === undefined ? undefined : Date.now() - this.lastPeerAt;
  }

  /**
   * Whether this path can still be committed to, on the evidence the heartbeat gives.
   *
   * False where the connected peer answered and then stopped for {@link PATH_SILENCE_MS}. A station that has
   * never answered is not known to be dead, so it answers true.
   *`,
  "path liveness semantics",
);

session = replaceOnce(
  session,
  `  private onMessage(msg: Buffer, rinfo: dgram.RemoteInfo, socket = this.socket): void {
    if (!socket) return;
    if (!hasHeader(msg, ResponseMessageType.DATA)) {`,
  `  private onMessage(msg: Buffer, rinfo: dgram.RemoteInfo, socket = this.socket): void {
    if (!socket) return;
    const fromConnectedPeer =
      this.connected && this.connectAddress?.host === rinfo.address && this.connectAddress.port === rinfo.port;
    if (
      fromConnectedPeer &&
      (hasHeader(msg, ResponseMessageType.PONG) ||
        hasHeader(msg, ResponseMessageType.PING) ||
        hasHeader(msg, ResponseMessageType.ACK) ||
        hasHeader(msg, ResponseMessageType.DATA))
    ) {
      this.lastPeerAt = Date.now();
      this.pathStaleTraced = false;
    }
    if (!hasHeader(msg, ResponseMessageType.DATA)) {`,
  "connected-peer evidence",
);

session = replaceOnce(
  session,
  `    } else if (hasHeader(msg, ResponseMessageType.PONG)) {
      this.lastPongData = msg.length > 4 ? msg.subarray(4) : undefined;
      this.lastPongAt = Date.now();
      this.pathStaleTraced = false;
    } else if (hasHeader(msg, ResponseMessageType.PING)) {`,
  `    } else if (hasHeader(msg, ResponseMessageType.PONG)) {
      if (fromConnectedPeer) {
        this.lastPongData = msg.length > 4 ? msg.subarray(4) : undefined;
      }
    } else if (hasHeader(msg, ResponseMessageType.PING)) {`,
  "PONG handling",
);

session = replaceOnce(
  session,
  `    this.connected = true;
    this.connectedAtMs = Date.now();
    this.connecting = false;`,
  `    this.connected = true;
    this.connectedAtMs = Date.now();
    this.lastPeerAt = this.connectedAtMs;
    this.pathStaleTraced = false;
    this.connecting = false;`,
  "connection initial peer evidence",
);

session = replaceOnce(
  session,
  `    this.sendCommand(CMD_GATEWAYINFO);
    this.send(addr, RequestMessageType.PING, this.lastPongData);
    this.heartbeatTimer = setInterval(() => {
      if (this.connectAddress) this.send(this.connectAddress, RequestMessageType.PING, this.lastPongData);
    }, HEARTBEAT_MS);
    this.emit("connect");
  }

  /**
   * Start the realtime media stream`,
  `    this.sendCommand(CMD_GATEWAYINFO);
    this.send(addr, RequestMessageType.PING, this.lastPongData);
    this.heartbeatTimer = setInterval(() => this.heartbeat(), HEARTBEAT_MS);
    this.emit("connect");
  }

  /** Send the next heartbeat and signal a path that has answered nothing for three heartbeat periods. */
  private heartbeat(): void {
    if (!this.connectAddress || this.closed) return;
    this.send(this.connectAddress, RequestMessageType.PING, this.lastPongData);
    if (!this.pathAnswering) this.emit("pathStale");
  }

  /**
   * Start the realtime media stream`,
  "heartbeat stale-path signal",
);

fs.writeFileSync(sessionPath, session);

const livePath = path.join(root, "src/transport/p2p/live-stream.ts");
let live = fs.readFileSync(livePath, "utf8");

live = replaceOnce(
  live,
  `  private readonly unackedHandler = (channel: number) => {
    if (channel === this.channel) this.emit("unacknowledged");
  };
  private readonly logger: Logger;`,
  `  private readonly unackedHandler = (channel: number) => {
    if (channel === this.channel) this.emit("unacknowledged");
  };
  /** End an active pull when its connected peer stops answering, so the next pull can resolve a new path. */
  private readonly pathStaleHandler = () => this.stop();
  private readonly logger: Logger;`,
  "live path-stale handler",
);

live = replaceOnce(
  live,
  `    this.session.on("data", this.handler);
    this.session.on("liveStartUnacknowledged", this.unackedHandler);
    this.sendStart();`,
  `    this.session.on("data", this.handler);
    this.session.on("liveStartUnacknowledged", this.unackedHandler);
    this.session.on("pathStale", this.pathStaleHandler);
    this.sendStart();`,
  "live path-stale subscription",
);

live = replaceOnce(
  live,
  `    this.session.off("data", this.handler);
    this.session.off("liveStartUnacknowledged", this.unackedHandler);
    if (this.kaTimer) clearInterval(this.kaTimer);`,
  `    this.session.off("data", this.handler);
    this.session.off("liveStartUnacknowledged", this.unackedHandler);
    this.session.off("pathStale", this.pathStaleHandler);
    if (this.kaTimer) clearInterval(this.kaTimer);`,
  "live path-stale unsubscription",
);

fs.writeFileSync(livePath, live);
console.log("Applied eufy-sdk PR #235 source backport on top of PR #211.");
