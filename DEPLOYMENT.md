# Deploying Applicient to a VPS

Step-by-step for taking this repo from `docker compose up` on a laptop to a
real, TLS-terminated production deployment on a VPS with your own domain.

Written for: `applicient.my.id`, VPS on Tencent Cloud directly
(Lighthouse), any Ubuntu/Debian box. Swap in your own domain/registrar
where it appears — nothing here depends on the registrar beyond "wherever
you manage DNS for the domain" (Domainesia or Sumopod, whichever you're
actually using for that).

## 0. What you end up with

```
Internet ──443/80──▶ caddy (TLS, auto-renewing) ──▶ web:3000   (applicient.my.id)
                                                 └─▶ api:8000   (api.applicient.my.id)
```

`postgres`, `redis`, `minio`, and `browser-worker` stay unreachable from the
internet — only reachable from other containers over the Compose network,
and from the VPS itself via `127.0.0.1` for debugging. `caddy` is the only
thing with a public port.

Everything about the deploy is driven from GitHub: **GitHub Actions**
builds the images and pushes them to Docker Hub, SSHes into the VPS,
writes `.env` there from GitHub Secrets/Variables, pulls the images, and
restarts the containers (step 7) — the VPS never builds anything, never
clones this repo, and nobody hand-edits a config file on it. The VPS's
only jobs are: exist, run Docker, and have `docker-compose.yml`/
`Caddyfile` sitting in `/opt/applicient` for Actions to talk to.

## 1. VPS sizing

Sized here for roughly **2 vCPU / 4GB RAM** — on Tencent Cloud Lighthouse
directly, that's the "2C4G" tier, around $8.5/month (check the exact SSD/
bandwidth quota shown at checkout; Lighthouse bundles it in, no separate
disk purchase). Workable for a soft launch / low concurrency, but tighter
than a bigger box — worth understanding where the RAM actually goes:

- Postgres + Redis + MinIO + api + web + caddy, all idle: roughly
  800MB–1.2GB combined. None of `api`/`agents` pulls in local ML weights
  (no torch/transformers/faiss — LLM calls go out to hosted providers via
  `langchain-openai`), so this stays light regardless of traffic.
- `browser-worker` is the one real cost — each open agent session is a
  full headless Chromium process. Its default cap (`sessions.py`) is 20
  concurrent sessions, which assumes a much bigger box than this one. On
  4GB, leave real headroom:

  ```
  BROWSER_WORKER_MAX_SESSIONS=2
  ```

  as a GitHub Actions variable (step 7) to start. Two people running the
  browser agent at the same time is fine; more than that will queue or
  fail with a clear "too many sessions" error (`sessions.py`'s
  `SessionLimitError`) rather than OOM the box.
- Add a swap file (step 4 does this) — cheap insurance on a 4GB box, so a
  transient spike degrades instead of getting a container OOM-killed.

Watch `docker stats` under real usage before deciding whether to raise
`BROWSER_WORKER_MAX_SESSIONS` or resize the VPS — both are independent of
the domain/DNS/TLS setup below, so growing later doesn't touch any of it.

## 2. Create the VPS on Tencent Cloud (Lighthouse)

Going directly to Tencent Cloud instead of reselling through Sumopod
avoids the prepaid-credits wallet model — Lighthouse instances are bought
as a bundle (e.g. one month) charged straight to a card at purchase time,
no balance to keep topped up. The trade-off: with auto-renewal off, the
instance simply stops when that period runs out — there's no wallet to
silently draw down from, but also nothing renews itself, so you'll need
to come back and manually pay for the next period yourself before it
expires.

1. Sign up at `https://intl.cloud.tencent.com` (this is the international
   entity — separate from the mainland-China `cloud.tencent.com`, and the
   one that accepts a Visa/Mastercard debit or credit card directly).
   Email + phone verification to create the account.
2. Identity verification is optional on Tencent Cloud International —
   you likely won't be blocked from buying Lighthouse without it, but if
   the console prompts for it at checkout, a passport or national ID
   satisfies it (turnaround is a couple of business days).
3. **Billing → Payment Methods**: add your debit/credit card. This is the
   only payment setup needed — there's no separate wallet/credit
   top-up step the way Sumopod requires.
4. Open the **Lighthouse** product page in the console and click
   **Create Instance** (or **Buy Now**).
5. **Region**: Singapore or Jakarta — Jakarta is the lower-latency choice
   for an Indonesian user base, if it's listed for your account.
