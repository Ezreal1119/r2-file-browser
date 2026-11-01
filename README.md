# R2 File Browser

The Pages app combines files stored under `tools/` in the `firmware` R2 bucket
with synchronized public product-document links from the Urovo English
materials site.

**协作开发 / 换电脑 / 部署：[COLLABORATION.md](./COLLABORATION.md)**

## Development

Use Node.js 22 or newer, run `npm ci`, then run the test suite:

```sh
npm test
```

Apply the local D1 migration, then run Pages locally:

```sh
npm run db:migrate:local
cp .dev.vars.example .dev.vars
npm run dev
```

Local Secrets can be placed in an untracked `.dev.vars` file. Use Cloudflare's
Turnstile test keys for local testing rather than production keys.

Deploy Pages and its Functions:

```sh
npm run deploy:pages
```

## Admin and AI Setup

The Pages UI has an in-memory Admin mode. After the `ADMIN_PASSWORD` Pages Secret is
verified, the Admin button becomes **AI Setup**, R2 descriptions become
editable, delete controls appear for real R2 files, and a **Sync** button is
shown. Refreshing the page exits Admin mode. Synchronized Urovo descriptions
are also editable in Admin mode; manual values are stored separately from the
generated sync index.

Admin and Uploader passwords are server-only Pages Secrets (`ADMIN_PASSWORD`
and `UPLOADER_PASSWORD`), with no hardcoded fallback. Missing or empty Secrets
disable the corresponding login. The existing production values are configured
in Cloudflare; do not copy them into source or GitHub. Set them with
`npx wrangler pages secret put ADMIN_PASSWORD --project-name=r2-file-browser`
and the equivalent command for `UPLOADER_PASSWORD` when provisioning a new
project. Redeploy after changing Secrets.

Admin mode also exposes **Label List** and **Logs**. Labels and per-item assignments are
stored in the small R2 index `settings/labels.json`, so labeling a large file
never rewrites that file. Labels can be assigned to both R2 files and
synchronized Urovo links from the Description dialog. The public Label filter
supports multiple selections with AND semantics; deleting a label from Label
List removes it from every item automatically.

**Auto Labeling** is available in AI Setup and uses the currently saved AI
provider settings. It classifies only uploaded files
that currently have no label, in batches of at most 20 filenames. The model
may choose exactly one existing Label List value for a clearly identifiable
file; uncertain files stay unlabeled. Admin reviews the suggestions, can
uncheck individual items, and confirms before anything is written. Application
rechecks that each file still exists, is still unlabeled, and that the chosen
label still exists; synchronized external links and already-labeled files are
not changed. This uses the saved AI provider configuration and API Key Secret,
but does not consume public AI-search D1 quota or require Turnstile.

Manual descriptions for synchronized records are stored in
`settings/description-overrides.json`, keyed by the record's stable sync key.
An override takes precedence over the generated description. Clearing it
restores the generated description without changing the synchronized index.

AI Setup stores the OpenAI-compatible Base URL, model name, and disabled/enabled
state in the shared R2 bucket at:

```text
settings/ai.json
```

The API key is never written to R2 or returned to the browser. Configure it as
the `AI_API_KEY` Secret on the production Pages project:

```sh
npx wrangler pages secret put AI_API_KEY --project-name=r2-file-browser
```

Wrangler will prompt for the secret value without adding it to shell history.
Redeploy Pages after creating or changing the secret so the production
deployment receives the new value:

```sh
npm run deploy:pages
```

The deployed Agent calls the configured OpenAI-compatible Chat Completions API
directly and uses standard `tools` / `tool_calls`; it does not use an Agent SDK.
For DeepSeek URLs it explicitly disables Thinking Mode. One question may make
at most eight library searches and ten model calls, and the final file IDs are
resolved again against the authoritative R2 + Urovo index. The server safely
normalizes common Tool Call variations such as omitted empty matches, numeric
strings, and the legacy `reason` field while continuing to reject invented file
IDs.

