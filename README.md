# Downloader

A small password-protected file sharing site built with Express, TypeScript and Postgres.

- **Sign in once** at `/login` with the master password, or with a guest name and password.
- The **master** gets an admin page to manage every file and the guest uploaders.
- **Guests** get their own page to manage the files they uploaded. The master can set a maximum file size and a maximum lifetime per guest.
- **Each upload gets its own download password** and an unguessable link.
- Uploads can **expire** and be deleted automatically.
- Files, passwords, sessions and the download history are stored in Postgres.

## How it works

**Signing in** (`/login`): leave the name empty and enter the master password, or enter a guest name and that guest's password. You are sent to `/admin` (master) or `/guest` (guest) and stay signed in for 12 hours or until you sign out.

**Uploading** (`/upload`): reached from the "Upload a file" button on the admin and guest pages. Pick a file, choose a password for this download, and choose when it is deleted. You get a link like `https://your-host/d/<48-character random token>`. The page shows your limits and only offers deletion times you are allowed.


**Downloading** (`/d/<token>`): anyone with the link and that file's download password can download it under its original name. No sign-in is needed.

**What each role can do**

| | Master (`/admin`) | Guest (`/guest`) |
|---|---|---|
| Upload files | yes, no size limit | yes, within their limits |
| See files | all files | only their own |
| See a file's download history (time, IP) | yes | own files |
| Rename, change download password, change expiry, delete | any file | own files |
| Create guests, reset their passwords, set their limits, delete them | yes | no |

**Limits**

- The master has no file size limit from the app. The only cap is 1000 MB, because a file is stored in a single Postgres `bytea` value (1 GB maximum). Large uploads use a lot of memory: expect about twice the file size in RAM during the transfer.
- Each guest can have a **max file size** (1-1000 MB). Without one, the server default `MAX_SIZE_MB` applies.
- Each guest can have a **max expiry**, picked from common choices (10 minutes to 30 days) or a custom amount in minutes, hours or days. When set, the guest's files must expire within that time and "never" is not offered.
- Limits are enforced on the server. The upload page reads them from `/api/limits` to hide options that would be refused.
- Changing a limit affects future uploads only. Existing files are left as they are.

Deleting a guest keeps the files they uploaded (they then belong to nobody, so only the master can manage them) and signs that guest out.

Details:

- The home page (`/`) only links to the sign-in page. It lists no files. Unknown or expired download links return 404.
- Sessions are random 256-bit tokens in an `HttpOnly`, `SameSite=Strict` cookie (also `Secure` over HTTPS). Only a hash of the token is stored in Postgres.
- Passwords are at least 4 characters and are stored as salted PBKDF2-SHA256 hashes (100,000 iterations, built into Node, no extra memory).
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
| `MAX_SIZE_MB` | `100` | Default maximum upload size in MB for guests without their own limit (the master is not affected; hard cap 1000) |
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
- Files uploaded before per-file download passwords existed cannot be downloaded. Re-upload them.
- Passwords hashed with the old scrypt scheme no longer verify. Run `npm run set-password` and re-upload the affected files.

## Database schema

```sql
credentials (role TEXT PRIMARY KEY, salt BYTEA, hash BYTEA)          -- only the 'master' role
guests      (id SERIAL PRIMARY KEY, name TEXT, salt BYTEA, hash BYTEA, created_at TIMESTAMPTZ,
             max_size_mb INT NULL, max_expiry_minutes INT NULL)       -- NULL = default size / no expiry limit
files       (token TEXT PRIMARY KEY, name TEXT, size BIGINT, data BYTEA, uploader TEXT,
             guest_id INT REFERENCES guests ON DELETE SET NULL,
             pw_salt BYTEA, pw_hash BYTEA, expires_at TIMESTAMPTZ NULL, created_at TIMESTAMPTZ)
downloads   (id BIGSERIAL PRIMARY KEY, token TEXT REFERENCES files ON DELETE CASCADE,
             downloaded_at TIMESTAMPTZ, ip TEXT)
sessions    (token_hash TEXT PRIMARY KEY, role TEXT, guest_id INT REFERENCES guests ON DELETE CASCADE,
             expires_at TIMESTAMPTZ)
```

## Limitations

- **Memory use:** each file is held fully in memory during upload and download, and stored as one `bytea` value. A transfer can use about twice the file size in RAM. Keep `MAX_SIZE_MB` modest on small servers. For much larger files, switch to Postgres large objects, which can stream.
- **No HTTPS:** the app serves plain HTTP. Put it behind a reverse proxy that terminates TLS, or the passwords travel unencrypted. This matters most for the master password.
- **Behind a proxy:** set `TRUST_PROXY=1`. Without it, every visitor appears as the proxy's address (they share one rate-limit budget and the download log shows the proxy IP), and the session cookie is not marked `Secure`.
- **Download log keeps IP addresses.** Deleting a file deletes its log. Keep this in mind for privacy rules that apply to you.
- **Expiry is by time only:** there is no "delete after first download" option.
- **Disk space:** Postgres may not return the space of deleted files to the operating system right away.

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
