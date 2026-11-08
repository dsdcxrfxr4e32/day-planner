# Deploy the day planner on Render (free web service)

The app is stateless on Render: secrets come from env vars, Today/Tomorrow/Monday follow the Asana due date (Today may still add a TODAY-<Name> tag; Tomorrow and Monday never add a tag), logs go to stdout.
The box copy (`/workspace/day-planner-app`, `./run.sh`, Tailscale Funnel) keeps working unchanged.

## Env vars to set on Render (names only; values from the box, never commit them)
| Name | Required | Where the box value lives |
|---|---|---|
| `ASANA_PAT` | yes | box login env (`$ASANA_PAT`) |
| `ACCESS_KEY` | yes (server exits without it on Render) | `data/access_key` on the box; use the same value so the existing `?k=` links keep working |
| `CAL_ICS_DIMITRIS` | yes for Dimitris's calendar | box env / `data/cal.env` |
| `CAL_ICS_DIMITRIS_PERSONAL` | optional (second feed) | `data/cal.env` |
| `CAL_ICS_ANTONIA` | optional, later | not set yet; leave empty |
| `CAL_ICS_DIMITRA` | optional, later | not set yet; leave empty |

Set automatically, nothing to do: `PORT` (Render injects it), `RENDER`. Optional: `TODAY_STORE` (default `asana_tags`; do not use `file` on Render), `READ_ONLY=1` (refuses Asana writes, for a dry run), `DATA_DIR`.
Node version: `engines.node >=20` in package.json (Render picks it up; add `NODE_VERSION` if you want to pin, e.g. 24).

## Steps
1. Push this folder to a **private** GitHub (or GitLab) repo:
   `git remote add origin git@github.com:<owner>/day-planner.git && git push -u origin main`
2. In Render: New → Blueprint → pick the repo. Render reads `render.yaml` (web service `day-planner`, runtime node, plan free, region frankfurt, build `npm ci`, start `node server.js`, health check `/healthz`).
   (Or New → Web Service with the same settings by hand.)
3. When Render asks for the `sync: false` values, paste `ASANA_PAT`, `ACCESS_KEY`, `CAL_ICS_DIMITRIS`, `CAL_ICS_DIMITRIS_PERSONAL`. Leave `CAL_ICS_ANTONIA` / `CAL_ICS_DIMITRA` empty until those feeds exist (empty = "calendar not connected").
4. Deploy. Check `https://<service>.onrender.com/healthz` → `{"ok":true}`, then open `https://<service>.onrender.com/?k=<ACCESS_KEY>`.
5. Later calendar feeds: Render → service → Environment → add/edit `CAL_ICS_<NAME>` (or `CAL_ICS_<NAME>_<SUFFIX>`) → Save (redeploys).

## Vercel (Pro, does not sleep the way the Render free plan does)

Same `main` branch. Framework preset **Other** (not Next.js — `public/` must not be served as a static site; the function injects the build id into the HTML). Root directory: the repo root. Build command: none. Output directory: none. Install command: the default `npm install`. Node 20 or newer (`engines` in package.json). Region is `fra1` in `vercel.json` (Frankfurt); confirm that if the dashboard asks. Function timeout is 60s so a cold board load can finish.

`vercel.json` sends `/`, `/index.html`, and `/healthz` through `api/[[...slug]].js`. `/api/*` hits that function directly. It calls the same handler as `node server.js`, so Render keeps working.

Env vars to set on Vercel (names only; copy the values from Render). Do not commit them.

| Name | Required |
|---|---|
| `ASANA_PAT` | yes |
| `ACCESS_KEY` | yes (the function exits without it; use the same value so `?k=` links keep working) |
| `CAL_ICS_DIMITRIS` | yes for Dimitris's calendar |
| `CAL_ICS_DIMITRIS_PERSONAL` | optional second feed |
| `CAL_ICS_ANTONIA` | optional |
| `CAL_ICS_DIMITRA` | optional |

Any further feed is `CAL_ICS_<NAME>` or `CAL_ICS_<NAME>_<SUFFIX>`. Leave a calendar var unset for "calendar not connected".

Do not set `TODAY_STORE=file` (the disk is read-only; the default `asana_tags` is correct). Do not set `READ_ONLY` in production. Vercel sets `VERCEL` and `VERCEL_GIT_COMMIT_SHA` itself. In-memory caches (tag gids, calendars, project list) refill on a cold start; nothing is scheduled in the background. Dates use `Europe/Athens` explicitly, not the server timezone.

After the first deploy: `https://<project>.vercel.app/healthz` → `{"ok":true}`, then `https://<project>.vercel.app/?k=<ACCESS_KEY>`.

## Free-plan behaviour
- Sleeps after 15 min without traffic; the first request after that takes ~30-60 s (cold start). Nothing is lost: state is in Asana.
- Disk is ephemeral: `data/` is recreated empty on each start; the tag-gid cache refills from Asana, calendars refetch (5 min cache).
- 750 free instance hours/month per workspace, enough for one always-reachable service.

## Local check of stateless mode
```
npm ci && npm test
ACCESS_KEY="$(cat /workspace/day-planner-app/data/access_key)" RENDER=true PORT=8799 node server.js
curl localhost:8799/healthz
curl -H "x-access-key: $ACCESS_KEY" localhost:8799/api/board
```
