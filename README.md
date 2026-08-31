# OpenClaw on Railway

Deploy a personal [OpenClaw](https://docs.openclaw.ai/) assistant on [Railway](https://railway.com/) with persistent storage.

---

## Prerequisites

1. A [Railway](https://railway.com/) account.
2. An API key from a supported model provider. This guide uses [OpenAI](https://platform.openai.com/). Anthropic, Gemini, OpenRouter, and others work the same way — see the [OpenClaw models documentation](https://docs.openclaw.ai/models).

Never commit tokens or API keys to your fork.

---

## Deploy

Two ways to get the same result: a public domain and a healthy `/healthz`. Use the Railway dashboard, or clone your fork and let a coding agent follow the included skill.

The container exposes only Caddy on port `8080`; OpenClaw listens on a loopback-only internal port.
Caddy removes inbound proxy and Tailscale identity headers, rebuilds forwarding information from
Railway's overwritten `X-Real-IP`, and then sends the normalized request to OpenClaw. Health checks
without `X-Real-IP` use their direct connection address. This avoids depending on Railway's internal
proxy IP ranges. It assumes public ingress overwrites `X-Real-IP` and that no untrusted sibling service
can reach port `8080` directly over the Railway private network.

### Railway dashboard

#### 1. Fork and import

1. Fork this repository.
2. In Railway, choose **New Project → Deploy from GitHub repo** and select your fork.

The first deployment usually fails. That is expected: the Volume, token, and public domain below are not configured yet.

#### 2. Attach persistent storage

OpenClaw stores configuration, chat history, and paired browser sessions on disk. The service will not start without a Volume mounted at exactly:

```text
/data
```

On the Railway **Project Canvas**, right-click the OpenClaw service card, choose **Attach Volume**, and set that mount path.

#### 3. Set required variables

Open the service **Variables** tab and add:

- `OPENCLAW_GATEWAY_TOKEN`: a long random secret. Generate one with:

  ```bash
  openssl rand -hex 32
  ```

  Paste the printed value into Railway. Do not commit it.

- `OPENAI_API_KEY`: your OpenAI API key.

Optional, only if you want Telegram as well:

- `TELEGRAM_BOT_TOKEN`: message [@BotFather](https://t.me/BotFather), send `/newbot`, and copy the token.
- `TELEGRAM_ALLOWED_USER_IDS`: your numeric Telegram user ID (digits only, not your `@username`). In Telegram, open [@userinfobot](https://t.me/userinfobot), tap **Start**, and copy the `Id` it replies with (for example `123456789`). Comma-separate multiple IDs.

If you add these variables after the first deploy, redeploy.

#### 4. Create a public domain

1. Open **Settings → Networking → Public Networking**.
2. Click **Generate Domain**.
3. Set the target port to `8080`.

#### 5. Redeploy and check health

Redeploy and wait for **Success**. Then open:

```text
https://<your-domain>/healthz
```

A successful response means the Gateway is running.

### Local clone and a coding agent

This path uses the Railway CLI from your laptop. A coding agent (Claude Code, Cursor, Codex, Grok, and similar) runs the steps in [`.agents/skills/railway-cli-deploy/SKILL.md`](.agents/skills/railway-cli-deploy/SKILL.md).

1. Fork this repository.
2. Clone your fork and open that directory:

   ```bash
   git clone https://github.com/<you>/<your-fork>.git
   cd <your-fork>
   ```

3. Install the [Railway CLI](https://docs.railway.com/cli):

   ```bash
   bash <(curl -fsSL https://railway.com/install.sh)
   ```

   Confirm with `railway --version`. You do not need to log in first.

4. In this repository, paste this prompt to your coding agent:

   ```text
   Deploy this OpenClaw repo to Railway. Follow .agents/skills/railway-cli-deploy/SKILL.md exactly.
   ```

The agent will create the Railway project, upload this directory, attach a Volume at `/data`, generate a public domain on port `8080`, set `OPENCLAW_GATEWAY_TOKEN`, and check `https://<domain>/healthz`. Complete the browser login if the CLI opens one. When the agent asks, add provider keys (and optional Telegram tokens) in Railway **Variables** — do not put them in the prompt.

---

## Start using OpenClaw

Use either path, or both. Telegram works after the Telegram variables are set; you do not need the Console. Where a command is shown, run it in Railway's **Console** tab on the OpenClaw service — a shell inside the running container, not your laptop. The Console is available only after the latest deployment is **Success**.

### Option A: Control UI

1. In the Railway Console, generate a one-time Owner link:

   ```bash
   openclaw-railway owner-url
   ```

2. Open the printed URL immediately. It is short-lived and single-use. It pairs this browser profile as Owner and redirects to model setup. Do not share it, and do not open the bare service URL first.

3. On that model screen, click **Test & use**. Chat will not start until you do.

   If `OPENAI_API_KEY` is already set, it appears as **OpenAI API key** with the note `OPENAI_API_KEY set`. You do not need **Settings → Model Providers**, and you do not paste the key again.

   The default candidate is `openai/gpt-5.6-sol`. If the live test fails because your account cannot use that model, pick another OpenAI model on the same screen and click **Test & use** again.

4. After that, use the normal URL:

   ```text
   https://<your-domain>/
   ```

   Each new browser profile needs a freshly generated Owner link.

### Option B: Telegram

This path does not require the Control UI or a Console `openclaw models set`. Set the Telegram variables first, then message the bot. With your user ID in `TELEGRAM_ALLOWED_USER_IDS`, it replies directly. The default model is `openai/gpt-5.6-sol`.

If you set `TELEGRAM_BOT_TOKEN` but omit `TELEGRAM_ALLOWED_USER_IDS`, OpenClaw stays on its default pairing policy. The first DM returns a code. Approve it in the Railway Console (replace `<CODE>`):

```bash
openclaw pairing approve telegram <CODE>
```

To use a different model later, run this in the Railway Console:

```bash
openclaw models set openai/gpt-5.5
```

To list options:

```bash
openclaw models list
```

---

## Export the Volume

All persistent data lives under `/data`. To download a backup:

```bash
railway login
railway ssh --service openclaw -- tar -C /data -czf - . > openclaw-backup.tar.gz
```

Replace `openclaw` with your service name if it is different. The archive can contain credentials, conversations, and pairing state. Keep it private.

## Switch to another version

- **Official image** (default): leave `OPENCLAW_IMAGE_TAG` unset to use the repository's tested stable tag, currently `2026.8.1`. To pin another version, set `OPENCLAW_IMAGE_TAG` to a [tagged OpenClaw image](https://github.com/orgs/openclaw/packages/container/openclaw/versions?filters%5Bversion_type%5D=tagged) — the tag only, not a digest or architecture suffix.
- **Build from source**: set `OPENCLAW_BUILD_MODE=source` and `OPENCLAW_GIT_REF=<commit-sha-or-branch>`. Source builds need more memory and time.

Persistent data in `/data` survives image changes.

---

## License

[MIT](LICENSE)
