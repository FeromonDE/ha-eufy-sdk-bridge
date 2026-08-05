# ha-eufy-sdk-bridge

The host-facing daemon: one process that logs into eufy **once** and exposes the
[`eufy-sdk`](https://github.com/mega-yfue/eufy-sdk) to a frontend — Home Assistant, a web UI,
anything. Ships as a multi-arch Docker image with [go2rtc](https://github.com/AlexxIT/go2rtc)
bundled, so live camera video is available as RTSP / WebRTC / MSE / HLS with nothing else to install.

```
WS    :3000/ws             control, state, events     ← the frontend talks to this
HTTP  :3000/stream/<sn>    live video (Annex-B)       ← go2rtc pulls this
HTTP  :3000/snapshot/<sn>  a JPEG still
HTTP  :3000/healthz        which cameras are streaming
```

Video is deliberately **not** on the WebSocket: the WS hands back a URL, and *connecting to that URL
is what starts the camera — disconnecting is what stops it*. There is no "stream is running" flag to
drift out of sync.

## Run it

```bash
cp .env.example .env      # EUFY_EMAIL / EUFY_PASSWORD / EUFY_COUNTRY
docker compose up
```

## Where it fits

| Repo | Role |
| --- | --- |
| [`eufy-sdk`](https://github.com/mega-yfue/eufy-sdk) | the HA-agnostic library |
| **`ha-eufy-sdk-bridge`** | **this** — WS + HTTP + go2rtc daemon (Docker) |
| [`ha-eufy-sdk-addon`](https://github.com/mega-yfue/ha-eufy-sdk-addon) | Home Assistant add-on wrapper |
| [`ha-eufy-sdk`](https://github.com/mega-yfue/ha-eufy-sdk) | the HACS integration (front door) |

> Status: scaffolding. The daemon implementation lands next.
