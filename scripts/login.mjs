// Interactive login CLI for the ha-eufy-sdk bridge.
//
// Connects to the bridge WS, reads the auth state, and walks you through 2FA / captcha:
//   - 2FA:     prompts for the code (sent to your email/phone)   -> auth.submit { code }
//   - captcha: writes the challenge image to ./captcha.png       -> auth.submit { captcha }
//   - either:  type 'r' at the prompt to request a fresh code/captcha (auth.retrigger)
// Exits 0 once the bridge reports state "ok".
//
// Run from the bridge repo (so `ws` resolves):  node scripts/login.mjs  [ws://host:3000/ws]
import WebSocket from "ws";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const URL = process.argv[2] || process.env.BRIDGE_WS || "ws://localhost:3000/ws";
const rl = readline.createInterface({ input, output });
const ws = new WebSocket(URL);

// request/response correlation by id; unsolicited {event,...} messages are just logged.
let nextId = 0;
const pending = new Map();
const rpc = (cmd, extra = {}) =>
  new Promise((res, reject) => {
    const id = ++nextId;
    pending.set(id, { res, reject });
    ws.send(JSON.stringify({ id, cmd, ...extra }));
  });

ws.on("message", (data) => {
  const m = JSON.parse(data.toString());
  if (m.id && pending.has(m.id)) {
    const { res } = pending.get(m.id);
    pending.delete(m.id);
    res(m);
  } else if (m.event === "auth" || m.event === "ready") {
    console.log(`« ${m.event}${m.state ? ` (${m.state})` : ""}`);
  }
});

ws.on("error", (e) => {
  console.error("WS error:", e.message);
  process.exit(1);
});

ws.on("open", async () => {
  console.log(`connected → ${URL}`);
  try {
    await drive();
  } catch (e) {
    console.error("login failed:", e?.message ?? e);
    process.exit(1);
  }
});

async function drive() {
  let { auth } = await rpc("auth.status");
  for (;;) {
    switch (auth.state) {
      case "ok":
        console.log("✓ authenticated — the bridge is ready.");
        rl.close();
        ws.close();
        return process.exit(0);

      case "require_2fa": {
        console.log(`\n2FA required (method: ${auth.method ?? "unknown"}). A code was sent to you.`);
        const code = (await rl.question("Enter the 2FA code (or 'r' to resend): ")).trim();
        auth = (code === "r" ? await rpc("auth.retrigger") : await rpc("auth.submit", { code })).auth;
        break;
      }

      case "require_captcha": {
        const file = resolve("captcha.png");
        writeFileSync(file, Buffer.from(String(auth.image).replace(/^data:image\/\w+;base64,/, ""), "base64"));
        console.log(`\nCaptcha required${auth.retry ? " (previous answer was wrong)" : ""}. Saved → ${file}`);
        console.log("Open that image, then type the characters you see.");
        const ans = (await rl.question("Enter the captcha (or 'r' for a new one): ")).trim();
        auth = (ans === "r" ? await rpc("auth.retrigger") : await rpc("auth.submit", { captcha: ans })).auth;
        break;
      }

      case "pending":
        console.log("login pending — requesting a challenge…");
        auth = (await rpc("auth.retrigger")).auth;
        break;

      default:
        console.log("unexpected auth state:", JSON.stringify(auth), "— re-checking…");
        ({ auth } = await rpc("auth.status"));
    }
  }
}
