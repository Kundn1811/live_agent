# Deploy pipeline: one-time setup

Push to `master` deploys each part on its own. Nothing here has been run yet: no Docker, `gcloud` or `lk` on the dev machine, so every command below is untested. Fix the doc as you hit errors.

| Part | Deployed by | Triggered when these change |
|---|---|---|
| Agent worker → LiveKit Cloud | `.github/workflows/deploy-agent.yml` (`livekit/deploy-action`) | `agent/agent.py`, `config.py`, `personas*`, `requirements.txt`, `Dockerfile`, `livekit.toml` |
| Token server → Cloud Run | `.github/workflows/deploy-token-server.yml` (`gcloud run deploy --source`) | `agent/token_server.py`, `config.py`, `personas.py`, `requirements-token.txt`, `Dockerfile.token` |
| Frontend → Vercel | Vercel's own GitHub link (no workflow) | Any push to `master` |

Both workflows also have a **Run workflow** button in the GitHub Actions tab. `backend/` is never deployed.

Repo: `Kundn1811/live_agent`. Deploys only fire once the work is merged into `master`.

## 1. Google Cloud (token server)

Run in Cloud Shell (console.cloud.google.com → the `>_` button), in your personal project.

```bash
PROJECT_ID=your-project-id
REPO=Kundn1811/live_agent
gcloud config set project $PROJECT_ID
PROJECT_NUMBER=$(gcloud projects describe $PROJECT_ID --format='value(projectNumber)')

gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
  secretmanager.googleapis.com iam.googleapis.com iamcredentials.googleapis.com

# LiveKit key + secret (from cloud.livekit.io -> Settings -> Keys)
printf '%s' 'PASTE_LIVEKIT_API_KEY'    | gcloud secrets create livekit-api-key    --data-file=-
printf '%s' 'PASTE_LIVEKIT_API_SECRET' | gcloud secrets create livekit-api-secret --data-file=-

# Access codes for /private: the contents of agent/codes.json (one line; use {} to start empty).
# Update later with: gcloud secrets versions add sparrow-codes --data-file=codes.json, then re-run the deploy.
gcloud secrets create sparrow-codes --data-file=codes.json   # run from agent/, or upload the file in Cloud Shell first

# The running service reads those secrets as the default compute account.
RUNTIME_SA=${PROJECT_NUMBER}-compute@developer.gserviceaccount.com
for s in livekit-api-key livekit-api-secret sparrow-codes; do
  gcloud secrets add-iam-policy-binding $s --member=serviceAccount:$RUNTIME_SA --role=roles/secretmanager.secretAccessor
done
# Source deploys build as that same account.
gcloud projects add-iam-policy-binding $PROJECT_ID --member=serviceAccount:$RUNTIME_SA --role=roles/cloudbuild.builds.builder

# The account GitHub deploys as.
gcloud iam service-accounts create gh-deployer
DEPLOYER=gh-deployer@${PROJECT_ID}.iam.gserviceaccount.com
for r in run.admin cloudbuild.builds.editor artifactregistry.admin storage.admin iam.serviceAccountUser serviceusage.serviceUsageConsumer; do
  gcloud projects add-iam-policy-binding $PROJECT_ID --member=serviceAccount:$DEPLOYER --role=roles/$r
done

# Let only this repo act as that account (no key file anywhere).
gcloud iam workload-identity-pools create github --location=global
gcloud iam workload-identity-pools providers create-oidc github-provider --location=global \
  --workload-identity-pool=github --issuer-uri=https://token.actions.githubusercontent.com \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository" \
  --attribute-condition="assertion.repository=='$REPO'"
gcloud iam service-accounts add-iam-policy-binding $DEPLOYER --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/github/attribute.repository/$REPO"

echo "GCP_WIF_PROVIDER    = projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/github/providers/github-provider"
echo "GCP_SERVICE_ACCOUNT = $DEPLOYER"
```

Also set a **budget alert** (Billing → Budgets) and keep Billing → Disable billing in mind as the emergency stop.

## 2. LiveKit (agent worker)

Install the `lk` CLI, then, from `agent/`:

```powershell
lk cloud auth
# base64 of the personal service-account key (one line)
[Convert]::ToBase64String([IO.File]::ReadAllBytes("C:\path\to\key.json"))
```

Both routes run on Vertex by default. (Optional: a **free-tier** Gemini API key for the public route; see Known gaps. Skip it if your key is billed.) Base64 the private persona files the same way (PowerShell: `[Convert]::ToBase64String([IO.File]::ReadAllBytes("agent\personas\partner.md"))`).

