# Network-exposure hardening

Reference document covering the four orthogonal pieces of work required to harden the ACMA RRL MCP Server for deployments that reach a network beyond a single host's loopback. Each section is independent and can be implemented in isolation, though §1 and §2 are usually applied together (auth over unencrypted transport leaks the credential).

## Baseline behaviour

- Server binds on `0.0.0.0:3000` (configurable via `PORT`).
- `POST /mcp` accepts requests with no authentication.
- `/health` is open by design (liveness probes should not require credentials).
- Sync downloads from `https://backend.acma.gov.au/rrl/v1/Extracts` use `axios` against Node's default CA bundle (outbound TLS is verified).

---

## Threat model

This section describes the SQL data-integrity posture an MCP client has against the server, independent of network controls. Everything below assumes the client can already reach `/mcp` — once a network-exposure deployment is in scope, the controls in §§1–4 below sit *in front of* this surface.

### SQL-write attack surface: `execute_sql`

The `execute_sql` tool is the primary attack surface for mutation attempts. Five orthogonal defenses are in place in `src/sql_worker.cjs`; any one of them is sufficient to block injection:

| # | Defense | Implementation | Blocks |
|---|---|---|---|
| 1 | First-word validator | `sql_worker.cjs:19-25` — rejects everything except `SELECT` and `WITH` | direct `INSERT` / `UPDATE` / `DELETE` / `DROP` / `PRAGMA` / `ATTACH` / `VACUUM` / `REINDEX` |
| 2 | LIMIT-wrap | `sql_worker.cjs:28` — wraps query as `SELECT * FROM (${trimmed}) LIMIT N` | `WITH x AS (SELECT 1) DELETE FROM t` style CTE-mutation. DELETE/UPDATE/INSERT are not valid subqueries; SQLite's parser rejects the wrapped form |
| 3 | Semicolon ban | `sql_worker.cjs:40-42` — rejects wrapped query if it contains `;` | multi-statement injection (`SELECT 1; DROP TABLE x`) |
| 4 | Worker-thread isolation | `sql.ts:380` — query runs in a separate thread with its own DB handle | a successful exploit cannot directly observe main-thread state |
| 5 | Transaction-rollback sandbox | `sql_worker.cjs:45-58` — wraps everything in `BEGIN TRANSACTION; … ROLLBACK;` | belt-and-suspenders: any write reaching the executor is discarded on rollback |

A 25-second timeout in `executeSqlWithTimeout` (`sql.ts:385`) terminates the worker if it doesn't respond, capping CPU exposure per request.

### `explain_query`

Uses the same first-word validator (`sql.ts:151-157`), then prefixes the input with `EXPLAIN QUERY PLAN`. `EXPLAIN QUERY PLAN` is a planner-output-only operation — SQLite never executes the underlying statement, only reports the strategy it would choose. `better-sqlite3`'s `prepare()` also rejects multi-statement input at parse time, so `;`-injection fails before any execution.

### `describe_schema`

The user-supplied `tables[]` argument is filtered against an allowlist drawn from `sqlite_master` (`sql.ts:87-91`) before any string interpolation. The subsequent `PRAGMA table_info(${name})` / `PRAGMA index_list(${name})` / `PRAGMA index_info(${i.name})` calls receive names that already exist in the schema; no user-provided string reaches the interpolated position.

### `search_*` and `get_*` tools

All other MCP tools that take user input (`search_licences`, `search_sites`, `search_clients`, `search_bsl`, `search_spectrum_band`, `search_application_text`, `get_licence_details`, `get_site_details`, `get_frequency_allocation`) use `?` parameter binding throughout `src/logic.ts` and the dispatcher in `src/index.ts`. No string-interpolation of MCP input into SQL.

### Template-interpolation audit

`grep -nE 'db\.prepare\(`[^`]*\$\{[^}]+\}[^`]*`\)' src/*.ts` returns ten matches across `src/sql.ts`, `src/sync.ts`, and `src/spectrum_plan.ts`. Every one of them interpolates either:

