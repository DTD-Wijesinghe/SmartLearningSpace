'use strict';

(function boot() {
  const main = document.querySelector('#main');
  const nav = document.querySelector('#account-nav');
  let token = sessionStorage.getItem('sls-session');
  let user;
  let revision = 0;
  let courseRevision = 0;
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const dashboard = () => `/${user.role}/dashboard`;
  const labels = { admin: 'Platform administration', teacher: 'Teaching studio', student: 'Learning workspace' };
  const workspaceCopy = {
    admin: { description: 'Review accounts, teacher requests, and published courses.', action: 'User management', target: 'users' },
    teacher: { description: 'Build lessons, publish courses, and follow your enrollments.', action: 'Create a course', target: 'create' },
    student: { description: 'Find your next course, return to your lessons, and track your progress.', action: 'Explore courses', target: 'courses' },
  };

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
    window.scrollTo({ top: 0 });
  }

  function clearSession() {
    token = null;
    user = null;
    sessionStorage.removeItem('sls-session');
  }

  function form(action, fields, caption) {
    return `<form data-submit="${action}">${fields}<button class="primary" type="submit">${caption}</button><p class="error" role="status"></p></form>`;
  }

  function homepage() {
    const start = user ? dashboard() : '/register';
    const label = user ? 'Open workspace' : 'Get started';
    return `<div class="landing enter">
      <section class="hero">
        <div class="hero-copy">
          <p class="eyebrow"><span class="mini-mark" aria-hidden="true">✦</span> YOUR SPACE FOR SMARTER LEARNING</p>
          <h1>Learn together.<br><em>Grow further.</em></h1>
          <p>Find your next course, teach what you know, and turn every lesson into progress.</p>
          <div class="actions">
            <a class="primary" href="${start}" data-link>${label}</a>
            <button class="secondary" type="button" data-jump="how-it-works">How it works</button>
          </div>
        </div>
        <figure class="hero-art">
          <img src="/assets/learning-studio.webp" alt="Three students collaborating on a laptop in a sunny learning studio" width="1440" height="960" fetchpriority="high">
          <figcaption><span class="figure-icon" aria-hidden="true">✓</span><span><strong>Learning, at your pace</strong><small>Courses, lessons, and progress in one place</small></span></figcaption>
        </figure>
      </section>
      <section class="section-wrap" id="how-it-works" tabindex="-1">
        <header class="section-head landing-head"><h2>A workspace for every role</h2><p>Everyone has a clear next step, from the first lesson to the next course launch.</p></header>
        <div class="feature-grid">
          <article class="feature purple"><span class="feature-icon" aria-hidden="true">✦</span><h3>For students</h3><p>Discover published courses, enroll, and see your progress as you complete lessons.</p><a href="${user ? dashboard() : '/register'}" data-link>Start learning</a></article>
          <article class="feature coral"><span class="feature-icon" aria-hidden="true">✎</span><h3>For teachers</h3><p>Draft a course, add lessons, and publish when you’re ready. See who has enrolled.</p><a href="${user ? dashboard() : '/register?teacher=1'}" data-link>Start teaching</a></article>
          <article class="feature teal"><span class="feature-icon" aria-hidden="true">▤</span><h3>For administrators</h3><p>Review teacher requests, manage account access, and oversee courses.</p><a href="${user ? dashboard() : '/login'}" data-link>Sign in to manage</a></article>
        </div>
      </section>
      <section class="section-wrap faq"><header class="section-head"><h2>Getting started</h2></header><div class="faq-list">
        <details><summary>How do I join a course?</summary><p>Sign in as a student, open a published course under Explore courses, and choose Enroll.</p></details>
        <details><summary>How do I become a teacher?</summary><p>Request a teacher account when you register. An administrator reviews the request before you can publish courses.</p></details>
        <details><summary>Where do I see my progress?</summary><p>Open an enrolled course and mark lessons complete. Your course card updates as you go.</p></details>
      </div></section>
    </div>`;
  }

  function courseCard(course, index) {
    const status = { draft: 'Draft', published: 'Published', suspended: 'Suspended', archived: 'Archived',
      in_progress: 'Available', up_next: 'Available', saved: 'Available' }[course.status] || 'Course';
    const progress = Math.max(0, Math.min(100, Number(course.progress) || 0));
    return `<article class="course-card" data-course-card data-enrolled="${course.enrolled ? 'yes' : 'no'}">
      <div class="course-cover shade-${index % 3}"><span class="course-glyph" aria-hidden="true">✦</span><span class="status">${course.enrolled ? 'Enrolled' : status}</span></div>
      <div class="course-body"><h3>${escape(course.title)}</h3>
        <p class="course-meta">${escape(course.teacher)} · ${escape(course.lessonCount)} ${Number(course.lessonCount) === 1 ? 'lesson' : 'lessons'}</p>
        ${course.enrolled ? `<div class="progress-label"><span>Progress</span><strong>${progress}%</strong></div><progress max="100" value="${progress}" aria-label="Course completion"></progress>` : ''}
        <button class="secondary" data-course="${escape(course.id)}">${course.enrolled ? 'Continue learning' : 'View course'}</button>
      </div></article>`;
  }

  function adminAccounts(accounts) {
    return `<section id="users" class="dashboard-section" tabindex="-1">
      <header class="section-head"><h2>User management</h2><p>Review requests and manage account access.</p></header>
      <ul class="records">${accounts.users.map(account => `<li><div class="record-person">
        <span class="avatar" aria-hidden="true">${escape((account.name || '?').charAt(0).toUpperCase())}</span>
        <div><strong>${escape(account.name)}</strong><small>${escape(account.email)}</small></div></div>
        <div class="record-right"><span class="role-pill">${escape(account.role)}${account.pending ? ' · Awaiting approval' : ''}${account.suspended ? ' · Suspended' : ''}</span>
        ${account.pending ? form('users/approve', `<input type="hidden" name="email" value="${escape(account.email)}">`, 'Approve') : ''}
        ${account.role !== 'admin' ? form('users/suspension', `<input type="hidden" name="email" value="${escape(account.email)}">
          <input type="hidden" name="suspended" value="${!account.suspended}">`, account.suspended ? 'Reactivate' : 'Suspend') : ''}</div>
      </li>`).join('')}</ul>
    </section>`;
  }

  async function render() {
    const current = ++revision;
    const path = location.pathname;
    const dark = document.documentElement.classList.contains('dark');
    nav.innerHTML = `<button class="theme-toggle" data-theme aria-label="Toggle color theme" aria-pressed="${dark}" title="Toggle color theme">${dark ? '☀' : '☾'}</button>` + (user
      ? `<a class="nav-link" href="${dashboard()}" data-link>Dashboard</a><button class="secondary sign-out" data-logout>Sign out</button>`
      : '<a class="nav-link" href="/login" data-link>Sign in</a><a class="primary nav-register" href="/register" data-link>Get started</a>');
    if (path === '/') {
      main.innerHTML = homepage();
      return;
    }
    if (path === '/login' || path === '/register') {
      if (user) return go(dashboard(), true);
      const register = path === '/register';
      const fields = `${register ? '<label>Name<input name="name" autocomplete="name" maxlength="160" required></label>' : ''}
        <label>Email<input name="email" type="email" autocomplete="username" required></label>
        <div class="password-field">
          <label for="auth-password">Password</label>
          <div class="password-row">
            <input id="auth-password" name="password" type="password" autocomplete="${register ? 'new-password' : 'current-password'}" ${register ? 'minlength="12"' : ''} maxlength="128" required>
            <button type="button" data-password-toggle aria-controls="auth-password">Show password</button>
          </div>
        </div>
        ${register ? `<label class="checkbox"><input name="teacher" type="checkbox" ${new URLSearchParams(location.search).get('teacher') === '1' ? 'checked' : ''}> Request a teacher account</label>` : ''}`;
      main.innerHTML = `<section class="auth-layout enter">
        <div class="auth panel"><p class="eyebrow">SMARTLEARNINGSPACE</p><h1>${register ? 'Create an account' : 'Sign in'}</h1>
          <p class="muted">${register ? 'Join your learning workspace or request teacher access.' : 'Access your courses and pick up where you left off.'}</p>
          ${form(register ? 'register' : 'login', fields, register ? 'Register' : 'Sign in')}
          <div class="auth-links">${register ? '<a href="/login" data-link>Already registered? Sign in</a>' : '<a href="/register" data-link>Create an account</a>'}</div>
        </div>
        <figure class="auth-art"><img src="/assets/teaching-studio.webp" alt="An educator preparing a lesson at her desk" width="1200" height="800">
          <figcaption>Your Space for<br>Smarter Learning.</figcaption></figure>
      </section>`;
      return;
    }
    if (!user) return go('/login', true);
    if (path !== dashboard()) return go(dashboard(), true);
    main.innerHTML = '<p class="loading" role="status">Loading your workspace…</p>';
    try {
      const [summary, catalog, accounts] = await Promise.all([api('dashboard'), api('courses'),
        user.role === 'admin' ? api('users') : null]);
      if (current !== revision) return;
      const cards = catalog.courses.map(courseCard).join('');
      const role = user.role;
      const copy = workspaceCopy[role];
      const courseHeading = role === 'student' ? 'Explore courses' : role === 'teacher' ? 'My courses' : 'Course oversight';
      const empty = role === 'teacher' ? 'Create your first course to start adding lessons.' : 'Published courses will appear here.';
      main.innerHTML = `<section class="workspace ${role} enter">
        <aside class="workspace-nav">
          <div class="workspace-identity"><span class="avatar" aria-hidden="true">${escape((user.name || '?').charAt(0).toUpperCase())}</span><div><strong>${escape(user.name)}</strong><small>${labels[role]}</small></div></div>
          <nav aria-label="Workspace sections"><button type="button" data-jump="overview">Overview</button>
            ${accounts ? '<button type="button" data-jump="users">User management</button>' : ''}
            <button type="button" data-jump="courses">${courseHeading}</button>
            ${role === 'teacher' ? '<button type="button" data-jump="create">Create course</button>' : ''}
          </nav>
        </aside>
        <div class="workspace-main">
          <header id="overview" tabindex="-1" class="workspace-banner">
            <div><p class="eyebrow">${labels[role]}</p><h1>Welcome, ${escape(user.name)}</h1>
            <p>${copy.description}</p><button type="button" class="banner-action" data-jump="${copy.target}">${copy.action}</button></div>
            <img src="/assets/${role === 'teacher' ? 'teaching' : 'learning'}-studio.webp" alt="" width="432" height="288">
          </header>
          <div class="stat-grid">${Object.entries(summary.stats).map(([key, value]) =>
            `<article><span>${escape(key)}</span><strong>${escape(value)}</strong></article>`).join('')}</div>
          ${accounts ? adminAccounts(accounts) : ''}
          <section id="courses" class="dashboard-section" tabindex="-1">
            <header class="section-head"><h2>${courseHeading}</h2></header>
            ${role === 'teacher' ? `<details id="create" class="panel course-create" tabindex="-1"><summary>Create course</summary>${form('courses',
              '<label>Course title<input name="title" maxlength="160" required></label>', 'Save draft')}</details>` : ''}
            ${cards ? `<div class="course-toolbar"><label>Search courses<input type="search" data-course-search placeholder="Search by course or teacher"></label>
              ${role === 'student' ? '<label>Show<select data-course-filter><option value="all">All courses</option><option value="yes">My enrollments</option><option value="no">Available to join</option></select></label>' : ''}</div>
              <div class="course-grid">${cards}</div><p class="empty muted" data-no-matches hidden>No courses match your search.</p>`
              : `<div class="empty"><span class="empty-icon" aria-hidden="true">✦</span><strong>No courses yet</strong><p>${empty}</p></div>`}
          </section>
          <section id="course-detail" tabindex="-1" aria-label="Course details"></section>
        </div>
      </section>`;
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
    const request = ++courseRevision;
    const detail = document.querySelector('#course-detail');
    if (!detail) return;
    detail.innerHTML = '<p class="loading" role="status">Loading course…</p>';
    try {
      const { course, lessons, students, completed } = await api(`courses/${id}`);
      if (current !== revision || request !== courseRevision || !detail.isConnected) return;
      const route = `courses/${id}`;
      const manage = user.role === 'teacher' && course.status !== 'suspended';
      detail.innerHTML = `<article class="panel course-detail enter"><header class="section-head"><p class="eyebrow">COURSE DETAILS</p><h2>${escape(course.title)}</h2><p>${escape(course.teacher)} · ${escape(course.lessonCount)} lessons</p></header>
        ${manage && course.status === 'draft' ? form(`${route}/publish`, '', 'Publish course') : ''}
        ${manage ? form(`${route}/edit`, `<label>Course title<input name="title" maxlength="160" value="${escape(course.title)}" required></label>`, 'Save title') : ''}
        ${user.role === 'admin' && ['published', 'in_progress', 'up_next', 'saved'].includes(course.status) ?
          form(`${route}/suspend`, '', 'Suspend course') : ''}
        ${manage ? form(`${route}/lessons`, '<label>Lesson title<input name="title" required></label><label>Lesson text<textarea name="text" required></textarea></label>', 'Add lesson') : ''}
        ${user.role === 'student' && !course.enrolled ? form(`${route}/enroll`, '', 'Enroll') : ''}
        ${students ? `<p>Enrolled students: ${students.map(student => escape(student.name)).join(', ') || 'None yet'}</p>` : ''}
        ${lessons.map((lesson, index) => `<section class="lesson"><p class="eyebrow">Lesson ${index + 1}</p><h3>${escape(lesson.title)}</h3><p>${escape(lesson.text)}</p>
          ${course.enrolled ? completed.includes(lesson.id) ? '<p class="completed">✓ Completed</p>' :
            form(`${route}/progress`, `<input type="hidden" name="lessonId" value="${escape(lesson.id)}">`, 'Mark complete') : ''}</section>`).join('')}
        ${user.role === 'student' && !course.enrolled ? '<p class="muted">Enroll to open the course lessons and track your progress.</p>' : ''}
        </article>`;
      detail.focus();
    } catch (error) {
      if (current === revision && request === courseRevision) detail.textContent = error.message;
    }
  }

  document.addEventListener('click', async event => {
    const control = event.target.closest('[data-link],[data-theme],[data-logout],[data-course],[data-retry],[data-password-toggle],[data-jump]');
    if (!control) return;
    if (control.hasAttribute('data-link')) {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      go(control.getAttribute('href'));
    } else if (control.hasAttribute('data-password-toggle')) {
      const password = control.form.elements.password;
      const visible = password.type === 'password';
      password.type = visible ? 'text' : 'password';
      control.textContent = visible ? 'Hide password' : 'Show password';
    } else if (control.hasAttribute('data-jump')) {
      const target = document.getElementById(control.dataset.jump);
      if (!target) return;
      if (target.tagName === 'DETAILS') target.open = true;
      target.focus({ preventScroll: true });
      target.scrollIntoView({ block: 'start' });
    } else if (control.hasAttribute('data-theme')) {
      const dark = document.documentElement.classList.toggle('dark');
      localStorage.setItem('sls-theme', dark ? 'dark' : 'light');
      control.textContent = dark ? '☀' : '☾';
      control.setAttribute('aria-pressed', String(dark));
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

  function filterCourses() {
    const search = (main.querySelector('[data-course-search]')?.value || '').trim().toLowerCase();
    const enrollment = main.querySelector('[data-course-filter]')?.value || 'all';
    let matches = 0;
    for (const card of main.querySelectorAll('[data-course-card]')) {
      const text = card.querySelector('h3').textContent + ' ' + card.querySelector('.course-meta').textContent;
      const visible = text.toLowerCase().includes(search) && (enrollment === 'all' || card.dataset.enrolled === enrollment);
      card.hidden = !visible;
      if (visible) matches++;
    }
    main.querySelector('[data-no-matches]').hidden = matches > 0;
  }
  main.addEventListener('input', event => {
    if (event.target.matches('[data-course-search]')) filterCourses();
  });
  main.addEventListener('change', event => {
    if (event.target.matches('[data-course-filter]')) filterCourses();
  });

  document.addEventListener('submit', async event => {
    const element = event.target;
    if (!element.dataset.submit) return;
    event.preventDefault();
    const button = element.querySelector('button[type="submit"]');
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
        const password = element.elements.password;
        password.type = 'password';
        element.querySelector('[data-password-toggle]').textContent = 'Show password';
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
