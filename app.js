'use strict';

(function boot() {
  const main = document.querySelector('#main');
  const nav = document.querySelector('#account-nav');
  let token = sessionStorage.getItem('sls-session');
  let user;
  let revision = 0;
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const dashboard = () => `/${user.role}/dashboard`;
  const labels = { admin: 'Platform administration', teacher: 'Teaching studio', student: 'Learning workspace' };

  async function api(path, data) {
    const response = await fetch(`/api/${path}`, {
      method: data === undefined ? 'GET' : 'POST',
      headers: { ...(token && { Authorization: `Bearer ${token}` }),
        ...(data !== undefined && { 'Content-Type': 'application/json' }) },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    const result = await response.json();
    if (!response.ok) throw Object.assign(new Error(result.error), { status: response.status });
    return result;
  }

  function go(path, replace = false) {
    history[replace ? 'replaceState' : 'pushState']({}, '', path);
    void render();
  }

  function clearSession() {
    token = null;
    user = null;
    sessionStorage.removeItem('sls-session');
  }

  function form(action, fields, caption) {
    return `<form data-submit="${action}">${fields}<button class="primary">${caption}</button><p class="error" role="status"></p></form>`;
  }

  async function render() {
    const current = ++revision;
    const path = location.pathname;
    nav.innerHTML = `<button data-theme aria-label="Toggle color theme">Theme</button>` + (user
      ? `<a href="${dashboard()}" data-link>Dashboard</a><button data-logout>Sign out</button>`
      : '<a href="/login" data-link>Sign in</a><a href="/register" data-link>Register</a>');
    if (path === '/') {
      main.innerHTML = `<section class="hero"><div><p class="eyebrow">SmartLearningSpace</p>
        <h1>Your Space for<br>Smarter Learning.</h1>
        <p>Create lesson content, publish courses and follow learner progress in one workspace.</p>
        <a class="primary" href="${user ? dashboard() : '/register'}" data-link>${user ? 'Open workspace' : 'Create an account'}</a></div>
        <img src="/assets/smartlearning-logo.png" alt=""></section>
        <section class="tiles"><article><h2>Teach</h2><p>Draft courses and add lessons before publishing.</p></article>
        <article><h2>Learn</h2><p>Discover courses, enroll and track completed lessons.</p></article>
        <article><h2>Manage</h2><p>Review teacher applications and see platform activity.</p></article></section>`;
      return;
    }
    if (path === '/login' || path === '/register') {
      if (user) return go(dashboard(), true);
      const register = path === '/register';
      const fields = `${register ? '<label>Name<input name="name" autocomplete="name" maxlength="160" required></label>' : ''}
        <label>Email<input name="email" type="email" autocomplete="username" required></label>
        <label>Password<input name="password" type="password" autocomplete="${register ? 'new-password' : 'current-password'}" ${register ? 'minlength="12"' : ''} maxlength="128" required></label>
        ${register ? '<label class="checkbox"><input name="teacher" type="checkbox"> Request a teacher account</label>' : ''}`;
      main.innerHTML = `<section class="auth panel"><h1>${register ? 'Create an account' : 'Sign in'}</h1>
        ${form(register ? 'register' : 'login', fields, register ? 'Register' : 'Sign in')}
        ${register ? '<a href="/login" data-link>Already registered? Sign in</a>' : '<a href="/register" data-link>Create an account</a>'}</section>`;
      return;
    }
    if (!user) return go('/login', true);
    if (path !== dashboard()) return go(dashboard(), true);
    main.innerHTML = '<p role="status">Loading dashboard…</p>';
    try {
      const [summary, catalog, accounts] = await Promise.all([api('dashboard'), api('courses'),
        user.role === 'admin' ? api('users') : null]);
      if (current !== revision) return;
      const cards = catalog.courses.map(course => `<article class="panel course">
        <p class="eyebrow">${escape(course.status)}</p><h3>${escape(course.title)}</h3>
        <p>${escape(course.teacher)} · ${course.lessonCount} lessons</p>
        ${course.enrolled ? `<progress max="100" value="${course.progress}" aria-label="Completion"></progress>` : ''}
        <button data-course="${escape(course.id)}">View course</button></article>`).join('');
      main.innerHTML = `<section class="workspace ${user.role}"><p class="eyebrow">${labels[user.role]}</p>
        <h1>Welcome, ${escape(user.name)}</h1>
        <div class="tiles">${Object.entries(summary.stats).map(([key, value]) =>
          `<article><strong>${escape(value)}</strong><p>${escape(key)}</p></article>`).join('')}</div>
        ${accounts ? `<h2>User management</h2><ul class="records">${accounts.users.map(account =>
          `<li><span>${escape(account.name)} · ${escape(account.role)}${account.pending ? ' · Awaiting approval' : ''}${account.suspended ? ' · Suspended' : ''}</span>
          ${account.pending ? form('users/approve', `<input type="hidden" name="email" value="${escape(account.email)}">`, 'Approve') : ''}
          ${account.role !== 'admin' ? form('users/suspension', `<input type="hidden" name="email" value="${escape(account.email)}">
            <input type="hidden" name="suspended" value="${!account.suspended}">`, account.suspended ? 'Reactivate' : 'Suspend') : ''}</li>`).join('')}</ul>` : ''}
        <h2>${user.role === 'student' ? 'Explore courses' : user.role === 'teacher' ? 'My courses' : 'Course oversight'}</h2>
        ${user.role === 'teacher' ? `<details class="panel"><summary>Create course</summary>${form('courses',
          '<label>Course title<input name="title" maxlength="160" required></label>', 'Save draft')}</details>` : ''}
        <div class="tiles">${cards || '<p>No courses available.</p>'}</div><section id="course-detail" tabindex="-1"></section></section>`;
    } catch (error) {
      if (current === revision) showError(error);
    }
  }

  function showError(error) {
    if (error.status === 401 && user) {
      clearSession();
      return go('/login', true);
    }
    main.innerHTML = `<p class="error" role="status">${escape(error.message)}</p><button data-retry>Try again</button>`;
  }

  async function openCourse(id) {
    const current = revision;
    const detail = document.querySelector('#course-detail');
    if (!detail) return;
    detail.textContent = 'Loading course…';
    try {
      const { course, lessons, students, completed } = await api(`courses/${id}`);
      if (current !== revision || !detail.isConnected) return;
      const route = `courses/${id}`;
      const manage = user.role === 'teacher' && course.status !== 'suspended';
      detail.innerHTML = `<article class="panel course-detail"><h2>${escape(course.title)}</h2>
        ${manage && course.status === 'draft' ? form(`${route}/publish`, '', 'Publish course') : ''}
        ${manage ? form(`${route}/edit`, `<label>Course title<input name="title" maxlength="160" value="${escape(course.title)}" required></label>`, 'Save title') : ''}
        ${user.role === 'admin' && ['published', 'in_progress', 'up_next', 'saved'].includes(course.status) ?
          form(`${route}/suspend`, '', 'Suspend course') : ''}
        ${manage ? form(`${route}/lessons`, '<label>Lesson title<input name="title" required></label><label>Lesson text<textarea name="text" required></textarea></label>', 'Add lesson') : ''}
        ${user.role === 'student' && !course.enrolled ? form(`${route}/enroll`, '', 'Enroll') : ''}
        ${students ? `<p>Enrolled students: ${students.map(student => escape(student.name)).join(', ') || 'None yet'}</p>` : ''}
        ${lessons.map(lesson => `<section class="lesson"><h3>${escape(lesson.title)}</h3><p>${escape(lesson.text)}</p>
          ${course.enrolled ? completed.includes(lesson.id) ? '<p>Completed</p>' :
            form(`${route}/progress`, `<input type="hidden" name="lessonId" value="${escape(lesson.id)}">`, 'Mark complete') : ''}</section>`).join('')}
        </article>`;
      detail.focus();
    } catch (error) {
      if (current === revision) detail.textContent = error.message;
    }
  }

  document.addEventListener('click', async event => {
    const control = event.target.closest('[data-link],[data-theme],[data-logout],[data-course],[data-retry]');
    if (!control) return;
    if (control.hasAttribute('data-link')) {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      go(control.getAttribute('href'));
    } else if (control.hasAttribute('data-theme')) {
      document.documentElement.classList.toggle('dark');
      localStorage.setItem('sls-theme', document.documentElement.classList.contains('dark') ? 'dark' : 'light');
    } else if (control.hasAttribute('data-logout')) {
      try { await api('logout', {}); } catch { /* Clear the browser session even if the API is offline. */ }
      clearSession();
      go('/login', true);
    } else if (control.dataset.course) {
      await openCourse(control.dataset.course);
    } else {
      await render();
    }
  });

  document.addEventListener('submit', async event => {
    const element = event.target;
    if (!element.dataset.submit) return;
    event.preventDefault();
    const button = element.querySelector('button');
    const status = element.querySelector('[role=status]');
    button.disabled = true;
    status.textContent = '';
    const values = Object.fromEntries(new FormData(element));
    if (values.teacher) values.teacher = true;
    if ('suspended' in values) values.suspended = values.suspended === 'true';
    try {
      const action = element.dataset.submit;
      const result = await api(action, values);
      if (action === 'login') {
        ({ token, user } = result);
        sessionStorage.setItem('sls-session', token);
        go(dashboard(), true);
      } else if (action === 'register') {
        element.reset();
        status.textContent = result.checkEmail
          ? 'Check your email to confirm your account. Teacher accounts also require administrator approval.'
          : result.pending ? 'Your application is awaiting administrator approval.' : 'Account created. You can sign in.';
      } else {
        await render();
        const courseId = /^courses\/([^/]+)/.exec(action)?.[1];
        if (courseId) await openCourse(courseId);
      }
    } catch (error) {
      status.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });

  window.addEventListener('popstate', render);
  document.documentElement.classList.toggle('dark', localStorage.getItem('sls-theme') === 'dark');
  void (async () => {
    if (token) {
      try { ({ user } = await api('me')); }
      catch { clearSession(); }
    }
    await render();
  })();
})();
