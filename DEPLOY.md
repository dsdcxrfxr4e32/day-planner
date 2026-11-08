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

After the first deploy, before Google login is turned on: `https://<project>.vercel.app/healthz` → `{"ok":true}`, then `https://<project>.vercel.app/?k=<ACCESS_KEY>`.

## Google login (replaces `?k=` once it is on)

Create the OAuth client in Google Cloud, then set the env vars. Until `GOOGLE_CLIENT_ID` is set, the shared `?k=` key keeps working, so production does not break during setup.

1. Open [Google Cloud Console](https://console.cloud.google.com/) with a Precise Greece account. Create a project, or pick one that already belongs to precisegreece.gr.
2. APIs & Services → OAuth consent screen. If the Cloud project is inside the precisegreece.gr organisation, choose **Internal** so only that Workspace can sign in. Otherwise choose **External**, leave the app in Testing, and add `dm@precisegreece.gr`, `ak@precisegreece.gr`, `dd@precisegreece.gr`, and `dc@precisegreece.gr` as test users.
3. APIs & Services → Credentials → Create credentials → **OAuth client ID**. Application type: **Web application**. Name it Plano.
4. Authorized JavaScript origins: `https://precise-plano.vercel.app` (no path, no trailing slash). Leave Authorized redirect URIs empty. This login uses the Google button on the page, not a redirect.
5. Create. Copy the **Client ID** (it ends in `.apps.googleusercontent.com`). The client secret is not used.
6. On Vercel → the Plano project → Settings → Environment Variables, set for Production:
   - `GOOGLE_CLIENT_ID` = that client id
   - `SESSION_SECRET` = a long random string (for example 32+ bytes from a password generator). Do not commit it.
   - `ALLOWED_EMAILS` is optional. If you leave it unset, the allowlist is `dm@precisegreece.gr`, `ak@precisegreece.gr`, `dd@precisegreece.gr`, `dc@precisegreece.gr`. Set it only to replace that list (comma-separated).
7. Redeploy. Open `https://precise-plano.vercel.app/` with no key. You should see Plano and **Sign in with Google**. After a successful sign-in the address bar stays free of `?k=`. Any other Google account sees "This account isn't allowed".
8. From then on, `?k=` and `ACCESS_KEY` do not open the app. `/healthz` stays public for uptime checks. To keep the old key on Render while Vercel uses Google, set `GOOGLE_CLIENT_ID` and `SESSION_SECRET` only on Vercel.

`ACCESS_KEY` is still required on Render and on Vercel if `GOOGLE_CLIENT_ID` is not set.

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
