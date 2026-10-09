// Starts the "Refresh stats" GitHub workflow on a Cloudflare cron schedule.
// GitHub's own scheduler often delays or drops runs; Cloudflare's is punctual.
// Secret required: GITHUB_TOKEN (fine-grained, this repo only, Actions: read & write).

async function dispatch(env) {
  const res = await fetch(
    `https://api.github.com/repos/${env.REPO}/actions/workflows/${env.WORKFLOW}/dispatches`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "player-tracker-cron",
      },
      body: JSON.stringify({ ref: env.BRANCH }),
    },
  );
  if (!res.ok) throw new Error(`GitHub dispatch failed: ${res.status} ${await res.text()}`);
}

export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(dispatch(env));
  },
  // Visiting the Worker URL triggers nothing; it just confirms the deploy.
  async fetch() {
    return new Response("player-tracker-cron is running");
  },
};