Create `agent/livekit.secrets` (gitignored) with these lines:

```
GOOGLE_CLOUD_PROJECT=your-project-id
GOOGLE_CREDENTIALS_B64=<the base64 line>
PERSONA_PARTNER_B64=<base64 of personas/partner.md>
PERSONA_PARTNER_GREETING_B64=<base64 of personas/partner.greeting.txt>
```

(One `PERSONA_<ID>_B64` pair per private persona; `<ID>` is the persona id upper-cased, `-` becomes `_`.)

```powershell
lk agent create --secrets-file livekit.secrets
```

That registers the agent, builds `agent/Dockerfile` on LiveKit, and writes `agent/livekit.toml`. **Commit `livekit.toml`** (it holds the agent id, not a secret). LiveKit injects `LIVEKIT_URL`, `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET` itself. The code turns `GOOGLE_CREDENTIALS_B64` back into a key file at start-up (`_materialize_google_key` in `agent/config.py`).

Build plan: scales to zero when idle, so the first visitor waits 10 to 20 s. Rolling back instantly needs a paid plan; on Build, revert the code and push.

## 3. Vercel (frontend)

1. vercel.com → Add New → Project → import `Kundn1811/live_agent`.
2. **Root Directory:** `frontend`. Framework: Vite. **Production Branch:** `master`.
3. Environment variable `VITE_TOKEN_URL` = `https://sparrow-token-<PROJECT_NUMBER>.us-central1.run.app/token`. It is public, not a secret. (The Cloud Run address is predictable from the service name, project number and region; confirm it after the first deploy.)
4. `frontend/vercel.json` already makes `/private` and `/legacy` load the app.

## 4. GitHub secrets and variables

Repo → Settings → Secrets and variables → Actions.

| Name | Kind | Value |
|---|---|---|
| `LIVEKIT_URL` | Secret | `wss://<project>.livekit.cloud` |
| `LIVEKIT_API_KEY` | Secret | LiveKit key |
| `LIVEKIT_API_SECRET` | Secret | LiveKit secret |
| `AGENT_SECRET_LIST` | Secret | `GOOGLE_CLOUD_PROJECT=<id>,GOOGLE_CREDENTIALS_B64=<base64>,PERSONA_PARTNER_B64=<base64>,PERSONA_PARTNER_GREETING_B64=<base64>` (no spaces) |
| `GCP_WIF_PROVIDER` | Secret | from step 1 |
| `GCP_SERVICE_ACCOUNT` | Secret | from step 1 |
| `GCP_PROJECT_ID` | Variable | your project id |
| `CORS_ORIGINS` | Variable | the Vercel address, e.g. `https://sparrow.vercel.app` |
| `TOKEN_MIN_INSTANCES` | Variable (optional) | `1` (default, about $3 a month, gate counters survive) or `0` (about $0, counters reset on each cold start, first visitor waits 1 to 3 s) |

## 5. First deploy order

Both addresses are known before anything is deployed: Vercel shows the project address when you create the project (step 3), and the Cloud Run address follows the pattern in step 3. So set everything up front and deploy once:

1. Create the Vercel project (step 3) and note its address. Set `CORS_ORIGINS` (GitHub variable) to it and `VITE_TOKEN_URL` in Vercel to the Cloud Run address.
2. Finish steps 1, 2 and 4.
3. Merge the feature branch into `master` (and push). Both workflows run, and Vercel builds the frontend.
4. If the Cloud Run address printed by the token workflow's Smoke test step differs from the one you used, fix `VITE_TOKEN_URL` and redeploy the frontend.
5. Test `/`, the gate, and `/private`, then share the link.

## 6. Known gaps

- **Both routes run on Vertex.** The free-tier Gemini API path is built but off: it needs a free-tier key (a key on a billed project costs the same as Vertex), `GEMINI_API_KEY` in the agent secrets and `PUBLIC_BACKEND=gemini_api` on the token server. Free-tier content may be used by Google to improve products, so only the public demo may use it. Untested live.
- Token server runs one copy only (`--max-instances 1`) because the gate counters are in memory. They reset on each new deploy, and on each cold start when `TOKEN_MIN_INSTANCES=0`.
- Token server size is 0.25 vCPU / 256 MiB. If it runs out of memory, raise `--memory` to 512Mi in the workflow.
- Frontend previews for other branches get their own Vercel address, which `CORS_ORIGINS` will block. Harmless.
