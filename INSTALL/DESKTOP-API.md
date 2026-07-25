# Virtua Desktop API

Secure API for the **Virtua Desktop** client. It lets a user log in and access
**only** the machines they are allowed to use; an **ADMIN** sees everything.

Base path: `/api/desktop`  •  Transport: **HTTPS required in production**.

---

## Security model

| Area | Implementation |
|---|---|
| Password hashing | Argon2id (reuses the `users` table) |
| Access token | Short-lived (default 15 min), HMAC-SHA256 signed, **stateless** |
| Refresh token | Random 48-byte, **hashed at rest** (SHA-256), **rotated** on every refresh |
| Revocation | Per-device; checked on **every** request + refresh (instant cut-off) |
| Authorization | Server-side on every endpoint. ADMIN = all; USER = owned + ACL-granted |
| Resource identity | Opaque **UUID handles** — the client never sends a real name/node |
| Console | One-time, short-lived tickets (text + graphical), permission-gated |
| Rate limiting | login/pair `10/min`, refresh `60/min`, console tickets `30/min` |
| Input validation | `zod` schemas on every payload |
| Audit | user, ip, device, resource, action, result, timestamp (`audit_logs`) |
| Headers | `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy`, `Cache-Control: no-store`; no permissive CORS |

The client must store the **refresh token in the OS Keychain** (macOS) — never in
`localStorage`. The access token lives in memory only.

---

## Endpoints

### Auth
```
POST /api/desktop/auth/login        { username, password, deviceName, deviceFingerprint? }
POST /api/desktop/devices/pair      { pairingCode, deviceName, deviceFingerprint? }
POST /api/desktop/auth/refresh      { refreshToken }
POST /api/desktop/auth/logout       { refreshToken }
POST /api/desktop/pairing-codes     (web session) → { code, expiresInMs }
```
`login`, `pair` and `refresh` return:
```jsonc
{
  "accessToken": "…",          // Bearer, short-lived
  "expiresIn": 900,            // seconds
  "refreshToken": "…",         // store in Keychain, rotates on refresh
  "refreshExpiresIn": 2592000,
  "device": { "id": "uuid", "name": "…", "createdAt": "…", "lastSeenAt": null }
}
```

### Identity & resources
```
GET  /api/desktop/me
GET  /api/desktop/resources                 → [{ id(uuid), type, name, displayName, state, node, permissions }]
GET  /api/desktop/resources/:id
```

### Actions (controlled)
```
POST /api/desktop/resources/:id/actions/start
POST /api/desktop/resources/:id/actions/stop
POST /api/desktop/resources/:id/actions/restart
POST /api/desktop/resources/:id/actions/snapshot   { name, description? }   # VM/LXC only
```

### Console (one-time tickets)
```
POST /api/desktop/resources/:id/console/text-ticket        → { ticket, url, expiresInMs, kind:"text" }
POST /api/desktop/resources/:id/console/graphical-ticket   → { ticket, url, expiresInMs, kind:"graphical" }   # VM only
POST /api/desktop/resources/:id/console/spice-ticket       → { ticket, url, expiresInMs, kind:"spice" }       # VM only
```
The client then connects the WebSocket to the returned `url`
(`wss://host/api/ws/term?ticket=…`, `/api/ws/vnc?ticket=…` or
`/api/ws/spice?ticket=…`). Each ticket is **single-use** and expires in ~60 s;
the permission was already enforced when it was issued, and the ticket is bound
to that one machine.

Plain HTTP requests to `/api/ws/term`, `/api/ws/vnc` or `/api/ws/spice`
intentionally return `426 Upgrade Required`. A working desktop console must
connect with a WebSocket upgrade (`Upgrade: websocket`, `Connection: Upgrade`)
and the one-time ticket.

SPICE is an authenticated Virtua relay to the QEMU/libvirt SPICE socket. The VM
graphics listener stays bound to `127.0.0.1`; the server never returns an
internal unauthenticated SPICE address to the desktop client. In 0.6.7 this is a
first experimental transport: VNC remains the supported fallback while advanced
SPICE features such as clipboard, USB redirection, audio and guest resize are
added later.

