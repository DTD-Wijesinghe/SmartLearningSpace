const test = require('node:test');
const assert = require('node:assert/strict');
const { createProviders } = require('./providers');
const { moduleServices } = require('./module-services');

const id = 'a1111111-1111-4111-a111-111111111111';
const material = { id, mime: 'application/pdf', size_bytes: 21, ready_at: null };

test('R2 signer binds length, content type, and write-once condition', async () => {
  const adapter = createProviders({
    R2_ACCOUNT_ID: 'abcd'.repeat(8), R2_BUCKET: 'fixture', R2_ACCESS_KEY_ID: 'fixture-id',
    R2_SECRET_ACCESS_KEY: 'fixture-only-key',
  }).r2;
  const upload = new URL(await adapter.upload(material));
  assert.equal(upload.host, adapter.origin.slice(8));
  assert.equal(upload.pathname, '/fixture/materials/' + id);
  assert.equal(upload.searchParams.get('X-Amz-Expires'), '1800');
  assert.equal(upload.searchParams.get('X-Amz-SignedHeaders'), 'content-length;content-type;host;if-none-match');
  const download = new URL(await adapter.download(material));
  assert.equal(download.searchParams.get('response-content-disposition'), 'inline');
});

test('live tokens are room-scoped and students cannot publish', async () => {
  const adapter = createProviders({ LIVEKIT_URL: 'wss://fixture.example.test', LIVEKIT_API_KEY: 'fixture',
    LIVEKIT_API_SECRET: 'fixture-only-livekit-secret-1234567890' }).live;
  const grant = await adapter.token({ session: id, identity: id, name: 'Fixture', host: false });
  const claims = JSON.parse(Buffer.from(grant.token.split('.')[1], 'base64url'));
  assert.equal(claims.video.room, 'sls-' + id);
  assert.equal(claims.video.roomJoin, true);
  assert.equal(claims.video.canPublish, false);
  assert.ok(claims.exp - Math.floor(Date.now() / 1000) <= 120);
});

test('material reservation and confirmation require authorization and matching object metadata', async () => {
  const recorded = [];
  let matches = false;
  const service = moduleServices({
    providers: { r2: { upload: async () => 'fixture-upload', inspect: async () => ({ mime: material.mime, size: matches ? 21 : 22 }) } },
    serviceRpc: async (token, action) => {
      recorded.push(action);
      if (token !== 'teacher') throw Object.assign(new Error('Denied'), { status: 403 });
      return material;
    },
    confirmAsset: async () => { recorded.push('server_confirmation'); return true; },
  });
  await assert.rejects(service('student', 'reserve_asset', id, { name: 'QA', lessonId: id }), { status: 403 });
  assert.equal((await service('teacher', 'reserve_asset', id, { name: 'QA', lessonId: id })).uploadUrl, 'fixture-upload');
  await assert.rejects(service('teacher', 'confirm_asset', id, { assetId: id }), { status: 409 });
  assert.ok(!recorded.includes('server_confirmation'));
  matches = true;
  assert.deepEqual(await service('teacher', 'confirm_asset', id, { assetId: id }), { ready: true });
});

test('AI feedback uses authorized assessment facts and excludes student identity', async () => {
  let input;
  let calls = 0;
  const service = moduleServices({
    providers: { ai: async (system, context) => { input = context; return 'Review the second concept.'; } },
    rpc: async (token, action) => action === 'me' ? { user: { role: token } } : {
      exams: [{ id, questions: [{ prompt: 'Pick one', options: ['A','B'] }],
        submissions: [{ student: id, name: 'Private learner', score: 0, total: 1, answers: [1] }] }],
    },
    serviceRpc: async (_, action) => { assert.equal(action, 'ai_quota'); calls++; },
  });
  await assert.rejects(service('student', 'ai_feedback', id, { examId: id, studentId: id }), { status: 403 });
  assert.equal(calls, 0);
  assert.deepEqual(await service('teacher', 'ai_feedback', id, { examId: id, studentId: id }), { answer: 'Review the second concept.' });
  assert.equal(calls, 1);
  assert.deepEqual(input, { score: 0, total: 1, questions: [{ prompt: 'Pick one', chosen: 'B' }] });
});
