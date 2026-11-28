// The pull request's preview comment (D-364): one comment, edited in place, that says whether the preview is
// building, live (the preview URL serves this commit's version.json) or deployed but not yet live.
module.exports = async ({ github, context, state, detail }) => {
  const marker = '<!-- pages-preview -->';
  const url = process.env.PREVIEW_URL;
  const sha = process.env.SOURCE_SHA.substring(0, 7);
  const status = {
    building: `⏳ **Building ${sha}…** The links below still show the previous build until this says Live.`,
    live: `✅ **Live: ${sha}**, ${detail}. The Overview panel of the demonstrator shows the same build.`,
    late: `⚠️ **Deployed ${sha}, not yet live** after ${detail}. GitHub Pages may still be publishing: reload in a minute.`,
  }[state];
  const body = [
    marker,
    status,
    '',
    `**Demonstrator preview:** ${url}demo/`,
    `**Custom components (before OpenSensorHub):** ${url}demo/?hand-made`,
    `**Documents preview:** ${url}`,
    '',
    'The links are persistent: they are updated on every push and stay after the PR closes.',
  ].join('\n');
  const { owner, repo } = context.repo;
  const issue_number = context.issue.number;
  const comments = await github.paginate(github.rest.issues.listComments, { owner, repo, issue_number, per_page: 100 });
  const existing = comments.find((c) => c.user.type === 'Bot' && c.body && c.body.includes(marker));
  if (existing) await github.rest.issues.updateComment({ owner, repo, comment_id: existing.id, body });
  else await github.rest.issues.createComment({ owner, repo, issue_number, body });
};