6. **Image**: pick **Ubuntu Server 24.04 LTS 64-bit** explicitly from the
   OS list. Do **not** pick a Windows image — it adds licensing cost and
   RAM overhead you don't have room for on this box, and everything in
   this repo (Docker, the Dockerfiles) is Linux-native.
7. **Bundle**: the 2 vCPU / 4GB RAM tier (Tencent calls tiers things like
   "2C4G" or a named tier such as "Razor Speed" depending on region/promo
   — match on the vCPU/RAM numbers, not the marketing name). Check the
   SSD and monthly-transfer quota shown before confirming — this guide
   assumes at least ~60GB SSD; if the bundle you're shown is smaller,
   size up rather than run tight on disk.
8. **Billing cycle**: 1 month. Leave **auto-renewal off**.
9. Set login — upload an SSH public key (preferred over password auth;
   see "generating a keypair" below if you don't have one yet).
10. Confirm the order and pay with the card from step 3. Provisioning
    typically finishes in under a couple of minutes.
11. From the instance's detail page in the console, note down the
    **public IPv4 address** — you'll point DNS at this next.
12. Confirm you can actually log in before moving on. Ubuntu images on
    Tencent Lighthouse log you in as **`ubuntu`**, not `root` — this
    account has full `sudo` access, which every root-requiring command
    below uses instead of a real root login:
    ```bash
    ssh ubuntu@<public-ip>
    ```

**Generating a keypair**, if you don't already have one (macOS/Linux):

```bash
ssh-keygen -t ed25519 -C "applicient-deploy" -f ~/.ssh/applicient_deploy
```

Set a passphrase when prompted — a stolen laptop shouldn't mean a stolen
server. Upload the **public** half (`cat ~/.ssh/applicient_deploy.pub` —
never the private file) to Tencent's key field. Then, so macOS doesn't
ask for the passphrase on every connection:

```bash
ssh-add --apple-use-keychain ~/.ssh/applicient_deploy
```

(This is based on Tencent Cloud International's current Lighthouse
purchase flow as of this writing — exact tier names and screen layout can
shift; the landmarks to look for are the same: a payment-method step with
no separate wallet, a region/image/bundle picker, and a final page with
public IP + credentials. Put a calendar reminder near the end of each
paid period so the instance doesn't get reclaimed on you.)

## 3. Point DNS at the VPS

In your domain's DNS panel for `applicient.my.id` (Domainesia or
Sumopod, whichever you're actually using), add A records (replace
`YOUR_VPS_IP` with the public IPv4 from step 2):

| Type | Host | Value |
|---|---|---|
| A | `@` | `YOUR_VPS_IP` |
| A | `www` | `YOUR_VPS_IP` |
| A | `api` | `YOUR_VPS_IP` |

DNS propagation can take anywhere from a few minutes to a few hours.
Confirm before moving on:

```bash
dig +short applicient.my.id
dig +short api.applicient.my.id
```

Both should print the VPS's IP. Caddy (step 6) needs this to already be
correct — it requests a Let's Encrypt certificate on first boot and that
fails if the domain doesn't resolve to this server yet.

## 4. Prep the VPS

SSH in as `ubuntu` (`ssh ubuntu@<public-ip>`, or `ssh applicient-vps` if
you set up the `~/.ssh/config` shortcut), then switch to a root shell for
this whole setup block — simpler than prefixing every command with
`sudo`:

```bash
sudo -i
```

Set up the swap file from step 1 first (do this before anything else — a
Docker image pull + startup is exactly the kind of transient spike it's
there for):

```bash
fallocate -l 2G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

Then:

```bash
# Docker Engine + Compose plugin
curl -fsSL https://get.docker.com | sh

# Firewall — only SSH, HTTP, HTTPS from the outside.
# (Note: this is defense in depth, not the only thing protecting
# postgres/redis/minio/browser-worker — those are bound to 127.0.0.1
# in docker-compose.yml itself, since Docker's own iptables rules
# bypass ufw for a plain published port on 0.0.0.0.)
apt-get update && apt-get install -y ufw
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw enable

# Let `ubuntu` run docker without sudo — the install script above
# doesn't do this for you.
usermod -aG docker ubuntu
exit
```

Log out and back in (`exit`, then reconnect) so `ubuntu` picks up the
`docker` group membership from the last command above.

## 5. Get the compose files onto the server

The VPS runs entirely from pre-built Docker Hub images — it never needs
the application source code, and never needs to talk to GitHub at all.
The only two files it needs that aren't already baked into an image are
`docker-compose.yml` and `Caddyfile`, so just copy those over directly.
No git, no deploy key, nothing else to set up here.

```bash
# one-time: create the directory with the right ownership
ssh ubuntu@<public-ip> 'sudo mkdir -p /opt/applicient && sudo chown ubuntu:ubuntu /opt/applicient'

# from your own machine, in the repo root:
scp docker-compose.yml Caddyfile ubuntu@<public-ip>:/opt/applicient/
```

This is the only manual copy you'll ever do — step 7 wires up GitHub
Actions so every push after this scp's these same two files over
automatically (they rarely change, but the pipeline keeps them in sync
regardless).

## 6. Bring up Caddy (TLS)

Caddy only needs DNS + `Caddyfile` + ports 80/443 to obtain a TLS
certificate — it doesn't need `web`/`api` to be running yet, so this can
go live before the app itself is deployed at all:

```bash
ssh ubuntu@<public-ip>
cd /opt/applicient
docker compose --profile prod up -d caddy
docker compose logs -f caddy
```

Watch the logs for `certificate obtained successfully` for each of
`applicient.my.id`, `www.applicient.my.id`, and `api.applicient.my.id`.
This only works if DNS (step 3) is already correct and ports 80/443 are
reachable from the internet (step 4's `ufw`).

Then from your own machine:

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://applicient.my.id/
```

**A `502 Bad Gateway` here is expected and correct** — it means TLS is
genuinely live, Caddy just has nothing to proxy to yet, since `web`/`api`
don't exist until step 7's first deploy. If you get a certificate error
or connection failure instead of a clean 502, that's a real problem —
check the DNS/`ufw` items above.

## 7. Set up GitHub Actions — this is the actual deploy

`.github/workflows/deploy.yml` does the whole thing on every push to
`main`: build the three images → push to Docker Hub → write `.env` on the
VPS from the values below → pull the images → restart the containers →
confirm the live site responds. One-time setup:

**A dedicated deploy key** — separate from the personal one you SSH in
with, so it can be revoked on its own without locking you out of the box:

```bash
ssh-keygen -t ed25519 -C "github-actions-deploy" -f ~/.ssh/applicient_ci -N ""
```

(No passphrase — GitHub Actions has nowhere to type one. That's fine:
this key only grants what the `ubuntu` account it's added to can already
do, and the workflow's script is fixed, not arbitrary shell access from
outside the repo.)

Add the **public** half to the VPS, as `ubuntu`:

```bash
# on the VPS
echo "<paste contents of applicient_ci.pub>" >> ~/.ssh/authorized_keys
```

**A Docker Hub access token** — Docker Hub → Account Settings → Security
→ New Access Token, scope **Read & Write**.

**Repo visibility on Docker Hub.** Free accounts get exactly one private
repo — with three images (api/web/browser-worker) you're over that
either way, so make all three **Public** when you create them (or after,
under each repo's Settings). Nothing sensitive is baked into these
images — real secrets are injected at container start from the values
below, not at build time.

**GitHub repo secrets** — Settings → Secrets and variables → Actions →
**Secrets** tab → New repository secret. These become the sensitive lines
of `.env`, written fresh on every deploy:

| Secret | Value |
|---|---|
| `VPS_HOST` | the VPS's public IPv4 |
| `VPS_USER` | `ubuntu` |
| `VPS_SSH_KEY` | full contents of `~/.ssh/applicient_ci` (the **private** key — include the `BEGIN`/`END` lines) |
| `DOCKERHUB_TOKEN` | the access token from above (not your Docker Hub password) |
| `POSTGRES_PASSWORD` | generate a real one |
| `S3_ACCESS_KEY` | generate a real one |
| `S3_SECRET_KEY` | generate a real one |
| `SECRET_KEY` | `python3 -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"` — **never rotate this once real users exist**, it's the encryption key for every tenant's stored credentials |
| `DEMO_USER_PASSWORD` | any password — only used by the seeded demo account |
| `RESEND_API_KEY` | Resend dashboard → API Keys — used for verification/scheduled-run emails (v2 Phase 0) |
| `DODO_PAYMENTS_API_KEY` | Dodo dashboard → Developer → API Keys (a test-mode key to start) |
| `DODO_PAYMENTS_WEBHOOK_KEY` | Dodo dashboard → Developer → Webhooks → your endpoint → signing secret |
| `LANGSMITH_API_KEY` | optional — leave the secret unset if you're not using LangSmith |
| `GMAIL_CLIENT_SECRET` | optional — only needed for step 10 (Gmail) |

**GitHub repo variables** — same page, **Variables** tab instead of
**Secrets** (these aren't sensitive, so no reason to hide them):

| Variable | Value |
|---|---|
| `DOCKERHUB_USERNAME` | your Docker Hub username |
| `NEXT_PUBLIC_API_URL` | `https://api.applicient.my.id` |
| `NEXT_PUBLIC_DODO_PAYMENTS_MODE` | `test` until step 9 confirms billing end to end, then `live` |
| `DODO_PAYMENTS_ENVIRONMENT` | `test_mode` until step 9 confirms billing end to end, then `live_mode` |
| `ADMIN_EMAIL` | the real email you'll sign up with — that account becomes admin automatically |
| `FRONTEND_URL` | `https://applicient.my.id` |
| `API_BASE_URL` | `https://api.applicient.my.id` — the API's own public URL, used to build the email-verification link (v2 Phase 1) |
| `CORS_ORIGINS` | `https://applicient.my.id,https://www.applicient.my.id` |
| `CADDY_EMAIL` | your real email — Let's Encrypt renewal/expiry notices |
| `EMAIL_FROM` | optional — leave unset to use Resend's shared sandbox sender until you have a verified sending domain |
| `BROWSER_WORKER_MAX_SESSIONS` | `2` (see step 1) |
| `LANGSMITH_PROJECT` | `applicient` — optional |
| `GMAIL_CLIENT_ID` | optional — only needed for step 10 (Gmail) |
| `GMAIL_REDIRECT_URI` | optional — only needed for step 10 (Gmail) |
| `GOOGLE_LOGIN_REDIRECT_URI` | `https://api.applicient.my.id/auth/google/callback` — a second redirect URI on the *same* Google OAuth client as `GMAIL_REDIRECT_URI` (v2 Phase 1, "Continue with Google") |
| `GMAIL_PUBSUB_TOPIC` | optional — only needed for step 10 (Gmail) |

**Keep your own copy of what you just typed**, somewhere like a password
manager. GitHub secrets are write-only — once saved, the UI never shows
you the value again — so if GitHub Actions is ever unavailable and you
need to reconstruct `.env` by hand on the VPS as an emergency fallback,
these are the only place those values exist.

**Trigger the first deploy** — push to `main`, or trigger it manually
(Actions tab → Deploy → Run workflow), and watch the three jobs run:
`verify` → `build-and-push` → `deploy`. This *is* the first real
deployment — there's no separate manual build step before it. A failure
shows up as a red X with real logs; the last step curls the live site, so
a green run means it's actually up, not just that containers started.

**Manual override**, if CI is ever down and you need to deploy directly
from the box — reconstruct `.env` by hand first (same fields as the
tables above, from your password manager), then:

```bash
cd /opt/applicient
docker compose build            # only if you also need to build locally
docker compose up -d
```

## 8. Create the real admin account

1. Go to `https://applicient.my.id/signup` and sign up with the exact
   email you set as `ADMIN_EMAIL` (step 7). That account becomes
   `role=admin` automatically on signup — no manual DB step.
2. Log in, confirm you see the "Admin" nav section (Models, Cost, Run
   Console, Users, Plans) that a regular signup won't see.
3. In the admin Models/Providers page, connect at least one LLM provider
   — nothing in the app can call an LLM until an admin-owned model
   profile exists.

## 9. Test billing end to end

1. In the Dodo dashboard (still using the test-mode key at this point),
   add a webhook endpoint pointed at
   `https://api.applicient.my.id/webhooks/dodo`, subscribed to at least
   the `subscription.*` events, and confirm its signing secret matches
   `DODO_PAYMENTS_WEBHOOK_KEY`.
2. From a regular (non-admin) test account, walk `/billing` → Upgrade
   on a paid plan. The first click for a given plan creates its Dodo
   Product automatically (routers/admin.py/billing_service.py's
   `ensure_product_for_plan` — no manual "create a product" step in the
   Dodo dashboard), then opens the embedded checkout overlay right on
   the page — it should never redirect you away from Applicient. Pay
   with a Dodo test card and confirm `/billing` shows the subscription
   active once the overlay closes (there's also a manual "Sync payment
   status" button if that doesn't happen automatically — polling is
   authoritative, the webhook is just a faster nudge; see
   billing_service.py's own docstring).
3. Once that round-trip works end to end: update the
   `DODO_PAYMENTS_API_KEY`/`DODO_PAYMENTS_WEBHOOK_KEY` GitHub secrets
   with your live-mode key and the live webhook endpoint's signing
   secret, set the `DODO_PAYMENTS_ENVIRONMENT` and
   `NEXT_PUBLIC_DODO_PAYMENTS_MODE` variables to `live_mode`/`live`,
   push (or re-run the workflow) to redeploy, and do one small real
   payment yourself to confirm the live path too before announcing the
   site. A live-mode redeploy creates fresh live-mode Dodo Products the
   first time each plan is checked out again (test-mode and live-mode
   products are separate in Dodo, same as most payment processors) —
   expected, not a bug.

## 10. (Optional) Gmail integration on the real domain

Only needed if you want email-based application tracking to work in
production. In Google Cloud Console, on the OAuth 2.0 Client ID:

- Add authorized redirect URI: `https://api.applicient.my.id/gmail/callback`

Then set these as GitHub repo values (step 7) and push to redeploy:

- `GMAIL_CLIENT_ID` — variable
- `GMAIL_CLIENT_SECRET` — secret
- `GMAIL_REDIRECT_URI` — variable, `https://api.applicient.my.id/gmail/callback`

`GMAIL_PUBSUB_TOPIC`/push notifications are a further optional step (real
GCP Pub/Sub infra) — without it Gmail connect still works, just via
polling instead of push.

## 11. Ongoing operations

**Logs** (structured JSON — `logging_config.py`):

```bash
docker compose logs -f api
docker compose logs -f --tail=200 api | grep '"user_id": "<some-uuid>"'
```

**Backups** — the only thing with real state you can't just rebuild:

```bash
# Postgres dump
docker compose exec postgres pg_dump -U applicient applicient | gzip > backup-$(date +%F).sql.gz

# MinIO data — back up the volume directly, or mirror to real S3
docker run --rm -v applicient_miniodata:/data -v $(pwd):/backup alpine \
  tar czf /backup/minio-backup-$(date +%F).tar.gz -C /data .
```

Put the pg_dump command on a cron job; keep at least a few days of
rotation.

**Updating**: `git push` to `main` — GitHub Actions (step 7) builds and
deploys automatically, including rewriting `.env` from the current GitHub
Secrets/Variables. Step 7's manual override is the fallback if CI is
unavailable.

**A note on scaling**: `api` must stay a single replica for now —
`scheduler.py`'s in-process APScheduler has no distributed lock, so a
second `api` replica would double-fire every scheduled job (Gmail polling,
saved-search cron runs). Real horizontal scaling of the scheduler is a
separate, deferred piece of work, not something to reach for by just
bumping a replica count.

## Troubleshooting

- **Caddy can't get a certificate**: almost always DNS — re-run the `dig`
  commands from step 3, confirm they return the VPS's IP, and check
  `ufw status` shows 80/443 allowed.
- **API returns CORS errors in the browser console**: the `CORS_ORIGINS`
  GitHub variable doesn't exactly match the origin the browser is on
  (scheme + host, no trailing slash) — fix it and push (or re-run the
  workflow) to redeploy.
- **`api` container exits immediately on boot**: almost certainly the
  `SECRET_KEY` secret is unset or malformed — `docker compose logs api`
  will show `_require_secret_key`'s error message directly (it fails
  fast on purpose, before accepting any request).
- **Web shows stale API URL after changing `NEXT_PUBLIC_API_URL`**: it's
  a GitHub variable, used to build the `web` image — update it under
  Settings → Secrets and variables → Actions → Variables, then push (or
  re-run the workflow) to rebuild `web`.
- **GitHub Actions' `deploy` job fails at the final health-check curl**:
  usually means Caddy/TLS (step 6) isn't actually up yet — confirm you
  get at least a `502` (not a connection/cert error) at
  `https://applicient.my.id` before wiring up step 7.
- **`docker compose pull` on the VPS fails with "unauthorized" /
  "denied"**: the Docker Hub repos are still private — see step 7's
  visibility note, or `docker login` on the VPS with a read-only access
  token if you're keeping them private on purpose.
- **The `deploy` job's scp/ssh steps fail**: check `VPS_HOST`/`VPS_USER`/
  `VPS_SSH_KEY` secrets first — if one step works and another doesn't,
  the secrets are probably fine and it's more likely `/opt/applicient`
  doesn't exist yet or isn't owned by `ubuntu` (step 5's one-time
  `mkdir`/`chown`).
- **You need to see what `.env` currently holds on the VPS**: `cat
  /opt/applicient/.env` — it's a real file, just one nobody edits by
  hand anymore; GitHub Secrets are the source of truth, this is only the
  rendered copy from the last deploy.
