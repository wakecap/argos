# Self-hosting Argos (WakeCap fork)

WakeCap runs this fork of [argos-ci/argos](https://github.com/argos-ci/argos) on its own infrastructure, with no
Argos subscription, as the visual review step for Wakecore's Storybook (the job Chromatic used to do).

Upstream does not support or document self-hosting. This folder is what it took to make it work, what still does
not, and how to run it.

**Live** at <https://app.argos.wakecap.ai> (API: `https://api.argos.wakecap.ai`) since 2026-10-13, on WakeCap's AWS.
To send a repository's screenshots to it, see [Connect a repository](#connect-a-repository).

Forked from upstream `0894b0c` (2026-10-07). Keep the changes small so the fork can be rebased onto upstream.

## Status

**Production** (2026-10-13): running on WakeCap's EKS in us-east-2, deployed by DevOps through the house deploy lane
(see [Deploying](#deploying)). Tested end to end there: an upload, S3 storage, a diff (1 changed, 1 unchanged), and
signing in with GitHub and with Google. Screenshots are kept with no expiry, because a baseline stays in use for
months.

**Local trial** (2026-10-12), with 30 real Wakecore stories and a GitHub App installed on a sandbox repository
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

| #   | Problem                                                                                                                                                                                                                                      | Fix                                                                                                                                                                                                                                                                                                                                                                                       |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Screenshots could only be stored on AWS S3                                                                                                                                                                                                   | `S3_ENDPOINT` and `S3_FORCE_PATH_STYLE` point it at any S3-compatible store (`storage/s3.ts`, `config/index.ts`)                                                                                                                                                                                                                                                                          |
| 2   | The Docker build fails outside Argos's CI: `@graphql-codegen/add` is installed but hidden from the root (their CI probably never runs that step, as it restores it from a build cache)                                                       | Declared it as a root dev dependency                                                                                                                                                                                                                                                                                                                                                      |
| 3   | `NODE_ENV=production` forces https, with no switch to turn it off                                                                                                                                                                            | `SERVER_SECURE` and `SERVER_HTTPS_REDIRECT`                                                                                                                                                                                                                                                                                                                                               |
| 4   | Production mode crashes on boot without a Resend (email service) key                                                                                                                                                                         | Email is optional: without a key, sending is skipped and logged (`email/send.ts`)                                                                                                                                                                                                                                                                                                         |
| 5   | The browser blocked screenshots from non-AWS storage, and upgraded every http request to https                                                                                                                                               | The Content-Security-Policy allows the `S3_ENDPOINT` origin, and only upgrades to https when `SERVER_SECURE` is on (`web/security-headers.ts`)                                                                                                                                                                                                                                            |
| 6   | Creating a team sends you to a Stripe checkout                                                                                                                                                                                               | Without Stripe, a new team gets an unlimited `self-hosted` plan instead (`database/services/self-hosted-plan.ts`, `graphql/definitions/Team.ts`)                                                                                                                                                                                                                                          |
| 7   | Upstream's SaaS parts showed everywhere: plan badges, billing, trials, upsells, Discord and status links, and sign-in buttons for services we don't run. The project badge and the "getting started" upload commands pointed at argos-ci.com | `SELF_HOSTED=true` hides billing, plans, trials, upsells, Argos's community links and the Deployments feature, and offers only the sign-in options and integrations that are configured. The badge, the upload commands and the CLI's "project not found" error use our own addresses. Upstream's behaviour is unchanged while the setting is off (`util/self-hosted.ts` in the frontend) |

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
letters. `localtest.me` is a public name that points back to your machine. A real domain (`api.argos.wakecap.ai`)
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
environment: the URLs differ, and production keys should not live on a laptop. Production's is `wakecap-argos`.

| Field                                                  | Locally                                                                                | On AWS                                              |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Redirect URI                                           | `http://app.argos.localhost:4002/auth/github/callback`                                 | `https://app.argos.wakecap.ai/auth/github/callback` |
| Expire user authorization tokens                       | **Off.** Argos keeps no refresh token, so an expired one breaks importing repositories | Off                                                 |
| Request user authorization (OAuth) during installation | **On.** Argos has no setup page; it expects to be sent back to the redirect URI        | On                                                  |
| Setup URL, Device Flow, Redirect on update             | Empty / off                                                                            | Empty / off                                         |
| Webhook URL                                            | A smee.io channel (below)                                                              | `https://api.argos.wakecap.ai/github/event-handler` |
| Webhook secret                                         | `openssl rand -hex 32`, also set as `GITHUB_WEBHOOK_SECRET`                            | Same                                                |
| Where can it be installed                              | Only on this account                                                                   | Only on this account                                |

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

## Connect a repository

On production, for a repository whose CI should send screenshots:

1. Sign in at <https://app.argos.wakecap.ai> with GitHub or Google (allowed addresses only).
2. **New Project → Continue with GitHub**, and pick the repository. That installs the `wakecap-argos` GitHub App on
   it, which posts the `argos` check and a comment on each PR. A project created without GitHub can't post them.
3. Copy the project's token into the repository's CI secrets as `ARGOS_TOKEN`.
4. In CI, also set `ARGOS_API_BASE_URL=https://api.argos.wakecap.ai/v2/`. Without it the Argos SDKs and CLI upload to
   argos-ci.com instead of ours.
5. Make the branch that PRs target the project's default branch: its builds are the baseline the others are compared
   with.

### How Wakecore uses it

[wakecap/Wakecore#443](https://github.com/wakecap/Wakecore/pull/443) replaced Visual Regression Tracker with this
Argos. There's no separate workflow: `@argos-ci/storybook`'s Vitest plugin screenshots each story after its test, in
the Story tests jobs that already run every story, and both test shards upload one build. Wakecore's own wrapper
(`apps/storybook/.storybook/argos.ts`) skips stories tagged `no-visual`, shoots each story left to right and right to
left (Argos modes on the `direction` global), and shoots the whole page at 1280×720. Argos's default crop to the
story's content misses portalled dialogs and popovers. The project's default (baseline) branch is `develop`.

## Next work

In rough order of need:

1. **Email.** Only Resend is supported, and the sender address is hard-coded to `contact@argos-ci.com`. Either set
   up Resend for a WakeCap domain, or add SMTP so we can use Amazon SES. Without email, nobody gets sign-in codes or
   notifications; sign-in is GitHub or Google until then.
2. **Upstream leftovers.** `SELF_HOSTED` hides most of them. Still showing: the "How did you hear about us?" question
   after signing up, Argos's footer, terms and sender address in emails (fix with email), and links to argos-ci.com's
   documentation, which stay because the docs are accurate for us too. Set `CONTACT_EMAIL` so "contact us" links
   reach your own admins.
3. **Image size.** 3.6 GB. A slimmer final stage (only `dist`, production dependencies, and the frontend build) would
   cut it a lot.

Not needed and not set up: Deployments (Argos hosting Storybook builds; it needs DynamoDB and CloudFront), Slack,
Stripe, Sentry, Discord.

## Deploying

A merge to `main` deploys itself, through WakeCap's house deploy lane
([`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml)): it builds the image, pushes it to ECR, and
dispatches to `wakecap/infrastructure`, where a bot PR bumps the image in
`terraform/aws/wakecap-main/us-east-2/prod/argos/`, is checked, merged and applied (the migrate Job first, then web and
worker roll). The cluster's settings, secrets and sizing live in that Terraform layer, not in this repository. The
repository variable `DEPLOY_ENABLED` switches the deploy on and off.

[aws-deployment.md](aws-deployment.md) is the first plan, written for ECS before the EKS lane existed. Its reasoning
still holds — the resources, who has to reach what, the first-time database setup — but not its ECS pipeline, and
`aws/production.env` and `aws/render-task-definition.sh` belong to that plan, not to the running deployment.
