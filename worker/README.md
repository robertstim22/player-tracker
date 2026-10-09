# Cron Worker

Triggers the GitHub "Refresh stats" workflow on schedule (more reliable than GitHub's own cron).

    cd worker
    npx wrangler login
    npx wrangler secret put GITHUB_TOKEN   # fine-grained token: this repo, Actions = Read and write
    npx wrangler deploy

Check runs in the Cloudflare dashboard (Workers → player-tracker-cron → Logs) and the repo's Actions tab.