- a hardcoded module-level constant (e.g. `SPECTRUM_TABLES`), or
- a name read from `sqlite_master` server-side, or
- a value derived from filenames during ACMA-side sync (`src/sync.ts`, not reachable from MCP).

No template-interpolated `db.prepare()` carries MCP user input.

### Capabilities available to any MCP client

The following are operational properties of the tool surface, not vulnerabilities, and are documented here so they aren't mistaken for either:

- **Full read access to materialised rows** through `execute_sql`.
- **Schema enumeration** through `describe_schema` or `SELECT … FROM sqlite_master` via `execute_sql`.
- **Bounded denial-of-service via expensive queries.** Pathological `WITH RECURSIVE` or unbounded cross-joins are capped by the 25-second timeout and 64 MB worker cache; while running, each occupies one worker thread. `sync_data` with `mode='full'` initiates a 70 MB download.

None of these affect on-disk data integrity.

### Trust boundaries outside MCP

Two paths accept arbitrary database writes; neither is reachable from MCP:

- **`npm run import-spectrum-plan -- --patch <path>`** runs the SQL contents of a hand-written patch file directly. Trust boundary: anyone with shell access on the host.
- **`performFullSync`** writes every table from CSVs extracted out of `spectra_rrl.zip`. Trust boundary: ACMA's CDN plus Node's default TLS verification of the manifest and download.

---

## 1. Bearer-token authentication

Require an `Authorization: Bearer <token>` header on every `POST /mcp` request. `/health` remains open. A single shared secret rotated out of band is sufficient for the surface; JWT machinery is unnecessary and adds attack surface.

```typescript
// src/auth.ts
import crypto from 'node:crypto';

const expected = process.env.ACMA_MCP_TOKEN;
if (!expected) {
    // Fail closed: when no token is configured, reject all MCP requests
    // rather than defaulting to open. Operators who want open access must
    // opt in via an explicit sentinel value (e.g. ACMA_MCP_TOKEN=__open__).
}

export function authMiddleware(req, res, next) {
    if (req.path === '/health') return next();
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Authorization: Bearer <token> required' });
    }
    const presented = header.slice('Bearer '.length).trim();
    const ok = presented.length === expected.length
        && crypto.timingSafeEqual(Buffer.from(presented), Buffer.from(expected));
    if (!ok) return res.status(401).json({ error: 'Invalid token' });
    next();
}
```

Wire `app.use('/mcp', authMiddleware)` in `src/index.ts` before the `/mcp` handler. Update the `MCP client configuration` examples in `README.md` to show the `Authorization` header.

The constant-time compare (`crypto.timingSafeEqual`) avoids leaking the secret length / first-byte position via response-time analysis on the comparison.

`@modelcontextprotocol/sdk` exposes `authenticator` hooks on `StreamableHttpServerTransport`. The Express-layer middleware above is the right choice for a single shared secret. The SDK hooks are the right layer for per-session credentials.

**Effort:** ~80 lines including two cases of test coverage. README examples and a CI check add another half-day.

---

## 2. TLS termination

Auth tokens travel in HTTP headers. If those headers cross any link the operator does not control, the connection must be encrypted, or the token is leaked the first time a request crosses the wire.

In-process TLS in Node is functional but every reverse proxy on the market is better at this specific job: automatic cert provisioning and renewal, HTTP/2 and HTTP/3 support without application changes, deployment-topology decoupled from application code. Terminate TLS at the proxy and forward plain HTTP to a `127.0.0.1`-bound Node process.

