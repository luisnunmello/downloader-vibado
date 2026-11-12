# Downloader

A small password-protected file sharing site built with Express, TypeScript and Postgres.

- A **master password** gives full control through an admin page.
- The master can create **guest uploaders**, each with their own name and password.
- **Each upload gets its own download password** and an unguessable link.
- Uploads can **expire** and be deleted automatically.
- Files, passwords and the download history are stored in Postgres.

## How it works

**Uploading** (`/upload`): enter the master password, or a guest name and password. Pick a file, choose a password for this download, and optionally a deletion time (10 minutes, 1 hour, 1 day, 7 days, 30 days, or never). You get a link like `https://your-host/d/<48-character random token>`.

**Downloading** (`/d/<token>`): anyone with the link and that file's download password can download it under its original name.

**Admin** (`/admin`): sign in with the master password to:

- see every file: name, size, who uploaded it, when, when it expires, and how many times it was downloaded
- see the download history of a file (time and IP address)
- rename a file, change its download password, change or remove its expiry, or delete it
- create guest uploaders, reset their passwords and delete them

Guests can only upload. They cannot list, change or delete anything, including their own files. Deleting a guest keeps the files they uploaded.

Details:

- The site root and unknown or expired links return 404, so nothing is listed publicly. `/admin` and `/upload` are not linked from anywhere, but they are not secret either: they are protected by the passwords.
- Passwords are at least 4 characters and are stored as salted PBKDF2-SHA256 hashes (100,000 iterations, built into Node, no extra memory).
- Expired files are refused immediately, and a cleanup job deletes them from the database every minute (and once at startup).
- Password attempts (master, guest and download) are rate limited to 10 failures per IP per 15 minutes. The counter is in memory and resets on restart.
- The admin page keeps the master password in memory only and sends it with each request. Reloading the page signs you out. There are no cookies or sessions.
- Guest names are unique (case-insensitive), at most 50 characters, and `master` is reserved.
- Uploads are sent as the raw request body, so no multipart library is needed.

## Quick start with Docker

```sh
cp .env.example .env        # on Windows: copy .env.example .env
# edit .env and set your passwords
docker compose up -d --build
```

Open `http://localhost:3000/admin` or `http://localhost:3000/upload`.

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
| `MAX_SIZE_MB` | `100` | Maximum upload size in MB |
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
- Existing files are marked as uploaded by `master`.
- Files uploaded before per-file download passwords existed cannot be downloaded. Re-upload them.
- Passwords hashed with the old scrypt scheme no longer verify. Run `npm run set-password` and re-upload the affected files.

## Database schema

```sql
credentials (role TEXT PRIMARY KEY, salt BYTEA, hash BYTEA)          -- only the 'master' role
guests      (id SERIAL PRIMARY KEY, name TEXT, salt BYTEA, hash BYTEA, created_at TIMESTAMPTZ)
files       (token TEXT PRIMARY KEY, name TEXT, size BIGINT, data BYTEA, uploader TEXT,
             pw_salt BYTEA, pw_hash BYTEA, expires_at TIMESTAMPTZ NULL, created_at TIMESTAMPTZ)
downloads   (id BIGSERIAL PRIMARY KEY, token TEXT REFERENCES files ON DELETE CASCADE,
             downloaded_at TIMESTAMPTZ, ip TEXT)
```

## Limitations

- **Memory use:** each file is held fully in memory during upload and download, and stored as one `bytea` value. A transfer can use about twice the file size in RAM. Keep `MAX_SIZE_MB` modest on small servers. For much larger files, switch to Postgres large objects, which can stream.
- **No HTTPS:** the app serves plain HTTP. Put it behind a reverse proxy that terminates TLS, or the passwords travel unencrypted. This matters most for the master password.
- **Behind a proxy:** rate limiting and the download log use the client IP. Behind a proxy, you will need `app.set('trust proxy', ...)`, otherwise every visitor appears as the proxy's address and they share one rate-limit budget.
- **Download log keeps IP addresses.** Deleting a file deletes its log. Keep this in mind for privacy rules that apply to you.
- **Expiry is by time only:** there is no "delete after first download" option.
- **Disk space:** Postgres may not return the space of deleted files to the operating system right away.

## Project layout

```
src/server.ts          Startup: migrations, password seeding, expiry cleanup job, listen
src/app.ts             Express app: security headers, static files, routes
src/config.ts          Environment variables and paths
src/db.ts              Postgres pool and migrations
src/password.ts        PBKDF2 hashing and verification
src/auth.ts            Master password and upload authentication (master or guest)
src/guests.ts          Guest uploader queries
src/files.ts           File queries: store, serve, expire, list, edit, download log
src/http.ts            Header and filename helpers
src/rateLimit.ts       In-memory failed-attempt limiter
src/views.ts           Tiny HTML template renderer
src/routes/upload.ts   GET /upload and PUT /api/upload
src/routes/download.ts GET and POST /d/:token
src/routes/admin.ts    GET /admin and the /api/admin JSON API
src/set-password.ts    CLI for changing the master password
views/                 HTML templates (layout, upload, download, admin, message)
public/                CSS and page scripts, served at /static
Dockerfile             Multi-stage Alpine build
docker-compose.yml     App and Postgres
```

Templates use `{{value}}` (HTML-escaped), `{{{value}}}` (raw) and `{{#if value}}...{{/if}}`.
The pages load no inline scripts or styles, and a Content-Security-Policy restricts everything to the site's own origin.
