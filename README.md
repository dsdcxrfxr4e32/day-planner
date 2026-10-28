# Team day planner (box-hosted)

- `server.js`: Node 20 server, no dependencies. Keeps the Asana token server-side ($ASANA_PAT), serves `public/index.html`, exposes a JSON API that proxies Asana.
- `lib.js`: helpers for the D-code (minutes), notes rewriting and dates. `test/lib.test.js` tests them.
- `run.sh start|stop|status`: supervisor loop that restarts the server 3 s after a crash. Log goes to `data/server.log`.
- `data/access_key`: shared-link key. Every request needs `?k=<key>` (otherwise 403). `/healthz` is the only open path.
- Today state: `TODAY_STORE=asana_tags` (the default) adds the tag `TODAY-<Name>` to the Asana task (tags are created on first use, and their gids are cached in `data/tag_gids.json`). `TODAY_STORE=file` uses `data/today.json` instead. Tomorrow works the same way with tags `TOMORROW-<Name>` (file mode: `data/tomorrow.json`); a task is in at most one of Today/Tomorrow (Today wins if both tags exist). Today's load counts Today only; there is no automatic roll-over.
- `READ_ONLY=1` refuses every non-GET Asana call (used for tests).
- `apps-script/Code.gs`: an earlier Apps Script port of the server side (not deployed and not needed for the box version).

API (all need k): GET /api/board · POST /api/completed {i, completed} · POST /api/minutes {i, m} · POST /api/today {i, t, prev} · POST /api/clear-today {entries:[{i,t}]} · POST /api/assign {i, a, from} (a = dm/ak/dd/un; a planned task's TODAY-/TOMORROW- tag moves to the new person) · POST /api/plan {i, from, to} (from/to = {s:'t'|'w', k} or null for Backlog; moves between Backlog/Today/Tomorrow) · GET /api/task/:gid (fresh task for the editor) · POST /api/task/:gid {name?, notes?, due_on?} (only changed fields are sent to Asana; notes whose first line is not a D-code get D15M prepended; a name-only save of a task with no D-code also adds D15M; tasks with no D-code count as 15 min)

UI: clicking a card title/body opens an Asana-style edit pane (name, description, due date; Open in Asana link at the bottom). Clicking the due date on a card opens an inline date picker that saves due_on immediately (Clear removes it).

## Client meetings (calendars)
- `cal.js` (uses the npm package `node-ical`; run `npm install` after copying the app) reads each person's Google Calendar secret iCal feed: env `CAL_ICS_DIMITRIS`, `CAL_ICS_ANTONIA`, `CAL_ICS_DIMITRA`, or the same `KEY=VALUE` lines in `data/cal.env` (re-read on every fetch, so a new person can be connected without a restart). The URLs are secret and are never logged or sent to the browser.
- Cached 5 min; the board's ↻ Refresh forces a fresh fetch (`/api/board?refresh=1`).
- A meeting counts when it has an attendee outside @precisegreece.gr (rooms/resources/group calendars ignored) or its title starts with a 3-digit client code. All-day, cancelled and self-declined events are skipped; recurring events (RRULE/EXDATE/overrides) are expanded; overlaps are merged; days are Europe/Athens.
- The board only receives start, end and title of qualifying meetings. Counters show tasks + meetings against 8:00; a person without a feed shows "calendar not connected".
- Tests: `npm test` (calendar tests use the synthetic `test/fixture.ics`).

## Columns, due dates and new tasks (2026-10-28)
- Placement: a TODAY-/TOMORROW-<Name> tag wins. Without a tag, a task due today (Athens; due_at counts by its Athens date) shows in Today and a task due tomorrow shows in Tomorrow (`src:'d'` on the board item). Overdue tasks stay in Backlog. Counters include these tasks.
- Every move through `/api/plan` also sets the date in the same call: into Today = today, into Tomorrow = tomorrow (date only, replaces any due time), back to Backlog = no due date (due_on and due_at null). Dropping a task where it already is changes nothing.
- `POST /api/task` `{name, notes, due_on, project, a, slot:{s,k}|null}` creates a task (the '+' on a section heading). Name must be more than the prefix (`054a `, `PRE `). Notes get D15M if the first line has no D-code. With a slot it is tagged and dated today/tomorrow. The board's `projects` list (client-code projects and PRE general) is the fallback for a section's project.
- Meetings: each item has a `link` (Google Calendar event, `eid` = base64url of `<eventId> <calendar email>`, split-series `_R…` suffix dropped for instances; day view when the UID is not Google's). A meeting where the person's own PARTSTAT is TENTATIVE is listed with `tent:true` but is not counted (`min`/`n` count only the rest, `nt` = tentative count).

## Calendar: all events (2026-10-28, replaces the client-meeting filter)
- Every timed event is shown and counted (accepted, needs-action, own). Tentative events are shown but not counted. Declined and cancelled events are hidden. Overlaps are merged when counting. Zero-length events show as a compact block (start time only) and add 0. All-day events are thin chips, never counted (`allday:[{title, link}]`). The header reads `Calendar · n · h:mm`. Only title, times and link leave the server.
- Several feeds per person: `CAL_ICS_<NAME>` plus any `CAL_ICS_<NAME>_<SUFFIX>` (e.g. `CAL_ICS_DIMITRIS_PERSONAL`), in env or `data/cal.env`. They are combined into one day. The calendar id for links comes from the feed URL path.

## Hosting on Render (stateless, 2026-10-28)
- Everything required comes from env: `ASANA_PAT`, `ACCESS_KEY` (wins over `data/access_key`; required when `RENDER` is set, the server exits otherwise), `CAL_ICS_*` (wins over `data/cal.env`), `PORT`. Logs go to stdout/stderr.
- Today/Tomorrow live in Asana tags (`TODAY_STORE=asana_tags`, the default). `data/tag_gids.json` is only a cache (also kept in memory); `TODAY_STORE=file` is a box-only fallback and warns on Render.
- Optional `DATA_DIR` moves the data folder. See `DEPLOY.md` and `render.yaml`.
