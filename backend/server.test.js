(function tests() {
  const { test } = require('node:test');
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { createServer } = require('./server');

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
    assert.equal((await fetch(base + '/teacher/dashboard')).status, 200);
    assert.equal((await fetch(base + '/backend/data.json')).status, 404);
    await request('courses', 401);
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
    const { course } = await request('courses', 201, { title: 'Test Course' }, teacherToken);
    const route = 'courses/' + course.id;
    assert.equal((await request(route, 200, undefined, studentToken)).course.status, 'published');
    await request(route, 404, undefined, otherToken);
    await request(route + '/lessons', 200, { title: 'Welcome', text: 'Course material' }, teacherToken);
    await request(route + '/lessons', 200, { title: 'Practice' }, teacherToken);
    assert.deepEqual((await request(route, 200, undefined, studentToken)).lessons, []);
    const { outline } = await request(route + '/module_page', 200, undefined, studentToken);
    assert.deepEqual(outline.map(lecture => lecture.title), ['Welcome', 'Practice']);
    assert.ok(outline.every(lecture => !Object.hasOwn(lecture, 'text')));
    await request(route + '/message_create', 403, { kind: 'question', subject: 'Private', text: 'Can you help?' }, studentToken);
    await request(route + '/enroll', 200, {}, studentToken);
    await request(route + '/enroll', 200, {}, studentToken);
    const { lessons } = await request(route, 200, undefined, studentToken);
    assert.equal(lessons[0].text, 'Course material');
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
    await request(route + '/enroll', 200, {}, secondStudentToken);
    assert.deepEqual((await request(route + '/module_page', 200, undefined, secondStudentToken)).conversations, []);
    await request(route + '/message_reply', 404, { threadId: thread.id, text: 'Not my thread' }, secondStudentToken);
    await request(route + '/message_reply', 200, { threadId: thread.id, text: 'Of course.' }, teacherToken);
    assert.equal((await request(route + '/module_page', 200, undefined, activeToken)).conversations[0].messages.length, 2);
    await request(route + '/message_status', 403, { threadId: thread.id, closed: true }, teacherToken);
    await request(route + '/message_status', 200, { threadId: thread.id, closed: true }, admin);
    await request(route + '/message_reply', 409, { threadId: thread.id, text: 'Thanks.' }, activeToken);
    await request(route + '/message_status', 200, { threadId: thread.id, closed: false }, admin);
    await request(route + '/message_reply', 200, { threadId: thread.id, text: 'Thanks.' }, activeToken);
  });
})();
