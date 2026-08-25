# Nemo render worker

Video render service for the Content Factory. Turns `{title, scenes[{imageUrl, caption, durationSec}], audioUrl}`
into a 1080×1920 MP4 short (Remotion + ffmpeg), uploads it to Supabase Storage, returns a public URL.

Runs on the VPS **outside** Supabase (Remotion needs Node + headless Chromium). It is isolated from the
other sites on the box via a dedicated systemd service with memory/CPU caps and a localhost-only bind;
the gateway exposes it only under `${NEMO_API_GATEWAY_URL}/render-api/` behind a shared secret.

## API (all requests need header `x-render-secret: <RENDER_SECRET>`)

- `POST /render` `{ accountId, props }` → `202 { jobId }`
- `GET  /render/:jobId` → `{ status: queued|rendering|done|error, url?, error? }`
- `GET  /health` → `{ ok, busy, queued }` (no auth)

`props`: `{ title?, brand?, accent?(#hex), audioUrl?, scenes: [{ imageUrl?, caption?, durationSec? }] }`
(max 8 scenes; captions/durations are clamped server-side).

## Deploy (VPS, /opt/nemo-render)

```bash
cd /opt/nemo-render
npm ci --omit=dev
node ensure-browser.mjs
cp .env.example .env && $EDITOR .env        # set RENDER_SECRET + SUPABASE_SERVICE_ROLE_KEY
node smoke.mjs                              # offline render check -> /tmp/nemo-smoke.mp4
cp deploy/nemo-render.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now nemo-render
```

nginx: add inside the `nemo` 443 server block, then `nginx -t && systemctl reload nginx`:

```nginx
location /render-api/ {
    proxy_pass http://127.0.0.1:4020/;
    proxy_read_timeout 180s;
    proxy_set_header Host $host;
    client_max_body_size 3m;
}
```