### AI search security setup

AI search is disabled by default and fails closed until every item below is
configured.

1. In **Cloudflare Dashboard → Turnstile**, create a **Managed** widget named
   `Urovo Library AI`. Allow `tool-files.patrick-shenzhen.org`. Copy its Site
   Key and Secret Key.
2. Store all required values as Pages Secrets:

```sh
npx wrangler pages secret put TURNSTILE_SITE_KEY --project-name=r2-file-browser
npx wrangler pages secret put TURNSTILE_SECRET_KEY --project-name=r2-file-browser
npx wrangler pages secret put AI_SESSION_SECRET --project-name=r2-file-browser
```

For `AI_SESSION_SECRET`, generate a new random value with `openssl rand -hex 32`
and paste it at Wrangler's hidden prompt. The Turnstile Site Key is returned to
the browser as public configuration; storing it alongside the other deployment
configuration keeps setup consistent. Never place any of these values in this
repository.

The D1 database `r2-file-browser-ai` has already been created and is bound as
`AI_DB` in `wrangler.toml`. Its schema lives in `migrations/`. Apply outstanding
production migrations with:

```sh
npm run db:migrate:remote
```

For a fresh Cloudflare account, create the database first, replace the
`database_id` in `wrangler.toml` with the returned ID, then apply the migration:

```sh
npx wrangler d1 create r2-file-browser-ai
npm run db:migrate:remote
```

Deploy Pages after adding or changing a binding or Secret:

```sh
npm run deploy:pages
```

Finally open the site, unlock Admin, choose **AI Setup**, verify Base URL and
model, choose whether **Require human verification** should be enabled, switch
on **AI Enabled**, and save. With verification enabled, the Turnstile keys are
required; with it disabled, the API key, session Secret, R2, and D1 binding are
still required.

When **Require human verification** is enabled, every web task requires a
single-use Turnstile token. When disabled, the widget is skipped. In both
modes, D1 enforces one active task per visitor, 3 tasks per minute, 20 per
visitor per UTC day, and 200 total per UTC day. A stale active-task lock
expires after 180 seconds. MCP remains unchanged and does not use Turnstile.

## Uploader mode and large uploads

- Unlock the existing Admin dialog with the configured uploader password to enter Uploader mode. The original Admin password still enters full Admin mode; both roles can use **Upload** and manage files in the new uploader bucket.
- Uploader cannot change existing tools or synchronized documents, or use AI Setup, Logs, Sync, or Label List. Admin retains these features and can also label uploader files.
- New files are **publicly searchable** through ordinary search, AI search, HTTP `/api/files`, and both MCP modes. They carry an **UPLOADER FILE** badge. Anyone with the download link can download without logging in.
- The dedicated Uploader view does not show the AI composer. With an empty search field it lists only files from the uploader bucket; after a keyword is entered it searches the entire unified library and pins matching uploader-bucket files ahead of other results. This presentation rule applies only to Uploader mode; public and Admin views are unchanged.
- Binary files and their Description records live in the separate `r2-file-browser-uploader` bucket (`UPLOADER_BUCKET`). Description editing never rewrites the binary. Existing tools upload/download endpoints are unchanged.
- The upload dialog accepts an optional Description (up to 1500 characters) below the file selector. It is locked during transfer and published together with the file's record in the existing completion request, without a separate save request. Failed uploads retain the draft for retry; a successful upload clears it and closes the dialog. Omitting it preserves the existing blank-description behavior.
- Upload one file at a time, up to **5 GiB**, with fixed 16 MiB parts. Transfers start with three parallel requests and adapt within **2–4**: a fourth request is trialled after successful parts and a usable throughput window; it is kept only with at least a 10% throughput gain. Retries reduce concurrency and apply a 30-second recovery cooldown; existing transfers finish normally when the limit drops.
- Failed parts retry up to three times using exponential backoff with jitter. Rate-limit responses pause new attempts, using `Retry-After` when supplied (automatic waits are capped at 30 seconds); permanent 4xx failures stop immediately. Start/finalize/cancel requests have a 30-second timeout. Closing the upload interrupts backoff immediately. **Retry upload** keeps completed parts while the page remains open; this version does not resume across a page refresh or browser restart.
- Speed uses a rolling eight-second window of bytes sent, including retransmitted bytes, so it follows changing network conditions instead of showing the lifetime average. Remaining time is an estimate and can increase after a retry or network slowdown. The upload path and R2 access permissions are unchanged.
- The dialog is a single-file flow: the entire dashed area opens the file picker, without redundant Select/Change buttons. After selection, the filename and size replace the drop prompt; progress and speed appear only after **Upload** is clicked, and the Upload button becomes visibly disabled during transfer. There is no separate Cancel button. Before transfer starts, **×** closes without confirmation. During an upload, **×** asks for confirmation and cleans uploaded parts; finalizing cannot be interrupted. A successful upload refreshes the list and closes the dialog automatically. Navigating away prompts only after an upload has started (the browser may suppress its standard warning).
- Both management roles receive an in-memory signed upload token valid for 24 hours, using the existing `AI_SESSION_SECRET`; refreshing requires unlocking again. Passwords and signing secrets are not shipped to the browser.

