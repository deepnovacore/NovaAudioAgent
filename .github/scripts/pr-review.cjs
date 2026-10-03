const PREFIX = '<!-- nova-ai-review:';
const botComment = comment => comment.user?.login === 'github-actions[bot]' &&
  comment.user?.type === 'Bot' && comment.body?.startsWith(PREFIX);

async function prepare({ github, context, env = process.env }) {
  const skip = reason => ({ run: 'false', reason });
  if (env.HAS_KEY !== 'true') return skip('OPENROUTER_API_KEY is not configured.');
  // Check both the original actor and the person rerunning a workflow.
  for (const username of new Set([context.actor, env.GITHUB_TRIGGERING_ACTOR || context.actor])) {
    const { data } = await github.rest.repos.getCollaboratorPermissionLevel({ ...context.repo, username });
    if (!['write', 'maintain', 'admin'].includes(data.permission)) {
      return skip('A maintainer must manually dispatch reviews for external contributors.');
    }
  }
  const number = String(context.eventName === 'workflow_dispatch'
    ? context.payload.inputs?.pr : context.payload.pull_request?.number);
  if (!/^[1-9]\d*$/.test(number) || !Number.isSafeInteger(Number(number))) throw new Error('Invalid PR number.');
  const { data: pr } = await github.rest.pulls.get({ ...context.repo, pull_number: Number(number) });
  if (pr.state !== 'open' || pr.draft) return skip('PR is closed or still a draft.');
  if (!['main', 'v0.2.0dev', 'v0.3.0dev'].includes(pr.base.ref)) return skip('PR does not target a public development branch.');
  if (context.eventName === 'pull_request_target' && context.payload.pull_request.head.sha !== pr.head.sha) {
    return skip('A newer PR revision has superseded this event.');
  }
  if (![pr.head.sha, pr.base.sha].every(sha => /^[a-f0-9]{40}$/.test(sha))) throw new Error('Invalid commit SHA.');
  const model = env.PR_REVIEW_MODEL || 'qwen/qwen3.8-flash';
  if (!/^[a-zA-Z0-9_-]+\/[a-zA-Z0-9._:-]+$/.test(model)) throw new Error('Use an explicit OpenRouter model slug.');
  const marker = `${PREFIX}v1 base=${pr.base.sha} head=${pr.head.sha} model=${model} -->`;
  const comments = await github.paginate(github.rest.issues.listComments, {
    ...context.repo, issue_number: pr.number, per_page: 100,
  });
  if (comments.some(comment => botComment(comment) && comment.body.startsWith(marker + '\n'))) {
    return skip('This base/head/model combination has already been reviewed.');
  }
  return { run: 'true', number: pr.number, head: pr.head.sha, base: pr.base.sha, model, marker };
}

async function publish({ github, context, plan, message }) {
  if (typeof message !== 'string' || !message.trim()) throw new Error('Review output is empty.');
  if (Buffer.byteLength(message, 'utf8') > 48000) throw new Error('Review output is too large; refusing to publish a truncated review.');
  const { data: pr } = await github.rest.pulls.get({ ...context.repo, pull_number: Number(plan.number) });
  if (pr.state !== 'open' || pr.draft || pr.head.sha !== plan.head || pr.base.sha !== plan.base) return;
  const comments = await github.paginate(github.rest.issues.listComments, {
    ...context.repo, issue_number: pr.number, per_page: 100,
  });
  // Do not let model-generated text notify arbitrary users or teams.
  const body = `${plan.marker}\n## AI review / AI 代码审查\n\n${message.trim().replaceAll('@', '@\u200b')}\n\n---\n` +
    `Model: \`${plan.model}\` · Commit: \`${plan.head.slice(0, 12)}\`\n` +
    'Advisory review; not test execution or approval. / 仅供参考，不代表测试通过或批准合并。';
  const existing = comments.find(botComment);
  if (existing) {
    await github.rest.issues.updateComment({ ...context.repo, comment_id: existing.id, body });
  } else {
    await github.rest.issues.createComment({ ...context.repo, issue_number: pr.number, body });
  }
}

module.exports = { prepare, publish };
