# Argos on AWS: what DevOps needs to set up

> **Superseded (2026-10-13).** Argos went live on WakeCap's EKS in us-east-2, through the house deploy lane, not on
> the ECS setup this document proposes: see [Deploying](README.md#deploying) and
> [`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml). Its settings, secrets and sizing live in
> `terraform/aws/wakecap-main/us-east-2/prod/argos/` in `wakecap/infrastructure`. The addresses are
> `app.argos.wakecap.ai` and `api.argos.wakecap.ai`, not the `.com` names below. Kept for its reasoning: the
> resources, who has to reach what, and the first-time setup.

**For:** Ruslan (DevOps). **From:** Hamed (frontend). **Status:** works end to end locally, see [README.md](README.md).

Argos replaces Chromatic as the visual review for Wakecore's Storybook. CI uploads screenshots of every story; Argos
compares them with the approved ones; a person approves or rejects each change in Argos; and a GitHub commit status
keeps the PR blocked until they do. This fork (`wakecap/argos`) runs it ourselves, with no subscription.

This document asks for two things:

1. **The AWS setup** to run it (sections 1 to 5).
2. **A GitHub Actions pipeline** that deploys every merge to `main` on its own, so a fix or an enhancement reaches
   production without coming back to you each time (section 6). You set up the AWS side once; we maintain the
   workflow.

## Checklist

- [ ] AWS resources from [section 2](#2-aws-resources)
- [ ] DNS names and a certificate ([section 2](#2-aws-resources))
- [ ] Secrets in SSM Parameter Store ([section 4](#4-configuration))
- [ ] Database schema loaded once ([section 5](#5-first-time-setup))
- [ ] GitHub deploy role, and the values in the repository's `production` environment ([section 6](#6-cicd-deploy-every-merge-without-devops))
- [ ] Answers to the [open questions](#8-open-questions)

## 1. How it runs

One Docker image, run three ways:

| Process     | What it does                                                                  | How it runs                         |
| ----------- | ----------------------------------------------------------------------------- | ----------------------------------- |
| **web**     | The web app and the API, in one process, told apart by `app.` and `api.`      | ECS service behind a load balancer  |
| **worker**  | Compares screenshots, posts GitHub statuses and comments, sends notifications | ECS service, no port                |
| **migrate** | Applies database migrations                                                   | One-off ECS task before each deploy |

```
 People's browsers ──► ALB ──► web ──┐
 Wakecore CI ───────► ALB ──► web    ├──► RDS Postgres, ElastiCache Redis, Amazon MQ, S3
 GitHub webhooks ───► ALB ──► web    │
                                      └── worker ──► same, plus the GitHub API
 Wakecore CI ──── uploads ────► S3 (signed links)
 People's browsers ─ images ──► S3 (signed links)
```

This mirrors how Argos runs its own production: ECS Fargate, RDS, Amazon MQ, Redis and S3. Their ECS task templates
are in [`aws/tasks/`](../aws/tasks) and their deploy pipeline in
[`.github/workflows/release.yml`](../.github/workflows/release.yml); ours will be based on both.

## 2. AWS resources

| Resource                         | Spec and notes                                                                                                                                                                                                                                                                                                                                      |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **ECR repository**               | For example `argos`. Images are about 3.6 GB today (we plan to slim them). A lifecycle rule keeping the last 20 images is plenty.                                                                                                                                                                                                                   |
| **ECS cluster (Fargate)**        | `X86_64`, as upstream runs.                                                                                                                                                                                                                                                                                                                         |
| ECS service **web**              | 1 vCPU, 3 GB (upstream's size), 2 tasks. Container port `4002` (set by `PORT`). Health check `GET /health` returns 200. Deployment circuit breaker with rollback on.                                                                                                                                                                                |
| ECS service **worker**           | 1 vCPU, 3 GB, 1 task to start. It does the image diffing, so it is the one to scale if reviews queue up.                                                                                                                                                                                                                                            |
| ECS task definition **migrate**  | 0.5 vCPU, 1 GB. Run by the pipeline, never as a service.                                                                                                                                                                                                                                                                                            |
| **ALB**, internet-facing         | HTTPS on 443 with an ACM certificate for both hostnames; HTTP redirects to HTTPS. Both hostnames go to the same web target group. It must pass `X-Forwarded-Proto` (ALBs do by default). The app keeps a WebSocket open for live updates on the same port.                                                                                          |
| **DNS**                          | Two names on the ALB. Proposal: `app.argos.wakecap.com` (people) and `api.argos.wakecap.com` (CI and GitHub).                                                                                                                                                                                                                                       |
| **RDS for PostgreSQL 17**        | Not 16: the schema uses a 17-only setting. Master username **`postgres`**: the schema file assigns 151 objects to that role. Database `argos`. `db.t4g.medium` to start, automated backups on. Connect with the RDS endpoint name, not a custom CNAME: Argos turns SSL on only for `*.amazonaws.com` hosts.                                         |
| **ElastiCache for Redis**        | Redis OSS 6 or newer (tested on 6; upstream runs 6.2). A small node. With in-transit encryption, the URL starts `rediss://`.                                                                                                                                                                                                                        |
| **Amazon MQ for RabbitMQ 4.2**   | What upstream runs in production. A single-instance broker is enough to start. URL `amqps://<user>:<password>@<host>:5671`.                                                                                                                                                                                                                         |
| **S3 bucket** for screenshots    | Private, encrypted, **no dots in the name** (they break the HTTPS address browsers use). Needs a CORS rule ([section 5](#5-first-time-setup)). **No expiry rule for now:** a baseline can stay in use for months, and expiring its files would break comparisons. Files are stored by content hash, so an unchanged screenshot is stored only once. |
| **SSM Parameter Store**          | The secrets, as SecureStrings under one prefix, for example `/argos/production/` ([section 4](#4-configuration)).                                                                                                                                                                                                                                   |
| **CloudWatch log groups**        | `/ecs/argos-web`, `/ecs/argos-worker`, `/ecs/argos-migrate`; 30 days is fine.                                                                                                                                                                                                                                                                       |
| **IAM: task execution role**     | Pull from ECR, write logs, `ssm:GetParameters` on the prefix, and `kms:Decrypt` for its key.                                                                                                                                                                                                                                                        |
| **IAM: task role** (web, worker) | `s3:GetObject`, `s3:PutObject`, `s3:DeleteObject` on `arn:aws:s3:::<bucket>/*` and `s3:ListBucket` on the bucket. No access keys: the AWS SDK picks up the role. (Upstream uses keys; we don't need to.)                                                                                                                                            |
| **IAM: GitHub deploy role**      | See [section 6](#6-cicd-deploy-every-merge-without-devops).                                                                                                                                                                                                                                                                                         |

**Not needed:** DynamoDB, CloudFront, Lambda, a deployments bucket, Stripe, Sentry. Those serve upstream features we
turned off.

## 3. Who has to reach what

| From                                | To                                   | Why                                                     |
| ----------------------------------- | ------------------------------------ | ------------------------------------------------------- |
| People's browsers                   | `app.` host                          | The review UI                                           |
| People's browsers                   | The S3 bucket's HTTPS address        | Screenshots load from short-lived signed links          |
| Wakecore CI (GitHub-hosted runners) | `api.` host                          | Creates builds                                          |
| Wakecore CI                         | The S3 bucket's HTTPS address        | Uploads screenshots straight to S3 through signed links |
| GitHub                              | `api.` host, `/github/event-handler` | Webhooks: App installs, pull requests                   |
| web and worker tasks                | RDS, Redis, Amazon MQ, S3            |                                                         |
| web and worker tasks                | `api.github.com` (outbound, via NAT) | Commit statuses, PR comments, sign-in with GitHub       |

GitHub-hosted runners and GitHub's webhooks come from changing IP addresses, so the ALB and the bucket must be
reachable from the internet. The app requires signing in, and the API requires a project token. Keeping it private
instead would mean self-hosted runners inside the VPC, plus VPN for people: a bigger change, see the
[open questions](#8-open-questions).

## 4. Configuration

**Plain settings** go in the deploy workflow, in this public repository, so nothing secret belongs here:

```
NODE_ENV=production
SELF_HOSTED=true
LOG_LEVEL=info
PORT=4002
SERVER_URL=https://app.argos.wakecap.com      # must be exactly the address people open
API_BASE_URL=https://api.argos.wakecap.com
MCP_BASE_URL=https://mcp.argos.wakecap.com      # endpoint for AI agents; only reachable if you add that DNS name
SERVER_SECURE=true
SERVER_HTTPS_REDIRECT=true
SESSION_DOMAIN=argos.wakecap.com              # the parent of app. and api.: GitHub sign-in needs the cookie on both
WEBAUTHN_RP_ID=app.argos.wakecap.com
WEBAUTHN_ORIGINS=https://app.argos.wakecap.com
AWS_SCREENSHOTS_BUCKET=<bucket>
S3_REGION=<region>
S3_PUBLIC_IMAGE_BASE_URL=                     # empty: signed S3 links, no image CDN
ASSETS_BASE_URL=                              # empty: the app serves its own frontend files
TRACK_NPM_PACKAGE_VERSIONS=false
GITHUB_APP_URL=https://github.com/apps/<production app slug>
CONTACT_EMAIL=<who people should contact about Argos>
```

**Secrets** go in SSM Parameter Store as SecureStrings. Suggested names:

| Parameter                                  | Value                                                                                                       |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `/argos/production/database_url`           | `postgres://postgres:<password>@<rds endpoint>:5432/argos`                                                  |
| `/argos/production/redis_url`              | `rediss://<host>:6379`, with the auth token if you enable one                                               |
| `/argos/production/amqp_url`               | `amqps://<user>:<password>@<broker>:5671`                                                                   |
| `/argos/production/encryption_key`         | `openssl rand -hex 32`. **Never change it once projects exist:** their upload tokens are looked up with it. |
| `/argos/production/server_session_secret`  | `openssl rand -hex 32`                                                                                      |
| `/argos/production/github_app_id`          | From the production GitHub App                                                                              |
| `/argos/production/github_client_id`       | From the production GitHub App                                                                              |
| `/argos/production/github_client_secret`   | From the production GitHub App                                                                              |
| `/argos/production/github_app_private_key` | The App's PEM key. Real newlines, or one line with `\n`; both work.                                         |
| `/argos/production/github_webhook_secret`  | `openssl rand -hex 32`, also entered on the GitHub App                                                      |

**Leave unset:** `S3_ENDPOINT`, `S3_FORCE_PATH_STYLE` and `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` (those are for
local MinIO), and every `STRIPE_*`, `GOOGLE_*`, `GITLAB_*`, `SLACK_*`, `GITHUB_LIGHT_*`, `GITHUB_PROXY_*`,
`DYNAMODB_ENDPOINT` and `RESEND_API_KEY`. Email comes later, probably through SES.

`SELF_HOSTED` arrives with [wakecap/argos#3](https://github.com/wakecap/argos/pull/3).

## 5. First-time setup

1. **Create the resources** in section 2 and the parameters in section 4.
2. **Load the database schema, once.** From any machine inside the VPC, with this repository checked out. It needs a
   PostgreSQL 18 client, because the file uses a command older clients don't know; the official image has one:

   ```bash
   docker run --rm -v "$PWD/apps/backend/db:/db" postgres:18-alpine \
     psql "<database url>" -v ON_ERROR_STOP=1 -f /db/structure.sql
   ```

   The schema already records every migration as applied, so later deploys only run newer ones.

3. **Add the S3 CORS rule.** The review page downloads screenshots with JavaScript to compare them:

   ```json
   [
     {
       "AllowedOrigins": ["https://app.argos.wakecap.com"],
       "AllowedMethods": ["GET", "HEAD"],
       "AllowedHeaders": ["*"],
       "MaxAgeSeconds": 3600
     }
   ]
   ```

4. **Production GitHub App.** Hamed creates it in the `wakecap` organisation, with the settings in the README's
   [GitHub App](README.md#github-app) section, "On AWS" column:
   - Redirect URI `https://app.argos.wakecap.com/auth/github/callback`
   - Webhook URL `https://api.argos.wakecap.com/github/event-handler`

   Its keys go into SSM straight from GitHub, through a password manager or by whoever has SSM access. They don't go
   through chat or email.

5. **First deploy** through the pipeline (section 6).
6. **Smoke test:** open the app, sign in with GitHub, install the App on a repository, upload a test build.

## 6. CI/CD: deploy every merge, without DevOps

**The goal:** a merge to `main` in `wakecap/argos` reaches production by itself. You are involved only in
infrastructure changes: a new secret, a new resource, sizing.

**The pipeline** is [`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml), based on upstream's
`release.yml`:

1. **Build** the image (`docker build --target build`) and push it to ECR, tagged with the commit SHA. An image that
   is already there is not rebuilt.
2. **Migrate:** run the migrate task in the web service's network and wait for it. If it fails, nothing is deployed.
3. **Deploy:** register new task definition revisions for web and worker with the new image, update both services and
   wait until they are stable.
4. **Rollback:** run the workflow by hand (Actions → Deploy → Run workflow) with an older commit. Its image is reused
   and the migrations are skipped: the database stays as it is. Undoing a migration is a manual step.

**What lives where:**

| What                                   | Where                                                              | Who changes it |
| -------------------------------------- | ------------------------------------------------------------------ | -------------- |
| Task definitions (size, command, port) | [`aws/tasks/*.json`](aws/tasks) in this folder                     | Us, by PR      |
| Plain settings                         | [`aws/production.env`](aws/production.env). Public: never a secret | Us, by PR      |
| Which secrets a task reads             | [`aws/production.secrets`](aws/production.secrets), names only     | Us, by PR      |
| Secret values                          | SSM Parameter Store, `<SSM_PREFIX><name in lower case>`            | You            |
| AWS identifiers the workflow needs     | GitHub, the repository's `production` environment                  | You, once      |

So adding a plain setting is a PR, and adding a secret is you creating the parameter plus a PR naming it. The deploy
stops while `production.env` still holds a `<placeholder>` (the bucket, region, App slug and contact address today).
If you'd rather own the task definitions in your infrastructure code, the workflow can be changed to swap only the
image. See the [open questions](#8-open-questions).

**What we need from you:**

1. **GitHub's OIDC provider** in the AWS account (`token.actions.githubusercontent.com`), if it isn't there already.
   No long-lived AWS keys in GitHub.
2. **A deploy role**, for example `argos-github-deploy`, that only this repository's `production` environment can
   assume. The environment will be limited to the `main` branch, so pull requests, including ones from forks, can
   never get it:

   ```json
   {
     "Effect": "Allow",
     "Principal": {
       "Federated": "arn:aws:iam::<account>:oidc-provider/token.actions.githubusercontent.com"
     },
     "Action": "sts:AssumeRoleWithWebIdentity",
     "Condition": {
       "StringEquals": {
         "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
         "token.actions.githubusercontent.com:sub": "repo:wakecap/argos:environment:production"
       }
     }
   }
   ```

3. **Its permissions,** nothing more:
   - ECR, on the `argos` repository: `ecr:BatchCheckLayerAvailability`, `ecr:InitiateLayerUpload`,
     `ecr:UploadLayerPart`, `ecr:CompleteLayerUpload`, `ecr:PutImage`, `ecr:BatchGetImage`,
     `ecr:GetDownloadUrlForLayer` and `ecr:DescribeImages`; plus `ecr:GetAuthorizationToken`, which takes no resource
   - ECS: `ecs:RegisterTaskDefinition`, `ecs:DescribeTaskDefinition`, `ecs:RunTask`, `ecs:DescribeTasks`,
     `ecs:UpdateService` and `ecs:DescribeServices` on our cluster and services
   - `iam:PassRole` on the task role and the task execution role
4. **These values,** in the repository's `production` environment (Settings → Environments):

   | Name                          | Kind     | Example                                           |
   | ----------------------------- | -------- | ------------------------------------------------- |
   | `AWS_DEPLOY_ROLE_ARN`         | Secret   | `arn:aws:iam::<account>:role/argos-github-deploy` |
   | `AWS_REGION`                  | Variable | `eu-west-1`                                       |
   | `ECR_REPOSITORY`              | Variable | `argos`                                           |
   | `ECS_CLUSTER`                 | Variable | `argos`                                           |
   | `ECS_WEB_SERVICE`             | Variable | `argos-web`                                       |
   | `ECS_WORKER_SERVICE`          | Variable | `argos-worker`                                    |
   | `ECS_TASK_ROLE_ARN`           | Variable | The task role (web, worker)                       |
   | `ECS_TASK_EXECUTION_ROLE_ARN` | Variable | The task execution role                           |
   | `SSM_PREFIX`                  | Variable | `/argos/production/`, with the trailing slash     |

   The migrate task's subnets and security groups are read from the web service.

**On our side:**

- **Done:** GitHub Actions is on for the fork, and upstream's `CI`, `Release` and `Infra` workflows are disabled in
  the Actions tab. `release.yml` deploys to Argos's own AWS account, `infra.yml` their CDK stacks, and `ci.yml` needs
  their S3 bucket and an argos-ci.com project. Disabling them in GitHub rather than deleting them keeps upstream's
  files untouched, so merging upstream updates stays easy. Our own [`checks.yml`](../.github/workflows/checks.yml)
  runs the same tests, with MinIO and DynamoDB Local in place of their AWS account.
- **Before the first deploy:**
  - **Limit the `production` environment to the `main` branch** (Settings → Environments → production → Deployment
    branches).
  - **Fill in the placeholders** in `aws/production.env` once you've answered the open questions.
  - **Switch deploys on:** set the repository variable `DEPLOY_ENABLED` to `true` (Settings → Secrets and variables
    → Actions → Variables). Until then, a merge to `main` skips the deploy instead of failing it. It is a repository
    variable, not a `production` one, because the workflow reads it before choosing the environment.
  - Then run the first deploy together (Actions → Deploy → Run workflow).

## 7. Running it

- **Logs:** the CloudWatch groups above. **Health:** `GET /health` on the web service.
- **Backups:** RDS automated backups. S3 versioning is optional.
- **Scaling:** the worker does the heavy work (image diffing). Add worker tasks first if reviews start to wait.
- **Known limit, rolling deploys:** each task serves the frontend files baked into its own image. While a deploy rolls,
  or in a tab opened before it, a page can fail to load part of the app until it is reloaded. Upstream fixed this by
  serving those files from an S3 bucket behind CloudFront that keeps every recent build (`ASSETS_BASE_URL`; their CDK
  stack is in [`infra/`](../infra/README.md)). With a few internal users we can live with a reload for now and add
  this later if it bothers people.
- **Upstream updates:** we merge upstream into our `main` through a PR, and the pipeline deploys it.

## 8. Open questions

1. **Names:** are `app.argos.wakecap.com` and `api.argos.wakecap.com` fine? Which AWS account and region?
2. **Runtime:** this assumes ECS Fargate, like upstream. Do you run something else, such as EKS?
3. **RabbitMQ:** Amazon MQ, or a RabbitMQ container on ECS?
4. **Exposure:** is an internet-facing ALB acceptable (needed for GitHub-hosted runners and webhooks), or should it be
   private, with self-hosted runners and VPN?
5. **Task definitions:** in this repository (like upstream, our proposal) or in your infrastructure code?
6. **Existing setup:** is GitHub OIDC already configured in the account? Any naming or tagging conventions to follow?
7. **Email, later:** can we send from a WakeCap domain through SES?