One-time provisioning (already performed for this rollout):

```sh
npx wrangler r2 bucket create r2-file-browser-uploader
npx wrangler r2 bucket lifecycle add r2-file-browser-uploader cleanup-sessions sessions/ --expire-days 2 --force
npx wrangler r2 bucket lifecycle add r2-file-browser-uploader cleanup-incomplete objects/ --abort-multipart-days 1 --force
```

`wrangler.toml` includes the production binding. Keep the bucket itself private; the Pages `/shared-upload/<opaque-id>/<filename>` route serves completed files as attachments and supports range downloads. Deploy normally with `npm run deploy:pages`. No new Worker, database, or API key is needed.

### Get Firmware (optional mobile API integration)

Admin and Uploader can open **Upload → Get Firmware** after the two Secrets below are configured. With either missing, the entry stays hidden. This feature uses the existing mobile RD PRO API; it does not run FTP downloads inside Pages or use the browser's local-file upload pipeline.

```sh
npx wrangler pages secret put FIRMWARE_API_BASE_URL --project-name=r2-file-browser
npx wrangler pages secret put FIRMWARE_API_TOKEN --project-name=r2-file-browser
npm run deploy:pages
```

Enter the HTTPS base address of the mobile API service (without `/api/mobile`) for `FIRMWARE_API_BASE_URL`. It must be reachable from Cloudflare. Enter only the existing mobile Bearer token, without the `Bearer ` prefix, for `FIRMWARE_API_TOKEN`. Both values remain on the server.

- Fill Internal model, firmware date (defaults to today in Beijing), and Index (01–10). Search returns matching ZIPs; choose one and confirm **Get selected firmware**.
- Pages calls `/api/mobile/firmware/internal/rd/find`, `/api/mobile/firmware/internal/rd/upload`, and the created `/api/mobile/jobs/{id}`. Only verified search candidates can start tasks. An active task is reused only when its filename matches; another file's task returns a busy message.
- Progress shows queued/finding/downloading/uploading/ready stages. Percentage, transferred bytes, speed and ETA come from actual job details; an indeterminate progress bar is used when numeric progress is unavailable. Polling is every two seconds, with limited retry/backoff and a manual **Resume checking** option.
- Closing the progress window does not cancel the server job. Reopen Get Firmware to resume viewing it; a job ID can be recovered after a page refresh within the same browser session (unlock Admin/Uploader again first). The receipt expires after 24 hours. The mobile service's existing global one-job limit remains in effect.
- A successful result is verified against the existing `FIRMWARE_BUCKET` object at `firmware/<filename>` before being published. The binary stays there, and a stable reference record is added to the uploader library, so ordinary search, AI and MCP can find it without making another copy. Existing files are reused; manual Description and Labels are preserved.
- Description edits affect only the reference record. Removing a firmware reference from this library does **not** delete the shared source firmware used by the mobile app. Normal locally uploaded files retain their existing deletion behavior.

