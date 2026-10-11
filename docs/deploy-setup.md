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

# The running service reads those secrets as the default compute account.
RUNTIME_SA=${PROJECT_NUMBER}-compute@developer.gserviceaccount.com
for s in livekit-api-key livekit-api-secret; do
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

Create `agent/livekit.secrets` (gitignored) with two lines:

```
GOOGLE_CLOUD_PROJECT=your-project-id
GOOGLE_CREDENTIALS_B64=<the base64 line>
```

```powershell
lk agent create --secrets-file livekit.secrets
```

That registers the agent, builds `agent/Dockerfile` on LiveKit, and writes `agent/livekit.toml`. **Commit `livekit.toml`** (it holds the agent id, not a secret). LiveKit injects `LIVEKIT_URL`, `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET` itself. The code turns `GOOGLE_CREDENTIALS_B64` back into a key file at start-up (`_materialize_google_key` in `agent/config.py`).

Build plan: scales to zero when idle, so the first visitor waits 10 to 20 s. Rolling back instantly needs a paid plan; on Build, revert the code and push.

## 3. Vercel (frontend)

1. vercel.com → Add New → Project → import `Kundn1811/live_agent`.
2. **Root Directory:** `frontend`. Framework: Vite. **Production Branch:** `master`.
3. Environment variable `VITE_TOKEN_URL` = `<Cloud Run URL>/token`. It is public, not a secret.
4. `frontend/vercel.json` already makes `/private` and `/legacy` load the app.

## 4. GitHub secrets and variables

Repo → Settings → Secrets and variables → Actions.

| Name | Kind | Value |
|---|---|---|
| `LIVEKIT_URL` | Secret | `wss://<project>.livekit.cloud` |
| `LIVEKIT_API_KEY` | Secret | LiveKit key |
| `LIVEKIT_API_SECRET` | Secret | LiveKit secret |
| `AGENT_SECRET_LIST` | Secret | `GOOGLE_CLOUD_PROJECT=<id>,GOOGLE_CREDENTIALS_B64=<base64>` (no spaces) |
| `GCP_WIF_PROVIDER` | Secret | from step 1 |
| `GCP_SERVICE_ACCOUNT` | Secret | from step 1 |
| `GCP_PROJECT_ID` | Variable | your project id |
| `CORS_ORIGINS` | Variable | the Vercel address, e.g. `https://sparrow.vercel.app` |

## 5. First deploy order

The pieces need each other's address, so go in this order:

1. Merge the feature branch into `master` (and push). Both workflows run; the token server needs `CORS_ORIGINS` set first, so put a placeholder (`http://localhost:5173`) if Vercel does not exist yet.
2. Copy the Cloud Run URL from the token workflow's log (the Smoke test step prints it).
3. In Vercel set `VITE_TOKEN_URL`, then deploy the frontend (Redeploy).
4. Set `CORS_ORIGINS` to the real Vercel address, then re-run **Deploy token server** from the Actions tab.
5. Test `/`, the gate, and `/private`, then share the link.

## 6. Known gaps

- **`/private` does not work in the cloud yet.** `agent/codes.json` and `agent/personas/*.md` (the partner persona) are gitignored on purpose, so no pipeline can ship them. The public Sparrow route is unaffected. Fix, if wanted: pass them as secrets and read them from env vars (small change in `personas.py` and `token_server.py`).
- **Token server cost:** 0.5 vCPU + 512 MiB kept warm is about $6 a month before the free tier, not $2. Use `--cpu 0.25 --memory 256Mi` in the workflow for about $3.
- Token server runs one copy only (`--max-instances 1`) because the gate counters are in memory. They still reset on each new deploy.
- Frontend previews for other branches get their own Vercel address, which `CORS_ORIGINS` will block. Harmless.