All authenticated requests send `Authorization: Bearer <accessToken>`.

---

## Connecting the Desktop client

1. **Pair without typing the password** (recommended):
   - In the web panel (logged in), `POST /api/desktop/pairing-codes` → short code
     like `K7QF-3MРX` (valid 10 min).
   - In the desktop app: `POST /api/desktop/devices/pair { pairingCode, deviceName }`.
2. **Or direct login**: `POST /api/desktop/auth/login { username, password, deviceName }`.
3. Store `refreshToken` in the **Keychain**; keep `accessToken` in memory.
4. Before/at expiry, call `POST /api/desktop/auth/refresh { refreshToken }` and
   **replace** both tokens (the old refresh token is now revoked).
5. List machines via `GET /api/desktop/resources` — only allowed ones appear.
6. Open a console by requesting a ticket then connecting the WS to its `url`.
7. On sign-out: `POST /api/desktop/auth/logout { refreshToken }` (revokes the device's tokens).

**Revoke a device** from the web panel by deleting/disabling its `desktop_devices`
row (or revoking its refresh tokens) — the next request/refresh is rejected.

---

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `AUXINUX_DESKTOP_TOKEN_SECRET` | auto-generated & persisted | HMAC secret for access tokens. Set explicitly to share across nodes. |
| `AUXINUX_DESKTOP_ACCESS_TTL` | `900` | Access-token lifetime (seconds). |
| `AUXINUX_DESKTOP_REFRESH_TTL_DAYS` | `30` | Refresh-token lifetime (days). |
| `AUXINUX_DESKTOP_PAIRING_TTL_MS` | `600000` | Pairing-code lifetime (ms). |
| `AUXINUX_PUBLIC_HOST` | unset | Public host, optionally `host:port`, used when building Desktop WebSocket URLs if the incoming request host is loopback/internal. Required for desktop console URLs behind some proxies. |

If `AUXINUX_DESKTOP_TOKEN_SECRET` is unset, the API mints a strong secret on first
use and stores it in `settings(desktop.tokenSecret)` (stable across restarts).

---

## WebSocket / reverse proxy checklist

If the desktop receives a ticket but fails with `HTTP 404 Not Found` on
`/api/ws/term`, `/api/ws/vnc` or `/api/ws/spice`, the request is reaching the
server as a normal HTTP GET instead of a WebSocket upgrade, or it is being
routed to the wrong backend.

Verify:

1. `POST /api/desktop/resources/:id/console/text-ticket`,
   `/graphical-ticket` or `/spice-ticket` returns an absolute URL such as
   `wss://example.com/api/ws/spice?ticket=...`.
2. A plain browser/curl GET to `/api/ws/term`, `/api/ws/vnc` or `/api/ws/spice`
   returns `426`, not `404`.
3. The reverse proxy forwards WebSocket upgrades:

```nginx
proxy_http_version 1.1;
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection "Upgrade";
proxy_set_header Host $host;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_set_header X-Forwarded-Host $host;
```

The built-in HTTPS listener also forwards `upgrade` events to the same WebSocket
handler as the main API listener. Both `/api/ws/term?ticket=...` and
`/api/ws/vnc?ticket=...` and `/api/ws/spice?ticket=...` are valid server-side
WebSocket paths.

---

## Database (auto-migrated)

`desktop_devices`, `desktop_refresh_tokens`, `desktop_pairing_codes`,
`desktop_resource_handles` are created automatically on startup (see `db.ts`).
Tables are additive — no manual migration step.

---

## Tests

Pure auth/permission logic is unit-tested with vitest:
```
cd packages/shared && npx vitest run src/desktop/token.test.ts
```
Covers token round-trip/tamper/expiry, refresh-token hashing, pairing-code
format, and the RBAC decision matrix (ADMIN=all, owner=full, USER=ACL-limited).
