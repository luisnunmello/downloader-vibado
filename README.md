# Downloader

A small password-protected file sharing site built with Express, TypeScript and Postgres.

- **Sign in once** at `/login` with the master password, or with a guest name and password.
- The **master** gets an admin page to manage every file and the guest uploaders.
- **Guests** get their own page to manage the files they uploaded. The master can set a maximum file size, a maximum lifetime and a total storage quota per guest.
- **Each upload gets its own download password** (or none, if you choose) and an unguessable link.
- Uploads can **expire** and be deleted automatically.
- Files are stored on disk (`DATA_DIR`); Postgres holds the passwords, sessions, file details and the download history.
- **Previews:** images, videos and text files can be previewed in the browser before uploading (nothing is sent) and, after entering the password, before downloading. HTML and SVG are never shown inline, so a shared file cannot run scripts. Previews count in the download history.
- **Link embeds:** for downloads without a password, WhatsApp, Discord and similar apps show a card with the file name and size, and show images and videos inline. Protected downloads show nothing about the file. Behind a reverse proxy, set `TRUST_PROXY` so the embedded links use `https` and your real host name.
- **Cutting videos:** when you choose a video (mp4, webm, ogv) on the upload page you can set a start and end time, and only that part is stored. On an existing video, the "Cut video" button in the file list does the same and replaces the original with the clip. Cuts use ffmpeg without re-encoding: fast and lossless, but the start snaps to the nearest earlier keyframe. The Docker image includes ffmpeg; without it on the server, the cut options are hidden.

## How it works

**Signing in** (`/login`): leave the name empty and enter the master password, or enter a guest name and that guest's password. You are sent to `/admin` (master) or `/guest` (guest) and stay signed in for 12 hours or until you sign out.

**Uploading** (`/upload`): reached from the "Upload a file" button on the admin and guest pages. Pick a file, choose a password for this download (or tick "No password"; guests can do this too), and choose when it is deleted. You get a link like `https://your-host/d/<48-character random token>`. The page shows your limits and only offers deletion times you are allowed.


**Downloading** (`/d/<token>`): anyone with the link and that file's download password can download it under its original name. No sign-in is needed. A file uploaded with "No password" can be downloaded by anyone with the link; its page still shows a Download button, so link previews and crawlers do not trigger or log a download.

**What each role can do**

| | Master (`/admin`) | Guest (`/guest`) |
|---|---|---|
| Upload files | yes, no size limit | yes, within their limits |
| See files | all files | only their own |
| See a file's download history (time, IP) | yes | own files |
| Rename, set / change / remove the download password, change expiry, delete | any file | own files |
| Create guests, reset their passwords, set their limits, delete them | yes | no |

**Limits**

- The master has no per-user size limit. The **server maximum** applies to everyone, the master included. It starts at 1000 MB and the master can change it, up to 1 TB, in the app under "Server settings" on the admin page. Files are streamed to and from disk, so memory use stays small whatever the file size; what limits you is free disk space (shown on the same page) and, behind a reverse proxy, the proxy's own upload limit (for nginx, `client_max_body_size`).
- Each guest can have a **max file size** (in MB, up to the server maximum). Without one, the server default `MAX_SIZE_MB` applies.
- Each guest can have a **max expiry**, picked from common choices (10 minutes to 30 days) or a custom amount in minutes, hours or days. When set, the guest's files must expire within that time and "never" is not offered.
- Each guest can have a **total storage quota** in MB: the combined size of all their files that have not expired. Deleting or expiring a file frees space. An upload that does not fit in what is left is refused, and the check is repeated atomically when the file is stored, so simultaneous uploads cannot exceed the quota. The upload page shows "Storage used: X of Y", and the admin page shows each guest's usage.
- Limits are enforced on the server. The upload page reads them from `/api/limits` to hide options that would be refused.
- Changing a limit affects future uploads only. Existing files are left as they are.

Deleting a guest keeps the files they uploaded (they then belong to nobody, so only the master can manage them) and signs that guest out.

Details:

- The home page (`/`) only links to the sign-in page. It lists no files. Unknown or expired download links return 404.
- Sessions are random 256-bit tokens in an `HttpOnly`, `SameSite=Strict` cookie (also `Secure` over HTTPS). Only a hash of the token is stored in Postgres.
- Passwords can be any length (they only must not be empty; for an open download choose "No password") and are stored as salted PBKDF2-SHA256 hashes (100,000 iterations, built into Node, no extra memory).
- Expired files and sessions are cleaned up every minute (and once at startup). Expired files are refused immediately, even before cleanup.
- Failed attempts (sign-in and download passwords) are rate limited to 10 per IP per 15 minutes. The counter is in memory and resets on restart.
- Other people's file tokens are never confirmed: managing a file you do not own returns 404.
- Guest names are unique (case-insensitive), at most 50 characters, and `master` is reserved.
- Uploads are sent as the raw request body, so no multipart library is needed.

## Quick start with Docker

```sh
cp .env.example .env        # on Windows: copy .env.example .env
# edit .env and set your passwords
docker compose up -d --build
```

Open `http://localhost:3000` and sign in with the master password.

The compose file runs the app (`node:22-alpine`) and Postgres (`postgres:17-alpine`). Postgres is not published to the host, and its data lives in the `pgdata` volume.

## Running without Docker

Requirements: Node.js 20+ and a Postgres database that already exists. The app creates its tables on startup, but not the database itself.

```sh
npm install
export DATABASE_URL=postgres://user:pass@localhost:5432/downloader
export MASTER_PASSWORD=your-master-password
npm run dev                 # or: npm run build && npm start
```

