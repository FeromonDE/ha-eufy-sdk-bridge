# Running the bridge with Docker Compose

The bridge is one container that logs into eufy **once** and exposes the SDK over a WebSocket (+ HTTP
video) for the [`ha-eufy-sdk`](https://github.com/mega-yfue/ha-eufy-sdk) Home Assistant integration.
The published image already bundles the SDK and go2rtc, so you don't build anything — you pull and run.

- **Image:** `<your-image>` (`linux/amd64`)
- **Ports:** `3000` WS/HTTP control · `1984` go2rtc API/WebRTC · `8554` RTSP · `8555` WebRTC (TCP/UDP)

> **One session per account.** eufy allows a single active login per account, so run **exactly one**
> bridge, and expect opening the phone app to bump the bridge's session (and vice-versa). The `data`
> volume persists the login so a restart doesn't re-authenticate.

---

## Option A — run it alongside Home Assistant (recommended)

Add this service to the same `docker-compose.yaml` you run Home Assistant from:

```yaml
services:
  # ... your existing homeassistant service ...

  eufy-bridge:
    image: <your-image>
    container_name: eufy-bridge
    restart: unless-stopped
    network_mode: host          # needed for go2rtc WebRTC (UDP/ICE)
    environment:
      EUFY_EMAIL: "you@example.com"
      EUFY_PASSWORD: "your-password"
      EUFY_COUNTRY: "GB"         # your account's country code
      BRIDGE_HOST: "0.0.0.0"     # bind all interfaces
      BRIDGE_PORT: "3000"        # change the WS/control port here if 3000 is taken
    volumes:
      - /opt/homeassistant/eufy-bridge-data:/app/data   # persists the login token
```

Start just the bridge:

```bash
docker compose up -d eufy-bridge
docker compose logs -f eufy-bridge
```

Because HA and the bridge share the host network, point the integration at **`localhost`** (or the
server's LAN IP) and the port you set.

---

## Option B — standalone (bridge on its own host)

`docker-compose.yaml`:

```yaml
services:
  eufy-bridge:
    image: <your-image>
    container_name: eufy-bridge
    restart: unless-stopped
    network_mode: host
    env_file: .env
    environment:
      BRIDGE_HOST: "0.0.0.0"
    volumes:
      - ./data:/app/data
```

`.env` (next to the compose file):

```dotenv
EUFY_EMAIL=you@example.com
EUFY_PASSWORD=your-password
EUFY_COUNTRY=GB
BRIDGE_PORT=3000
```

```bash
docker compose up -d
```

Point the integration at this host's IP and `BRIDGE_PORT`.

---

## Configuration reference

| Env var | Default | Meaning |
| --- | --- | --- |
| `EUFY_EMAIL` | — (required) | eufy account email |
| `EUFY_PASSWORD` | — (required) | eufy account password |
| `EUFY_COUNTRY` | `GB` | two-letter account country (routes the region) |
| `BRIDGE_HOST` | `0.0.0.0` | interface the WS/HTTP binds to |
| `BRIDGE_PORT` | `3000` | WS/HTTP control port |
| `EUFY_POLL_MS` | `600000` (10 min) | how often the bridge polls the cloud for device state; `0` disables. Also changeable live from the HA integration / the `config.set` WS command |
| `EUFY_SESSION` | `/app/data/.eufy-session.json` | where the login token is persisted |
| `GO2RTC_CONFIG` | `/app/data/go2rtc.yaml` | generated from the live device list at startup |

---

## First run: 2FA / captcha

On the first login eufy usually requires **2FA** (or a captcha). The bridge does **not** exit on this —
it stays up and reports the auth state over the WS, so you resolve it one of two ways:

- **From the Home Assistant integration (recommended).** Add the `ha-eufy-sdk` integration, enter the
  bridge host + port, and it walks you through the 2FA/captcha steps in the UI.
- **From the CLI** (from a checkout of this repo): `node scripts/login.mjs ws://HOST:PORT/ws` — it
  prompts for the code, or writes the captcha to `captcha.png` for you to solve.

Once authenticated, the token is saved in the `data` volume and restarts won't re-prompt.

---

## Verify it's up

```bash
curl -s http://HOST:PORT/healthz          # {"ok":true,"auth":{"state":"ok"},...}
node scripts/devices.mjs ws://HOST:PORT/ws # lists your devices (from a repo checkout)
```

See [`ws-protocol.md`](./ws-protocol.md) for the full WebSocket protocol.

---

## Notes

- **Architecture:** the published image is `linux/amd64`. On arm64 (Raspberry Pi / HA OS on ARM) it
  won't run yet — a multi-arch build is on the roadmap.
- **Not host networking?** WebRTC needs UDP/ICE, which is awkward behind bridge networking. If you drop
  `network_mode: host`, publish the ports (`3000`, `1984`, `8554`, `8555/udp`) and expect to sort out
  WebRTC separately; control + snapshots + RTSP still work.
