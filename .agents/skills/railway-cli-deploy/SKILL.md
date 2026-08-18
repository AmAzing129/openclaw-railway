---
name: railway-cli-deploy
description: Deploys and operates this repository on Railway with the Railway CLI, including project/service creation, persistent storage, Volume exports, public networking, variables, redeploys, and health verification. Use when deploying this OpenClaw-on-Railway project or exporting its persistent data from a terminal.
---

# Railway CLI deployment

Use this skill for a fresh deployment of the repository that contains this skill. The workflow is intentionally CLI-first; do not switch to browser automation unless the user asks for it or the CLI requires an interactive login.

## Safety and privacy

- Never print, commit, or invent secrets. Do not run `openssl rand` on its own. After setting a secret, do not run `railway variable list` (including `--json` or `--kv`) — those print raw values.
- Do not set user-supplied secrets (API keys, bot tokens) unless the user provides the value and authorizes sending it to Railway.
- For `OPENCLAW_GATEWAY_TOKEN`, ask whether the user wants to generate it themselves or have you generate and set it. If you set it, never print the value; tell them to confirm it in the Railway Variables UI.
- Tell the user exactly which variables remain for them to enter in Railway.
- Treat the Railway project, service, volume, domain, and redeploy as requested infrastructure changes when the user asks to deploy.

## Redeploy vs upload

This CLI workflow creates the service by uploading the working tree. It is not connected to GitHub. Railway **Redeploy** (CLI `railway redeploy` or the dashboard button) reuses the previous deployment's uploaded snapshot and recorded build config. It does not upload the current directory and does not re-read local `railway.toml`.

