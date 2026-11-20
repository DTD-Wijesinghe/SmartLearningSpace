(function tests() {
  const { test } = require('node:test');
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { createServer } = require('./server');

  test('approved teacher publishes a lesson and a student enrolls and completes it', async t => {
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
    await request(route, 404, undefined, studentToken);
    await request(route, 404, undefined, otherToken);
    await request(route + '/publish', 409, {}, teacherToken);
    await request(route + '/lessons', 200, { title: 'Welcome', text: 'Course material' }, teacherToken);
    await request(route + '/publish', 200, {}, teacherToken);
    assert.deepEqual((await request(route, 200, undefined, studentToken)).lessons, []);
    await request(route + '/enroll', 200, {}, studentToken);
    await request(route + '/enroll', 200, {}, studentToken);
    const { lessons } = await request(route, 200, undefined, studentToken);
    assert.equal(lessons[0].text, 'Course material');
    await request(route + '/progress', 200, { lessonId: lessons[0].id }, studentToken);
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
    const draft = (await request('courses', 201, { title: 'Draft Module' }, teacherToken)).course;
    const draftRoute = 'courses/' + draft.id;
    await request(draftRoute + '/archive', 403, {}, teacherToken);
    await request(draftRoute + '/archive', 200, {}, admin);
    await request(draftRoute + '/archive', 200, {}, admin);
    assert.deepEqual(await request(draftRoute + '/moderation', 200, undefined, admin), { assets: [] });
    await request(draftRoute + '/moderation', 403, undefined, teacherToken);
    await request(draftRoute + '/restore', 200, {}, admin);
    assert.equal((await request(draftRoute, 200, undefined, teacherToken)).course.status, 'draft');
  });
})();
