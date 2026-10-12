# Self-hosting Argos (WakeCap fork)

WakeCap runs this fork of [argos-ci/argos](https://github.com/argos-ci/argos) on its own infrastructure, with no
Argos subscription, as the visual review step for Wakecore's Storybook (the job Chromatic used to do).

Upstream does not support or document self-hosting. This folder is what it took to make it work, what still does
not, and how to run it on AWS.

Forked from upstream `0894b0c` (2026-10-07). Keep the changes small so the fork can be rebased onto upstream.

## Status

Tried locally on 2026-10-12 with 30 real Wakecore stories, and a GitHub App installed on a sandbox repository
(`wakecap/argos-sandbox`):

| Step                                                                            | Result                                                                                                      |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Sign up and sign in with an emailed code, no email service                      | Works: the code is read from Redis                                                                          |
| Create a project with no GitHub link                                            | Works                                                                                                       |
| Upload screenshots with the official CLI (`@argos-ci/cli upload`)               | Works, straight to our storage (MinIO locally, S3 on AWS)                                                   |
| Compare a branch with the `main` baseline                                       | Works: 3 changed, 1 added, 1 removed, 26 unchanged, as expected                                             |
| Review in the browser: side-by-side diff, approve or reject each change, submit | Works                                                                                                       |
| Create a team without Stripe, and upload to its project                         | Works after fix 6                                                                                           |
| Sign in with GitHub                                                             | Works                                                                                                       |
| Install the GitHub App on a repository, and Argos hears about it                | Works (locally through a smee.io relay, see [GitHub App](#github-app))                                      |
| Import a GitHub repository as a project                                         | Works                                                                                                       |
| Commit status on the PR                                                         | Works: `argos` stays failing ("waiting for your decision") until the changes are approved, then turns green |
| Comment on the PR                                                               | Works: posted by the App's bot, and updated after the review ("Approved by …")                              |

Checks on the changes: the backend type-checks, and 862 of 864 unit tests pass. The two failures are in storage
tests that call real AWS S3 and need AWS credentials.

## What we changed, and why

| #   | Problem                                                                                                                                                                                | Fix                                                                                                                                              |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Screenshots could only be stored on AWS S3                                                                                                                                             | `S3_ENDPOINT` and `S3_FORCE_PATH_STYLE` point it at any S3-compatible store (`storage/s3.ts`, `config/index.ts`)                                 |
| 2   | The Docker build fails outside Argos's CI: `@graphql-codegen/add` is installed but hidden from the root (their CI probably never runs that step, as it restores it from a build cache) | Declared it as a root dev dependency                                                                                                             |
| 3   | `NODE_ENV=production` forces https, with no switch to turn it off                                                                                                                      | `SERVER_SECURE` and `SERVER_HTTPS_REDIRECT`                                                                                                      |
| 4   | Production mode crashes on boot without a Resend (email service) key                                                                                                                   | Email is optional: without a key, sending is skipped and logged (`email/send.ts`)                                                                |
| 5   | The browser blocked screenshots from non-AWS storage, and upgraded every http request to https                                                                                         | The Content-Security-Policy allows the `S3_ENDPOINT` origin, and only upgrades to https when `SERVER_SECURE` is on (`web/security-headers.ts`)   |
| 6   | Creating a team sends you to a Stripe checkout                                                                                                                                         | Without Stripe, a new team gets an unlimited `self-hosted` plan instead (`database/services/self-hosted-plan.ts`, `graphql/definitions/Team.ts`) |

Personal accounts need no change: with no `free` plan in the database, they have no screenshot limit.

## Run it locally

Needs Docker. Everything runs on offset ports (Postgres 55432, RabbitMQ 5673, Redis 6381, MinIO 9100, Argos 4002)
so it can sit next to other stacks.

```bash
cd self-host
cp .env.example .env    # then fill in SERVER_SESSION_SECRET and ENCRYPTION_KEY with `openssl rand -hex 32`
docker compose up -d --build
```

The first build takes about 5 minutes and makes a 3.6 GB image. On first start, Postgres loads
`apps/backend/db/structure.sql`; after that, the `migrate` step applies any newer migrations before the app starts.

1. Open <http://app.argos.localhost:4002/signup>, pick "personal projects" and sign up with any email.
2. No email is sent. Read the code from Redis:

   ```bash
   docker compose exec redis redis-cli GET "email_verification:you@example.com"
   ```

3. Create a project ("Create a project without Git") and copy its token from the project page.
4. Upload a folder of PNGs from inside a git repository:

   ```bash
   ARGOS_TOKEN=<project token> ARGOS_API_BASE_URL=http://api.localtest.me:4002/v2/ npx @argos-ci/cli upload ./screenshots
   ```

   The first build on `main` becomes the baseline. Builds on other branches are compared with it.

Why `api.localtest.me` and not `api.localhost`: the CLI rejects an API address whose last part is longer than six
letters. `localtest.me` is a public name that points back to your machine. A real domain (`api.argos.wakecap.com`)
has no such problem.

MinIO's console is at <http://localhost:9101> (user `argos`, password `argos-local-only`).

Why `app.argos.localhost` and not `app.localhost`: the session cookie has to be shared by the `app.` and `api.` hosts,
because GitHub sign-in sets it through the API host. Browsers refuse a cookie for a bare `localhost`, so both hosts sit
under `argos.localhost` and `SESSION_DOMAIN=argos.localhost`.

## GitHub App

The App signs people in with GitHub, lets a project import a repository, and posts the `argos` commit status and a
comment on each PR. The status stays failing until someone approves the changes in Argos, so making `argos` a
required check in branch protection blocks the merge, as Chromatic did. One App does all of it; upstream's second
"light" App is not needed.

**Create it** in the organisation: Settings → Developer settings → GitHub Apps → New GitHub App. Use one App per
environment: the URLs differ, and production keys should not live on a laptop.

| Field                                                  | Locally                                                                                | On AWS                                               |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Redirect URI                                           | `http://app.argos.localhost:4002/auth/github/callback`                                 | `https://app.argos.wakecap.com/auth/github/callback` |
| Expire user authorization tokens                       | **Off.** Argos keeps no refresh token, so an expired one breaks importing repositories | Off                                                  |
| Request user authorization (OAuth) during installation | **On.** Argos has no setup page; it expects to be sent back to the redirect URI        | On                                                   |
| Setup URL, Device Flow, Redirect on update             | Empty / off                                                                            | Empty / off                                          |
| Webhook URL                                            | A smee.io channel (below)                                                              | `https://api.argos.wakecap.com/github/event-handler` |
| Webhook secret                                         | `openssl rand -hex 32`, also set as `GITHUB_WEBHOOK_SECRET`                            | Same                                                 |
| Where can it be installed                              | Only on this account                                                                   | Only on this account                                 |

Permissions:

- Repository: Actions read, Commit statuses read and write, Contents read, Metadata read, Pull requests read and
  write.
- Organization: Members read. Only needed for GitHub SSO on teams.
- Account: Email addresses read. Sign-in fails without it.

Events: Pull request, Repository, Organization, Workflow run. GitHub sends the installation events without asking.

**Settings** (in `.env`):

| From the App's page                           | Setting                                                                                                |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| App ID                                        | `GITHUB_APP_ID`                                                                                        |
| Public link, `https://github.com/apps/<slug>` | `GITHUB_APP_URL`. Without it, Argos's install links point to upstream's App                            |
| Client ID                                     | `GITHUB_CLIENT_ID`                                                                                     |
| A generated client secret                     | `GITHUB_CLIENT_SECRET`                                                                                 |
| A generated private key (`.pem`)              | `GITHUB_APP_PRIVATE_KEY`, on one line with newlines written as `\n`: `awk 'BEGIN{ORS="\\n"}1' key.pem` |

**Webhooks locally.** GitHub can't reach your machine, so create a channel at <https://smee.io/new>, use it as the
App's webhook URL, put it in `SMEE_URL`, and start the relay with the rest of the stack:

```bash
docker compose --profile github up -d
```

Argos only learns that the App was installed, and on which repositories, from these webhooks. If one was missed,
importing a repository fails with "Installation not found": resend it from the App's settings, Advanced, Recent
deliveries.

**Install it from Argos,** not from GitHub: New project → Continue with GitHub → install, choose **Only select
repositories**, and pick the repositories. Argos then lists them for import. Prefer selected repositories to "All
repositories": Argos ignores the event for a newly created repository, so one created later may never show up.

## Next work

In rough order of need:

1. **Email.** Only Resend is supported, and the sender address is hard-coded to `contact@argos-ci.com`. Either set
   up Resend for a WakeCap domain, or add SMTP so we can use Amazon SES. Without email, nobody gets sign-in codes,
   so until then sign-in has to be GitHub.
2. **Hide what we don't use.** The sign-in page shows Google and GitLab buttons even when they are not set up.
   Pricing, "Hobby"/"Pro" badges, trials and links to argos-ci.com docs show throughout, including in the PR comment.
   Team settings offer upstream's "GitHub without content access" App.
3. **Wakecore.** Change `apps/storybook/scripts/vrt-capture.mjs` to write the screenshots to a folder and upload
   them with `@argos-ci/cli upload` instead of sending them to Visual Regression Tracker.
4. **Image size.** 3.6 GB. A slimmer final stage (only `dist`, production dependencies, and the frontend build) would
   cut it a lot.

Not needed and not set up: Deployments (Argos hosting Storybook builds; it needs DynamoDB and CloudFront), Slack,
Stripe, Sentry, Discord.

## AWS deployment (for DevOps)

Argos is built to run on AWS, so each local piece has a managed equivalent:

| Piece                                                            | Locally                           | On AWS                                                                                                                                       |
| ---------------------------------------------------------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Postgres **17 or newer** (`structure.sql` uses 17-only settings) | `postgres:18-alpine`              | RDS for PostgreSQL 17. SSL is switched on automatically for `*.amazonaws.com` hosts                                                          |
| Redis 6                                                          | `redis:6-alpine`                  | ElastiCache for Redis                                                                                                                        |
| RabbitMQ 4.2                                                     | `rabbitmq:4.2-alpine`             | Amazon MQ for RabbitMQ (`amqps://user:pass@host:5671`)                                                                                       |
| Screenshot storage                                               | MinIO                             | A private S3 bucket. Give the tasks an IAM role with read and write on it, and drop `S3_ENDPOINT`, `S3_FORCE_PATH_STYLE` and the access keys |
| Web (app and API)                                                | `web` service, port 4002          | ECS service behind an ALB that terminates TLS. Health check: `GET /health`                                                                   |
| Worker (diffs, notifications)                                    | `worker` service                  | ECS service, no port. It does the image diffing, so give it the most CPU                                                                     |
| Schema                                                           | Loaded by Postgres on first start | Once, by hand: `psql -f apps/backend/db/structure.sql`                                                                                       |
| Migrations                                                       | `migrate` service                 | A one-off ECS task before each deploy: `cd apps/backend && npx knex migrate:latest`                                                          |

**Image.** `docker build --target build -t argos .` from the repo root. The default target is an empty stage, so
`--target build` is required. Commands:

- web: `sh -c "cd apps/backend && exec ./bin/start.sh web"`
- worker: `sh -c "cd apps/backend && exec ./bin/start.sh worker"`

**Hostnames.** The app and the API are the same process, told apart by the first part of the hostname. Point both
names at the same target group, for example `app.argos.wakecap.com` and `api.argos.wakecap.com`.

**Who has to reach what:**

- People's browsers: the app host, and the S3 bucket (screenshots load from short-lived signed S3 links).
- CI (GitHub Actions): the API host, and the S3 bucket (uploads go straight to S3 through signed links).
- GitHub: the API host, for webhooks (`/github/event-handler`).

**S3 bucket CORS.** The review page fetches screenshots with JavaScript to diff them, so the bucket needs a CORS
rule allowing `GET` from `https://app.argos.wakecap.com` with the `Cache-Control` request header.

**Settings that differ from local** (the rest are in [.env.example](.env.example)):

```
SERVER_URL=https://app.argos.wakecap.com
API_BASE_URL=https://api.argos.wakecap.com
SERVER_SECURE=true
SERVER_HTTPS_REDIRECT=true        # the ALB must send X-Forwarded-Proto
SESSION_DOMAIN=argos.wakecap.com  # the parent of the app and api hosts: GitHub sign-in needs the cookie on both
WEBAUTHN_RP_ID=app.argos.wakecap.com
WEBAUTHN_ORIGINS=https://app.argos.wakecap.com
DATABASE_URL=postgres://<user>:<password>@<rds host>:5432/argos
REDIS_URL=rediss://<elasticache host>:6379
AMQP_URL=amqps://<user>:<password>@<amazon mq host>:5671
AWS_SCREENSHOTS_BUCKET=<bucket>
S3_REGION=<region>
S3_PUBLIC_IMAGE_BASE_URL=         # empty: signed S3 links, no image CDN
ENCRYPTION_KEY=<64 hex characters> # secret; never change it once projects exist, or their tokens stop working
SERVER_SESSION_SECRET=<random>     # secret
TRACK_NPM_PACKAGE_VERSIONS=false  # optional: stops it asking npm whether a newer Argos SDK exists
GITHUB_APP_ID=…                    # and the other GITHUB_* values from the production App (see GitHub App)
```

**Storage growth.** Expect tens of megabytes per full build (about 2,100 PNG screenshots per Wakecore build, which
measured 27 MB in Visual Regression Tracker). Plan an S3 lifecycle rule for old builds.