`railway.toml` is applied only when Railway reads config from newly supplied source. Dashboard service settings default to `builder: RAILPACK` / `dockerfilePath: null`. After a failed first deploy, Redeploy can therefore skip the Dockerfile and fail at `railpack prepare`. Official docs: [railway redeploy](https://docs.railway.com/cli/redeploy) does not upload new code; [config as code](https://docs.railway.com/config-as-code/reference) is read when a new deployment is created from source.

Choose the command by whether source must be supplied again:

- `railway up --ci` — default whenever the current local tree or `railway.toml` (`builder = "DOCKERFILE"`) must take effect. Use it after the first deploy, after local file changes, after a Railpack/prepare failure, and whenever the last snapshot may not include this repo's config.
- `railway redeploy --yes` — only to re-run a snapshot already confirmed as `builder: DOCKERFILE`, typically after changing variables on a successful deploy.
- After the service is later connected to GitHub: **Deploy Latest Commit**. Dashboard **Redeploy** still does not pull new commits or re-read local files.

Never ask the user to click dashboard **Redeploy** to fix a missing volume, a stale CLI upload, or a Railpack builder.

## Workflow

1. Inspect `README.md`, `railway.toml`, `Dockerfile`, and the git status before deploying. Preserve unrelated local changes.
2. Check the CLI and authentication:

   ```bash
   command -v railway
   railway whoami --json
   ```

   If unauthenticated, use `railway login` and let the user complete the browser OAuth flow. Do not use `--browserless` on a normal desktop.

3. If there is no usable linked project, create a new project and deploy the current directory:

   ```bash
   railway up --new --name openclaw --ci
   ```

   Record the project ID, environment ID, service ID, and deployment ID from the output or `railway status --json`.

   The first deploy usually builds the Dockerfile, then fails because `/data` is not mounted yet. That is expected. Continue to volume creation. Do not recover with `railway redeploy` or by asking the user to click dashboard **Redeploy**.

4. Create the required persistent volume. The OpenClaw service requires `/data`; create it using the current CLI syntax, where service/environment selectors are parent options:

   ```bash
   railway \
     --project <PROJECT_ID> \
     --environment <ENVIRONMENT_ID> \
     --service <SERVICE_ID> \
     volume add --mount-path /data --json
   ```

   If the installed CLI rejects parent selectors, link the project first with `railway link --project <PROJECT_ID>` and retry `railway volume add --mount-path /data --json`.

5. Generate a Railway service domain targeting port 8080:

   ```bash
   railway domain \
     --project <PROJECT_ID> \
     --environment <ENVIRONMENT_ID> \
     --service <SERVICE_ID> \
     --port 8080 --json
   ```

6. Set `OPENCLAW_GATEWAY_TOKEN`. Ask the user which they prefer, and wait for the answer:

   - **Generate it themselves**: show this command as a copyable block and wait for them to paste the value in Railway → Variables. Do not run it for them.

     ```bash
     openssl rand -hex 32
     ```

   - **Have you generate and set it**: after they choose this, generate the secret and send it to Railway in one pipeline so the value never appears in command output. Use `--skip-deploys` so this does not Redeploy the previous snapshot (step 7 uploads with `railway up --ci`):

     ```bash
     openssl rand -hex 32 | tr -d '\n' | railway variable set OPENCLAW_GATEWAY_TOKEN --stdin --skip-deploys \
       --project <PROJECT_ID> \
       --environment <ENVIRONMENT_ID> \
       --service <SERVICE_ID>
     ```

     Do not run `openssl rand` first and then set. Do not use `railway variable list`, `--json`, or `--kv` afterward. Confirm only from the set command's exit status. If set fails, re-run the same pipeline (a new secret is fine) — do not capture or quote the value. Tell the user the variable was written and they should open Railway → the service → **Variables** to inspect it themselves.

   Optional provider/channel variables stay user-entered, and only when the user chooses them:

   ```text
   OPENAI_API_KEY=<user secret>
   ANTHROPIC_API_KEY=<user secret>
   OPENROUTER_API_KEY=<user secret>
   GEMINI_API_KEY=<user secret>
   TELEGRAM_BOT_TOKEN=<BotFather secret>
   ```

   Do not add placeholder values. `OPENCLAW_IMAGE_TAG` is optional; leave it unset to use the repository's tested default.

7. After the gateway token is set and the user has entered any remaining variables, upload the current directory again so Railway re-reads `railway.toml`:

   ```bash
   railway up --ci --project <PROJECT_ID> --environment <ENVIRONMENT_ID> --service <SERVICE_ID>
   ```

   Do not use `railway redeploy` or dashboard **Redeploy** at this step. See [Redeploy vs upload](#redeploy-vs-upload).

8. Verify with:

   ```bash
   railway status --json
   railway domain list --service <SERVICE_ID> --json
   curl -fsS https://<generated-domain>/healthz
   ```

   A successful deployment needs the volume mounted at `/data`, the gateway token present, deployment status `SUCCESS`, a Dockerfile builder (`builder: DOCKERFILE`, `dockerfilePath: /Dockerfile`), and an HTTP-success response from `/healthz`. If the builder is Railpack, see [Redeploy vs upload](#redeploy-vs-upload).

## Export persistent data

Use this workflow when the user asks to download, back up, inspect, or export the Railway Volume:

1. Run `railway status --json` and identify the exact project, environment, and OpenClaw service. Verify that the Volume is `READY`, mounted at `/data`, and has an active running deployment. Prefer explicit IDs in all subsequent commands.
2. Treat the archive as sensitive because `/data` can contain credentials, conversations, configuration, and paired-device state. Write it outside the repository (normally `~/Downloads`) with mode `0600`; never commit it or print secret-bearing file contents.
3. Check `railway ssh keys list`. If there is no usable local key, explain that Railway SSH requires one and get approval before registering a temporary key. After approval, generate a uniquely named Ed25519 key under `~/.ssh`, register it with `railway ssh keys add --key <key>.pub --name <name>`, and pass its private path through `--identity-file`.
4. Stream `/data` into a temporary local archive, then validate it before renaming it to the final path:

   ```bash
   backup="$HOME/Downloads/openclaw-volume-$(date +%Y-%m-%d).tar.gz"
   partial="${backup}.part"
   ssh_identity=()
   if [[ -n "${IDENTITY_FILE:-}" ]]; then
     ssh_identity=(--identity-file "$IDENTITY_FILE")
   fi
   umask 077
   trap 'rm -f "$partial"' EXIT

   railway ssh \
     --project <PROJECT_ID> \
     --environment <ENVIRONMENT_ID> \
     --service <SERVICE_ID> \
     "${ssh_identity[@]}" \
     -- tar -C /data -czf - . > "$partial"
   test -s "$partial"
   tar -tzf "$partial" >/dev/null
   mv "$partial" "$backup"
   trap - EXIT
   ```

   Do not trust the SSH command's exit status alone: also require a non-empty archive and a successful archive listing. Avoid configuration changes and new conversations during this live export so SQLite files and their WAL files are copied with minimal churn.

5. If the user wants to inspect the backup, summarize top-level paths and sizes without printing file contents. Optionally create a metadata-only inventory:

   ```bash
   tar -tvzf "$backup" > "${backup%.tar.gz}-inventory.txt"
   ```

   Explain that this text file is only a listing, not part of the backup.
6. If a temporary key was registered, remove it from Railway by its exact fingerprint, delete both local key files, and verify with `railway ssh keys list`. If removal requires 2FA, ask the user to complete that step rather than leaving the key unmentioned.
7. Report the final archive path, compressed size, entry count, checksum, and whether temporary credentials were cleaned up.

## Troubleshooting

- A preflight error saying the service requires `/data` means the volume was not attached; inspect `railway status --json`, create/attach the volume, then `railway up --ci` ([Redeploy vs upload](#redeploy-vs-upload)).
- `railpack prepare`, `builder: RAILPACK`, or `dockerfilePath: null` means this repo's `railway.toml` was not applied. Run `railway up --ci`; do not Redeploy that snapshot. The next upload should show `builder: DOCKERFILE` and `dockerfilePath: /Dockerfile`.
- A deployment that builds the Dockerfile successfully but does not start commonly lacks `OPENCLAW_GATEWAY_TOKEN`; return to the token step rather than guessing a value.
- Use `railway logs --build <DEPLOYMENT_ID>` for build failures and `railway logs` for runtime failures.
- Keep the generated domain and project/service IDs in the handoff, but never include variable values.