Metadata cleanup rules (configured during rollout):

```sh
npx wrangler r2 bucket lifecycle add r2-file-browser-uploader cleanup-firmware-queries firmware-queries/ --expire-days 2 --force
npx wrangler r2 bucket lifecycle add r2-file-browser-uploader cleanup-firmware-jobs firmware-jobs/ --expire-days 2 --force
```

No new Worker or database is required. The mobile app and its backend are not modified.

## Activity logs

D1 stores the last 30 days of `copy`, `download`, and `ai_search` activity.
File events contain the file key, name, and source. AI events contain the
user's original prompt, the Agent's user-facing response, or a sanitized error
when the request fails; matched file lists are not stored. Logging is scheduled
in the background and never blocks Copy, download navigation, or delivery of an
AI result. Each new write removes records older than 30 days.

After unlocking Admin mode, choose **Logs** to download a CSV export. Every CSV
record occupies one physical line even when a prompt or response originally
contained line breaks. The public event endpoint accepts only the fixed Copy
and Download event types and limits each anonymous visitor to 120 events per
minute.

## Urovo product-document sync

The separate Worker in `sync-worker/` logs in to the Urovo English materials
site, crawls the catalog in Queue batches, and atomically publishes the last
complete index to:

```text
indexes/urovo-en/files.json
```

Automatic synchronization runs every Sunday at 03:00 Asia/Shanghai
(`0 19 * * 6` in UTC). An Admin can also start synchronization manually from
the Pages UI; the Worker and Queue perform each crawl in protected batches.
Failed or incomplete runs never replace the last complete index.

### First-time Cloudflare setup

Create the Queue once:

```sh
npx wrangler queues create urovo-library-sync
```

Deploy the Worker:

```sh
npm run deploy:sync
```

Set secrets interactively. Do not put their values in this repository:

```sh
npx wrangler secret put UROVO_MEMBER --config sync-worker/wrangler.toml
npx wrangler secret put UROVO_PASSWORD --config sync-worker/wrangler.toml
npx wrangler secret put SYNC_TOKEN --config sync-worker/wrangler.toml
```

Set the same `SYNC_TOKEN` as a production Pages Secret. Pages uses it only for
the server-to-server request to the Sync Worker and never sends it to the
browser:

```sh
npx wrangler pages secret put SYNC_TOKEN --project-name=r2-file-browser
```

If the Worker hostname changes, configure the optional production Pages
variable `SYNC_WORKER_URL`; otherwise the current deployed Worker URL is used.
Redeploy both services after configuration:

```sh
npm run deploy:sync
npm run deploy:pages
```

Trigger the first sync manually, replacing the hostname with the deployed
Worker URL:

```sh
curl -X POST \
  -H "Authorization: Bearer $SYNC_TOKEN" \
  https://urovo-library-sync.<workers-subdomain>.workers.dev/sync
```

Check progress:

```sh
curl \
  -H "Authorization: Bearer $SYNC_TOKEN" \
  https://urovo-library-sync.<workers-subdomain>.workers.dev/status
```

Only deploy the Pages compatibility changes after `/status` reports
`"state":"complete"`. The current production Pages binding is
`FIRMWARE_BUCKET` → `firmware`; the sync Worker uses the same bucket.

### Sync behavior

- New source documents are added.
- Changed public URLs or metadata update the existing stable record.
- Documents absent from a fully successful crawl are removed immediately.
- Synchronized descriptions are generated from product metadata. Admin edits
  are stored as R2 overrides and never modify the generated index.