On PowerShell, set variables with `$env:NAME="value"` instead of `export`.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | `postgres://postgres:postgres@localhost:5432/downloader` | Postgres connection string |
| `MASTER_PASSWORD` | none | Seeds the master password on first start |
| `PORT` | `3000` | HTTP port |
| `DATA_DIR` | `./data` | Folder for uploaded files (`/data` in Docker, a named volume) |
| `MAX_SIZE_MB` | `100` | Default maximum upload size in MB for guests without their own limit (never above the server maximum, which the master sets in the app; the server maximum is at most 1 TB) |
| `TRUST_PROXY` | unset | Set to `1` (or an Express trust-proxy value) when behind a reverse proxy |
| `DB_PASSWORD` | `downloader` | Postgres password (Docker Compose only) |

`MASTER_PASSWORD` only seeds the database when no master password is stored yet. After the first start it is ignored. The old name `UPLOAD_PASSWORD` is still accepted as a fallback.

## Changing the master password

```sh
npm run set-password -- "new-password"
```

This needs the dev dependencies and a reachable `DATABASE_URL`. The Docker image does not include the script, so run it from a local checkout pointed at the database.

## Upgrading from earlier versions

On startup the app migrates the database in place:

- The stored upload password becomes the master password.
- Existing files are marked as uploaded by `master`. Files uploaded by a guest are linked to that guest by name.
- Uploading moved from the admin and guest pages to its own page, `/upload`.
- Files uploaded before per-file download passwords existed stay unavailable (they are not made public). Open the file in the admin page and use "Set password" to make it downloadable again, or "Remove password" to share it freely.
- The short-lived per-guest "max number of files" setting is replaced by the storage quota; its column is dropped.
- Files that older versions kept inside Postgres are moved to disk automatically on the first start (then the old storage is dropped). If a move fails, nothing is dropped and the log says which file.
- Passwords hashed with the old scrypt scheme no longer verify. Run `npm run set-password` and re-upload the affected files.

## Database schema

```sql
credentials (role TEXT PRIMARY KEY, salt BYTEA, hash BYTEA)          -- only the 'master' role
guests      (id SERIAL PRIMARY KEY, name TEXT, salt BYTEA, hash BYTEA, created_at TIMESTAMPTZ,
             max_size_mb INT NULL, max_expiry_minutes INT NULL,        -- NULL = default size / no expiry limit
             max_total_mb INT NULL)                                    -- NULL = no limit
files       (token TEXT PRIMARY KEY, name TEXT, size BIGINT, uploader TEXT,        -- contents are on disk, not here
             guest_id INT REFERENCES guests ON DELETE SET NULL,
             pw_salt BYTEA, pw_hash BYTEA, no_password BOOLEAN, expires_at TIMESTAMPTZ NULL, created_at TIMESTAMPTZ)
settings    (key TEXT PRIMARY KEY, value TEXT)                       -- e.g. the server maximum size
downloads   (id BIGSERIAL PRIMARY KEY, token TEXT REFERENCES files ON DELETE CASCADE,
             downloaded_at TIMESTAMPTZ, ip TEXT)
sessions    (token_hash TEXT PRIMARY KEY, role TEXT, guest_id INT REFERENCES guests ON DELETE CASCADE,
             expires_at TIMESTAMPTZ)
```

## Limitations

- **Where files are stored:** on disk, in `DATA_DIR/files` (the `files` Docker volume, mounted at `/data`), one file per download token. Postgres holds only the details (names, passwords, expiry, owners, download history). **Back up both the database and the files volume**; one without the other is incomplete. An upload is written to a temporary `.part` file and only becomes a real file once its database row is saved, so a failed upload leaves nothing behind.
- **No HTTPS:** the app serves plain HTTP. Put it behind a reverse proxy that terminates TLS, or the passwords travel unencrypted. This matters most for the master password.
- **Behind a proxy:** set `TRUST_PROXY=1`. Without it, every visitor appears as the proxy's address (they share one rate-limit budget and the download log shows the proxy IP), and the session cookie is not marked `Secure`.
- **Download log keeps IP addresses.** Deleting a file deletes its log. Keep this in mind for privacy rules that apply to you.
- **Expiry is by time only:** there is no "delete after first download" option.
- **Disk space:** deleted and expired files are removed from disk right away. Watch the free space shown on the admin page.

## Project layout

```
src/server.ts          Startup: migrations, password seeding, cleanup job, listen
src/app.ts             Express app: security headers, static files, home page, routes
src/config.ts          Environment variables and paths
src/db.ts              Postgres pool and migrations
src/password.ts        PBKDF2 hashing and verification
src/auth.ts            Master password and sign-in (master or guest)
src/session.ts         Sessions in Postgres, cookie reading, requireAuth / requireMaster
src/guests.ts          Guest uploader queries, including their limits
src/limits.ts          What a signed-in user may upload (size and expiry)
src/files.ts           File queries: store, serve, expire, list, edit, download log
src/http.ts            Header and filename helpers
src/rateLimit.ts       In-memory failed-attempt limiter
src/views.ts           Tiny HTML template renderer
src/routes/auth.ts     /login, /api/login, /api/logout
src/routes/panel.ts    /admin, /guest and /upload pages
src/routes/files.ts    /api/files (upload, list, edit, delete, download history) and /api/limits
src/routes/guests.ts   /api/guests (master only)
src/routes/download.ts GET and POST /d/:token
src/set-password.ts    CLI for changing the master password
views/                 HTML templates (layout, home, login, panel, upload, download, message)
public/                CSS and page scripts (common.js is shared), served at /static
Dockerfile             Multi-stage Alpine build
docker-compose.yml     App and Postgres
```

Templates use `{{value}}` (HTML-escaped), `{{{value}}}` (raw) and `{{#if value}}...{{/if}}`.
The pages load no inline scripts or styles, and a Content-Security-Policy restricts everything to the site's own origin.