**Caddy:**
```Caddyfile
mcp.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

**nginx** (manual cert handling via certbot or equivalent):
```nginx
server {
    listen 443 ssl http2;
    server_name mcp.example.com;
    ssl_certificate     /etc/letsencrypt/live/mcp.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/mcp.example.com/privkey.pem;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_buffering off;        # SSE requires no buffering on responses
    }
}
```

**Cloudflare Tunnel** (no public listening socket required):
```bash
cloudflared tunnel --hostname mcp.example.com --url http://127.0.0.1:3000
```

Bind the Node process to `127.0.0.1:3000` (set `PORT=3000`, change `app.listen(port, '0.0.0.0', ...)` to `'127.0.0.1'`) so the proxy is the only path that can reach it.

**Effort:** minutes once the host can complete an ACME challenge or reach the tunnel control plane.

---

## 3. Rate limiting

Even with §1 in place, a misbehaving client (or a leaked token) can issue `execute_sql` / `sync_data` in a loop, saturating the worker thread and ACMA's manifest endpoint. Apply a per-IP rate limit to `/mcp`. `/health` is exempt — liveness probes from orchestrators can be aggressive.

```typescript
import rateLimit from 'express-rate-limit';

const mcpLimiter = rateLimit({
    windowMs: 60_000,
    max: 60,                                     // 60 req/min per IP
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => req.path === '/health',
});
app.use('/mcp', mcpLimiter);
```

`express-rate-limit` is already present in `node_modules` as a transitive — promote to a direct dependency in `package.json`.

Per-token (rather than per-IP) limits require an identity-extraction step that pulls the bearer token before rate-limiting; not significantly more code, but the test surface grows because failure cases multiply.

**Effort:** ~10 lines + a test that asserts 429 after the threshold. Per-token: half a day.

---

## 4. Container image and compose stack

A canonical Dockerfile collapses deployment to one command and ensures the graceful-shutdown path (already wired up in `src/index.ts`) actually fires under orchestration — Docker's default PID 1 swallows SIGTERM, which is why `tini` is required.

**Dockerfile (multi-stage):**
```dockerfile
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json tsconfig.json ./
COPY src ./src
RUN npm ci && npm run build && npm prune --omit=dev

FROM node:20-alpine
WORKDIR /app
RUN apk add --no-cache tini
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY seed ./seed
ENV NODE_ENV=production PORT=3000 ACMA_DB_PATH=/data/acma.db
EXPOSE 3000
VOLUME ["/data"]
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
```

Notes:
- `tini` as PID 1 forwards `SIGTERM` to the Node process so the graceful-shutdown handler runs (closes MCP transports, drains in-flight HTTP requests, exits within 30s).
- `/data` is a named volume — the SQLite DB and WAL sidecar files survive container restarts.
- `seed/` is copied in (read-only) so first-run auto-bootstrap of the spectrum-plan tables works without an extra mount.
- Image tag should track `package.json`'s `version` field; a CI step on push to main builds and publishes.

**Compose stack tying §1, §2, §3, §4 together:**
```yaml
services:
  acma-mcp:
    image: ciphernaut/acma-mcp:1.8.0
    restart: unless-stopped
    environment:
      ACMA_MCP_TOKEN: ${ACMA_MCP_TOKEN}
      LOG_LEVEL: info
    volumes:
      - acma-data:/data
    expose: ["3000"]   # not "ports" — only reachable from the caddy container

  caddy:
    image: caddy:2-alpine
    restart: unless-stopped
    ports: ["80:80", "443:443"]
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy-data:/data
      - caddy-config:/config
    depends_on: [acma-mcp]

volumes:
  acma-data:
  caddy-data:
  caddy-config:
```

The `expose` directive (versus `ports`) means port 3000 is reachable only from the Caddy container on the internal compose network, not from the host. All ingress flows through TLS at `:443`.

**Effort:** ~30 lines + a CI workflow step that builds the image on push.

---

## Section dependencies

- §1 alone provides no protection over an untrusted link — the token leaks on first use. §1 implies §2 anywhere the network is not under the operator's exclusive control.
- §3 sits behind §1 and applies regardless of which transport the §1 traffic uses. Implementable before §1 with the per-IP variant.
- §4 is orthogonal to §1–§3 and can be applied independently. The graceful-shutdown wiring already present in the codebase only fires correctly under PID 1 = `tini` (or equivalent), which the Dockerfile arranges.

## Out of scope

- Per-user accounts, RBAC, OAuth2.
- Audit logging beyond the existing stderr session lifecycle.
- mTLS.
- CORS (the Streamable HTTP transport is not designed for browser-origin clients).