- Sync metadata maintenance is Delta-only: added records start without manual
  labels or overrides, updated and unchanged records preserve them, and
  deleted keys are removed from both persistence indexes.
- A failed Delta cleanup is recorded in the run status and audit report and is
  retried before the next sync; no full-library cleanup is performed.
- Login, network, or parser failures retain the previous published index and
  are recorded in `indexes/urovo-en/status.json`.
- Every successful run writes a detailed discrepancy report to
  `indexes/urovo-en/audits/{runId}.json`. The Admin UI displays added, updated,
  deleted, and unchanged counts plus field-level before/after changes.
- The persistent report catalog is stored at
  `indexes/urovo-en/audits/index.json`. Select **Sync Report** in the Admin sync
  dialog to browse every completed run and open its detailed Delta.

### GitHub SDK automatic sync

An independent daily task checks the five main SDK download links in
`UrovoSdkCenter/docs-site` at **03:10 Asia/Shanghai**. The existing weekly
Urovo catalog schedule is unchanged. Downloads are pinned to one commit;
Git blob hashes (or the actual SHA-256 for Git LFS) detect content changes.
Unchanged archives are not downloaded or rewritten. Git LFS pointers are
resolved to their actual archives, with checksum validation on the R2 put.

The task owns only `tools/auto-sdk/`. Each category keeps its latest package;
an old task-owned filename is retired only after a replacement is stored.
Other tools, uploader files, labels and the catalog index are not rewritten.
These files automatically participate in web, HTTP API, AI and MCP search.
Descriptions use `<SDK title> - Last Sync: YYYY-MM-DD`, dated on the actual
successful download day in Beijing time. Unchanged checks preserve that date.
Scanner/RFID main links currently point to SDK development-document packages;
secondary offline API archives and separate release repositories are excluded.

State and resumable reports live under `indexes/github-sdk/`, independently
of `indexes/urovo-en/`. Queue retries skip already completed items. Failures
are reported and retried without deleting the previous working package.
Optional Worker secret `GITHUB_TOKEN` increases the GitHub API rate limit;
no token is required for public repository access.

Admin-only `POST /api/sdk-sync` starts a run; `GET /api/sdk-sync` returns its
status and report (including descriptions and public download links). Both
use the existing `X-Admin-Password` header. Worker `/sdk-sync` and `/sdk-status`
use the existing `SYNC_TOKEN`, which never reaches the browser. No new UI
controls or changes to the existing Sync Reports are required.

## MCP

This site also exposes a read-only MCP server at `/ai-powered/mcp` for other AI
agents. The former `/mcp` route is closed.

Production URL:

`https://tool-files.patrick-shenzhen.org/ai-powered/mcp`

Cursor / Claude config example:

```json
{
  "mcpServers": {
    "urovo-tools": {
      "url": "https://tool-files.patrick-shenzhen.org/ai-powered/mcp"
    }
  }
}
```

When **AI Enabled** is off, the existing tools remain available:

- `search_files` — search R2 files and synchronized product documents by name,
  product, category, document type, language, or description. Arrays default
  to OR; pass `match: "and"` to require every term.
- `get_file` — get metadata and the public download URL.
- `get_description` — get human notes or a synchronized product description.

When **AI Enabled** is on, MCP exposes only `search_with_prompt`. Pass the
user's original natural-language search request in the required `prompt`
field. MCP then uses the same AI Agent, retrieval strategy, eight-search limit,
authoritative ID validation, and ranked result format as the web UI. Every
matched file includes the LLM-generated `comment` explaining the match. Its
tool description explicitly covers the remote Urovo catalog's PC tools,
utilities, upgrade tools, firmware, SDKs, drivers, software, APKs, demos, and
product documents so MCP callers do not mistake those downloads for local
workspace files.

The MCP AI entry point intentionally does not use Turnstile, visitor cookies,
or the web UI's per-visitor D1 quota. Keep the route private if provider usage
must be restricted.
