(function tests() {
  const { test } = require('node:test');
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const { createHash } = require('node:crypto');
  const os = require('node:os');
  const path = require('node:path');
  const { createServer } = require('./server');
  const { createSupabaseApi } = require('./supabase-api');

  test('Supabase recovery binds the emailed link to the same browser before changing the password', async t => {
    const calls = [];
    let validCode = false;
    t.mock.method(globalThis, 'fetch', async (url, options) => {
      const body = options.body && JSON.parse(options.body);
      calls.push([url.pathname, options.method, body, options.headers.Authorization]);
      if (url.pathname.endsWith('/recover')) return Response.json({ error: 'Address not eligible' }, { status: 400 });
      if (url.pathname.endsWith('/token')) return validCode
        ? Response.json({ access_token: 'fixture-recovery-token' })
        : Response.json({ error: 'Code expired' }, { status: 403 });
      return Response.json({});
    });
    const dispatch = createSupabaseApi({ url: 'https://fixture.example.test', key: 'sb_publishable_fixture' });
    const req = { method: 'POST', headers: {} };
    const email = 'teacher@example.test';
    const password = 'new-fixture-password-203';
    const request = await dispatch(req, '/api/password/recover', { email });
    assert.deepEqual(request.value, { accepted: true });
    const cookie = request.headers['Set-Cookie'];
    assert.match(cookie, /Secure; HttpOnly; SameSite=Lax/);
    const verifier = /^__Host-sls-recovery=([A-Za-z0-9_-]+);/.exec(cookie)[1];
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    assert.deepEqual(calls[0][2], { email, code_challenge: challenge, code_challenge_method: 's256' });
    const code = 'd5e2c2e0-6301-4314-8545-b667593a8ade';
    await assert.rejects(dispatch(req, '/api/password/reset', { password, code }), { status: 400 });
    req.headers.cookie = `__Host-sls-recovery=${verifier}`;
    await assert.rejects(dispatch(req, '/api/password/reset', { password, code }), { status: 400 });
    assert.equal(calls.length, 2);
    validCode = true;
    const reset = await dispatch(req, '/api/password/reset', { password, code });
    assert.deepEqual(reset.value, { updated: true });
    assert.match(reset.headers['Set-Cookie'], /Max-Age=0/);
    assert.deepEqual(calls.slice(2), [
      ['/auth/v1/token', 'POST', { auth_code: code, code_verifier: verifier }, undefined],
      ['/auth/v1/user', 'PUT', { password }, 'Bearer fixture-recovery-token'],
      ['/auth/v1/logout', 'POST', undefined, 'Bearer fixture-recovery-token'],
    ]);
  });

  test('approved teacher creates a visible module with lectures, progress, and private conversations', async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sls-test-'));
    const file = path.join(dir, 'data.json');
    const password = 'local-test-password-201';
    const server = createServer({ file, adminPassword: password });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => {
      await new Promise(resolve => server.close(resolve));
      fs.unlinkSync(file);
      fs.rmdirSync(dir);
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    async function request(route, expected, body, token) {
      const response = await fetch(base + '/api/' + route, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { ...(body !== undefined && { 'Content-Type': 'application/json' }),
          ...(token && { Authorization: `Bearer ${token}` }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const result = await response.json();
      assert.equal(response.status, expected, `${route}: ${JSON.stringify(result.error)}`);
      return result;
    }
    const login = (email, status = 200) => request('login', status, { email, password });
    const pageRoutes = ['/', '/index.html', '/login', '/register', '/forgot-password', '/reset-password', '/teacher/dashboard', '/student/dashboard', '/admin/dashboard', '/modules/sample'];
    for (const route of pageRoutes) {
      const page = await fetch(base + route);
      assert.equal(page.status, 200, route);
      assert.equal(page.headers.get('cache-control'), 'no-store', route);
      assert.equal(page.headers.get('referrer-policy'), 'no-referrer', route);
      assert.match(await page.text(), /class="site-footer"[\s\S]+Futora Labs/, route);
    }
    assert.equal((await fetch(base + '/backend/data.json')).status, 404);
    await request('courses', 401);
    const crossSite = await fetch(base + '/api/password/recover', { method: 'POST', headers: { 'Sec-Fetch-Site': 'cross-site' } });
    assert.equal(crossSite.status, 403);
    const teacher = 'test-teacher@example.test';
    const student = 'test-student@example.test';
    const other = 'other-teacher@example.test';
    const admin = (await login('admin@smartlearning.local')).token;
    await request('register', 201, { email: teacher, password, name: 'Test Teacher', teacher: true });
    await request('register', 201, { email: student, password, name: 'Test Student', role: 'admin' });
    await request('register', 201, { email: other, password, name: 'Other Teacher', teacher: true });
    await login(teacher, 403);
    await request('users/approve', 200, { email: teacher }, admin);
    await request('users/approve', 200, { email: other }, admin);
    const teacherToken = (await login(teacher)).token;
    const otherToken = (await login(other)).token;
    const studentLogin = await login(student);
    assert.equal(studentLogin.user.role, 'student');
    const studentToken = studentLogin.token;
    await request('users', 403, undefined, studentToken);
    await request('courses', 403, { title: 'Restricted' }, studentToken);
    await request('courses', 422, { title: 'Missing code' }, teacherToken);
    const enrollmentCode = 'ExampleModule-42';
    const replacementCode = 'ReplacementModule-73';
    const { course } = await request('courses', 201, { title: 'Test Course', enrollmentCode }, teacherToken);
    const route = 'courses/' + course.id;
    assert.equal((await request(route, 200, undefined, studentToken)).course.status, 'published');
    assert.deepEqual((await request('courses', 200, undefined, otherToken)).courses, []);
    await request(route, 404, undefined, otherToken);
    await request(route + '/lessons', 200, { title: 'Welcome', text: 'Course material' }, teacherToken);
    await request(route + '/lessons', 200, { title: 'Practice' }, teacherToken);
    assert.deepEqual((await request(route, 200, undefined, studentToken)).lessons, []);
    const { outline } = await request(route + '/module_page', 200, undefined, studentToken);
    assert.deepEqual(outline, []);
    await request(route + '/message_create', 403, { kind: 'question', subject: 'Private', text: 'Can you help?' }, studentToken);
    await request(route + '/enroll', 403, {}, studentToken);
    await request(route + '/enroll', 403, { enrollmentCode: 'IncorrectCode-20' }, studentToken);
    await request(route + '/enroll', 200, { enrollmentCode }, studentToken);
    await request(route + '/enroll', 200, {}, studentToken);
    const { lessons } = await request(route, 200, undefined, studentToken);
    assert.equal(lessons[0].text, 'Course material');
    const lectureEdit = { lessonId: lessons[0].id, title: 'Welcome revised', text: 'Updated course material' };
    await request(route + '/lesson_edit', 403, lectureEdit, studentToken);
    await request(route + '/lesson_edit', 404, lectureEdit, otherToken);
    await request(route + '/lesson_edit', 200, lectureEdit, teacherToken);
    assert.equal((await request(route, 200, undefined, studentToken)).lessons[0].text, lectureEdit.text);
    await request(route + '/progress', 200, { lessonId: lessons[0].id }, studentToken);
    await request(route + '/progress', 200, { lessonId: lessons[1].id }, studentToken);
    assert.equal((await request(route, 200, undefined, studentToken)).course.progress, 100);
    assert.deepEqual((await request(route, 200, undefined, teacherToken)).students, [{ name: 'Test Student' }]);
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(saved.courses.find(item => item.id === course.id).students.length, 1);
    assert.equal(saved.audit.length, 2);
    assert.ok(saved.users.every(account => !Object.hasOwn(account, 'password')));
    await request('logout', 200, {}, studentToken);
    await request('me', 401, undefined, studentToken);
    const freshToken = (await login(student)).token;
    await request('users/suspension', 200, { email: student, suspended: true }, admin);
    await request('me', 401, undefined, freshToken);
    await login(student, 403);
    await request('users/suspension', 200, { email: student, suspended: false }, admin);
    await request('me', 401, undefined, freshToken);
    const activeToken = (await login(student)).token;
    await request(route + '/suspend', 200, {}, admin);
    await request(route, 404, undefined, activeToken);
    await request(route + '/restore', 403, {}, teacherToken);
    await request(route + '/restore', 200, {}, admin);
    assert.equal((await request(route, 200, undefined, activeToken)).course.progress, 100);
    await request(route + '/archive', 403, {}, teacherToken);
    assert.deepEqual(await request(route + '/moderation', 200, undefined, admin), { assets: [] });
    await request(route + '/moderation', 403, undefined, teacherToken);
    const thread = await request(route + '/message_create', 200, { kind: 'question', subject: 'Private', text: 'Can you help?' }, activeToken);
    const secondStudent = 'other-student@example.test';
    await request('register', 201, { email: secondStudent, password, name: 'Other Student' });
    const secondStudentToken = (await login(secondStudent)).token;
    await request(route + '/edit', 200, { title: 'Test Course', enrollmentCode: replacementCode }, teacherToken);
    await request(route + '/enroll', 403, { enrollmentCode }, secondStudentToken);
    await request(route + '/enroll', 200, { enrollmentCode: replacementCode }, secondStudentToken);
    assert.equal((await request(route, 200, undefined, activeToken)).course.enrolled, true);
    assert.deepEqual((await request(route + '/module_page', 200, undefined, secondStudentToken)).conversations, []);
    await request(route + '/message_reply', 404, { threadId: thread.id, text: 'Not my thread' }, secondStudentToken);
    await request(route + '/message_reply', 200, { threadId: thread.id, text: 'Of course.' }, teacherToken);
    assert.equal((await request(route + '/module_page', 200, undefined, activeToken)).conversations[0].messages.length, 2);
    await request(route + '/message_status', 403, { threadId: thread.id, closed: true }, teacherToken);
    await request(route + '/message_status', 200, { threadId: thread.id, closed: true }, admin);
    await request(route + '/message_reply', 409, { threadId: thread.id, text: 'Thanks.' }, activeToken);
    await request(route + '/message_status', 200, { threadId: thread.id, closed: false }, admin);
    await request(route + '/message_reply', 200, { threadId: thread.id, text: 'Thanks.' }, activeToken);
    const feedback = await request('communications/submit', 200, { topic: 'issue', subject: 'Video playback', message: 'I need help.' }, activeToken);
    const adminInbox = await request('communications', 200, undefined, admin);
    const notice = adminInbox.notifications.find(item => item.title.includes('Video playback'));
    assert.equal(adminInbox.feedback[0].id, feedback.id);
    await request('communications/read', 404, { notificationId: notice.id }, teacherToken);
    await request('communications/read', 200, { notificationId: notice.id }, admin);
    assert.deepEqual((await request('communications', 200, undefined, secondStudentToken)).feedback, []);
    await request('communications/review', 403, { feedbackId: feedback.id, status: 'resolved' }, teacherToken);
    await request('communications/review', 200, { feedbackId: feedback.id, status: 'resolved', response: 'Please retry.' }, admin);
    const studentInbox = await request('communications', 200, undefined, activeToken);
    assert.equal(studentInbox.feedback[0].response, 'Please retry.');
    assert.ok(studentInbox.notifications.some(item => item.title === 'Feedback updated: Video playback'));
    await request('communications/read_all', 200, {}, activeToken);
    assert.equal((await request('communications/inbox', 200, undefined, activeToken)).unread, 0);
    const announcement = { audience: 'teacher', title: 'Maintenance window', message: 'A teaching workspace update.' };
    await request('communications/announce', 403, announcement, teacherToken);
    await request('communications/announce', 403, announcement, activeToken);
    const { users } = await request('users', 200, undefined, admin);
    const activeTeachers = users.filter(account => account.role === 'teacher' && !account.pending && !account.suspended);
    assert.equal((await request('communications/announce', 200, announcement, admin)).delivered, activeTeachers.length);
    for (const teacherSession of [teacherToken, otherToken]) {
      const inbox = await request('communications/inbox', 200, undefined, teacherSession);
      assert.ok(inbox.notifications.some(item => item.title === announcement.title && item.message === announcement.message));
    }
    for (const studentSession of [activeToken, secondStudentToken]) {
      const inbox = await request('communications/inbox', 200, undefined, studentSession);
      assert.ok(inbox.notifications.every(item => item.title !== announcement.title));
    }
  });
})();
