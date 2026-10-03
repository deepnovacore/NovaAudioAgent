const { test } = require('node:test');
const assert = require('node:assert/strict');
const { prepare, publish } = require('./pr-review.cjs');

const head = 'a'.repeat(40);
const base = 'b'.repeat(40);
function fixture() {
  const pr = { number: 12, state: 'open', draft: false,
    head: { sha: head }, base: { sha: base, ref: 'main' } };
  const comments = [];
  const writes = [];
  const permissions = { maintainer: 'write', outsider: 'read' };
  const github = {
    rest: {
      repos: { getCollaboratorPermissionLevel: async ({ username }) => ({ data: { permission: permissions[username] } }) },
      pulls: { get: async () => ({ data: pr }) },
      issues: {
        listComments: 'comments',
        createComment: async (value) => writes.push(['create', value]),
        updateComment: async (value) => writes.push(['update', value]),
      },
    },
    paginate: async () => comments,
  };
  const context = { repo: { owner: 'example', repo: 'public' }, actor: 'maintainer',
    eventName: 'pull_request_target', payload: { pull_request: structuredClone(pr) } };
  const env = { HAS_KEY: 'true', PR_REVIEW_MODEL: 'qwen/qwen3.8-flash', GITHUB_TRIGGERING_ACTOR: 'maintainer' };
  return { github, context, env, pr, comments, writes };
}

test('review gating and publishing never spend or publish for unauthorized, duplicate or stale work', async () => {
  const f = fixture();
  const plan = await prepare(f);
  assert.equal(plan.run, 'true');
  assert.equal(plan.head, head);
  assert.equal(plan.base, base);
  assert.equal(plan.number, 12);

  for (const change of [
    x => { x.env.HAS_KEY = 'false'; },
    x => { x.context.actor = 'outsider'; },
    x => { x.env.GITHUB_TRIGGERING_ACTOR = 'outsider'; },
    x => { x.pr.draft = true; },
    x => { x.pr.state = 'closed'; },
    x => { x.pr.base.ref = 'internal'; },
    x => { x.pr.head.sha = 'c'.repeat(40); },
  ]) {
    const blocked = fixture();
    change(blocked);
    assert.equal((await prepare(blocked)).run, 'false');
  }
  f.comments.push({ id: 1, user: { login: 'github-actions[bot]', type: 'Bot' }, body: plan.marker + '\nPrevious review' });
  assert.equal((await prepare(f)).run, 'false');
  f.comments[0].user = { login: 'outsider', type: 'User' };
  assert.equal((await prepare(f)).run, 'true');

  const manual = fixture();
  manual.context.eventName = 'workflow_dispatch';
  manual.context.payload = { inputs: { pr: '12' } };
  assert.equal((await prepare(manual)).run, 'true');
  manual.context.payload.inputs.pr = '12; echo nope';
  await assert.rejects(prepare(manual), /PR number/);

  const post = fixture();
  await publish({ ...post, plan, message: 'Summary\n@everyone see the finding.' });
  assert.equal(post.writes.length, 1);
  assert.equal(post.writes[0][0], 'create');
  assert.ok(post.writes[0][1].body.startsWith(plan.marker));
  assert.ok(!post.writes[0][1].body.includes('@everyone'));
  post.comments.push({ id: 7, user: { login: 'github-actions[bot]', type: 'Bot' }, body: plan.marker + '\nOld' });
  await publish({ ...post, plan, message: 'Updated summary' });
  assert.equal(post.writes[1][0], 'update');
  assert.equal(post.writes[1][1].comment_id, 7);
  for (const change of [
    x => { x.pr.head.sha = 'c'.repeat(40); },
    x => { x.pr.base.sha = 'c'.repeat(40); },
    x => { x.pr.state = 'closed'; },
    x => { x.pr.draft = true; },
  ]) {
    const stale = fixture();
    change(stale);
    await publish({ ...stale, plan, message: 'Stale result' });
    assert.equal(stale.writes.length, 0);
  }
  await assert.rejects(publish({ ...fixture(), plan, message: '  ' }), /empty/i);
  await assert.rejects(publish({ ...fixture(), plan, message: 'x'.repeat(60000) }), /large/i);
});
