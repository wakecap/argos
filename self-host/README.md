# Self-hosting Argos (WakeCap fork)

WakeCap runs this fork of [argos-ci/argos](https://github.com/argos-ci/argos) on its own infrastructure, with no
Argos subscription, as the visual review step for Wakecore's Storybook (the job Chromatic used to do).

Upstream does not support or document self-hosting. This folder is what it took to make it work, what still does
not, and how to run it on AWS.

Forked from upstream `0894b0c` (2026-10-07). Keep the changes small so the fork can be rebased onto upstream.

## Status

Tried locally on 2026-10-12 with 30 real Wakecore stories:

| Step                                                                            | Result                                                                    |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Sign up and sign in with an emailed code, no email service                      | Works: the code is read from Redis                                        |
| Create a project with no GitHub link                                            | Works                                                                     |
| Upload screenshots with the official CLI (`@argos-ci/cli upload`)               | Works, straight to our storage (MinIO locally, S3 on AWS)                 |
| Compare a branch with the `main` baseline                                       | Works: 3 changed, 1 added, 1 removed, 26 unchanged, as expected           |
| Review in the browser: side-by-side diff, approve or reject each change, submit | Works                                                                     |
| Create a team without Stripe, and upload to its project                         | Works after fix 6                                                         |
| Commit status and comment on the GitHub PR                                      | **Not tried yet.** Needs our own GitHub App (see [Next work](#next-work)) |

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

1. Open <http://app.localhost:4002/signup>, pick "personal projects" and sign up with any email.
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

## Next work

In rough order of need:

1. **GitHub integration.** Create a WakeCap GitHub App, set its `GITHUB_*` variables, and check that Argos posts the
   commit status that blocks a PR until someone approves, plus the PR comment. Webhooks arrive at
   `https://<api host>/github/event-handler`, so this needs the AWS deployment, or a tunnel.
2. **Email.** Only Resend is supported, and the sender address is hard-coded to `contact@argos-ci.com`. Either set
   up Resend for a WakeCap domain, or add SMTP so we can use Amazon SES. Without email, nobody gets sign-in codes,
   so until then sign-in has to be GitHub.
3. **Hide what we don't use.** The sign-in page shows Google, GitHub and GitLab buttons even when they are not set
   up. Pricing, "Hobby"/"Pro" badges, trials and links to argos-ci.com docs show throughout.
4. **Wakecore.** Change `apps/storybook/scripts/vrt-capture.mjs` to write the screenshots to a folder and upload
   them with `@argos-ci/cli upload` instead of sending them to Visual Regression Tracker.
5. **Image size.** 3.6 GB. A slimmer final stage (only `dist`, production dependencies, and the frontend build) would
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
- GitHub: the API host, for webhooks.

**S3 bucket CORS.** The review page fetches screenshots with JavaScript to diff them, so the bucket needs a CORS
rule allowing `GET` from `https://app.argos.wakecap.com` with the `Cache-Control` request header.

**Settings that differ from local** (the rest are in [.env.example](.env.example)):

```
SERVER_URL=https://app.argos.wakecap.com
API_BASE_URL=https://api.argos.wakecap.com
SERVER_SECURE=true
SERVER_HTTPS_REDIRECT=true        # the ALB must send X-Forwarded-Proto
SESSION_DOMAIN=                   # empty keeps the session cookie on the app host
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
GITHUB_APP_ID=…                    # and the other GITHUB_* values, once the GitHub App exists
```

**Storage growth.** Expect tens of megabytes per full build (about 2,100 PNG screenshots per Wakecore build, which
measured 27 MB in Visual Regression Tracker). Plan an S3 lifecycle rule for old builds.
