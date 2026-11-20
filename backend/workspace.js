const { randomUUID } = require('node:crypto');

function fail(status, message) {
  throw Object.assign(new Error(message), { status });
}

function required(value, label, max = 160) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max)
    fail(400, `${label} must contain 1–${max} characters.`);
  return value.trim();
}

function optional(value, label, max, fallback = '') {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || value.trim().length > max)
    fail(400, `${label} may contain at most ${max} characters.`);
  return value.trim();
}

function workspace(data, user, method, route, body) {
  const admin = user.role === 'admin';
  const teacher = user.role === 'teacher';
  const student = user.role === 'student';
  const enrolled = course => (course.students || []).includes(user.email);
  const owns = course => teacher && course.owner === user.email;
  const published = course => ['published', 'in_progress', 'up_next', 'saved'].includes(course.status);
  const visible = course => admin || owns(course) || (student && published(course));
  const summarize = course => ({
    id: course.id, title: course.title, teacher: course.teacher, status: course.status,
    description: course.description || '', subject: course.subject || '',
    enrolled: student && enrolled(course),
    lessonCount: (course.content || []).length,
    progress: student && enrolled(course) && course.content?.length
      ? Math.round((course.progressByStudent?.[user.email]?.length || 0) / course.content.length * 100) : 0,
  });
  const result = (value, status = 200) => ({ value, status, changed: method !== 'GET' });
  const addRevision = course => {
    const { title, subject, description, status } = course;
    (course.history ||= []).unshift({ snapshot: { title, subject, description, status }, recorded_at: new Date().toISOString() });
  };
  if (method === 'GET' && route === '/api/me') return result({ user });
  if (method === 'GET' && route === '/api/dashboard') {
    const courses = data.courses.filter(visible);
    const stats = admin ? { Accounts: data.users.length, Courses: courses.length,
      'Pending teachers': data.users.filter(account => account.pending).length,
      Enrollments: courses.reduce((sum, course) => sum + (course.students?.length || 0), 0) }
      : teacher ? { 'My courses': courses.length, Published: courses.filter(published).length,
        Enrollments: courses.reduce((sum, course) => sum + (course.students?.length || 0), 0) }
      : { 'Available courses': courses.length, 'My enrollments': courses.filter(enrolled).length,
        'Completed lessons': courses.filter(enrolled).reduce((sum, course) => sum + (course.progressByStudent?.[user.email]?.length || 0), 0) };
    return result({ user, stats });
  }
  if (route === '/api/courses') {
    if (method === 'GET') return result({ courses: data.courses.filter(visible).map(summarize) });
    if (method === 'POST') {
      if (!teacher) fail(403, 'Teacher access required.');
      const course = { id: randomUUID(), title: required(body.title, 'Title'), status: 'draft',
        description: optional(body.description, 'Description', 2000), subject: optional(body.subject, 'Subject', 100),
        teacher: user.name, owner: user.email, content: [], students: [] };
      addRevision(course);
      data.courses.push(course);
      return result({ course: summarize(course) }, 201);
    }
  }
  if (method === 'GET' && route === '/api/users') {
    if (!admin) fail(403, 'Administrator access required.');
    return result({ users: data.users.map(({ email, name, role, pending, suspended }) =>
      ({ email, name, role, pending: Boolean(pending), suspended: Boolean(suspended) })) });
  }
  if (method === 'POST' && route === '/api/users/approve') {
    if (!admin) fail(403, 'Administrator access required.');
    const account = data.users.find(item => item.email === body.email && item.role === 'teacher' && item.pending);
    if (!account) fail(404, 'Pending teacher application not found.');
    account.pending = false;
    (data.audit ||= []).push({ action: 'teacher.approved', actor: user.email, target: account.email, at: new Date().toISOString() });
    return result({ approved: true });
  }
  if (method === 'POST' && route === '/api/users/suspension') {
    if (!admin) fail(403, 'Administrator access required.');
    const account = data.users.find(item => item.email === body.email && item.role !== 'admin');
    if (!account) fail(404, 'Account not found.');
    if (typeof body.suspended !== 'boolean') fail(400, 'Choose a suspension state.');
    account.suspended = body.suspended;
    (data.audit ||= []).push({ action: account.suspended ? 'account.suspended' : 'account.reactivated',
      actor: user.email, target: account.email, at: new Date().toISOString() });
    return result({ suspended: account.suspended });
  }
  const match = /^\/api\/courses\/([\w-]+)(?:\/(enroll|publish|lessons|progress|edit|suspend))?$/.exec(route);
  if (!match) fail(404, 'Route not found.');
  const course = data.courses.find(item => item.id === match[1] && visible(item));
  if (!course) fail(404, 'Course not found.');
  const action = match[2];
  if (method === 'GET' && !action) {
    return result({ course: summarize(course), lessons: owns(course) || admin || enrolled(course) ? course.content || [] : [],
      students: owns(course) ? data.users.filter(enrolledUser => (course.students || []).includes(enrolledUser.email))
        .map(({ name }) => ({ name })) : undefined,
      history: owns(course) ? (course.history || []).slice(0, 15) : [],
      learnerProgress: owns(course) ? data.users.filter(learner => (course.students || []).includes(learner.email))
        .map(learner => ({ name: learner.name, completed: course.progressByStudent?.[learner.email]?.length || 0 })) : [],
      completed: student && enrolled(course) ? course.progressByStudent?.[user.email] || [] : [] });
  }
  if (method !== 'POST') fail(405, 'Method not allowed.');
  if (action === 'enroll' && student && published(course)) {
    if (!enrolled(course)) (course.students ||= []).push(user.email);
  } else if (action === 'publish' && owns(course) && course.status === 'draft') {
    if (!course.content?.length) fail(409, 'Add a lesson before publishing.');
    course.status = 'published';
    addRevision(course);
  } else if (action === 'edit' && owns(course) && course.status !== 'suspended') {
    course.title = required(body.title, 'Title');
    course.description = optional(body.description, 'Description', 2000, course.description);
    course.subject = optional(body.subject, 'Subject', 100, course.subject);
    addRevision(course);
  } else if (action === 'suspend' && admin && published(course)) {
    course.status = 'suspended';
    addRevision(course);
    (data.audit ||= []).push({ action: 'course.suspended', actor: user.email, target: course.id, at: new Date().toISOString() });
  } else if (action === 'lessons' && owns(course) && course.status !== 'suspended') {
    (course.content ||= []).push({ id: randomUUID(), title: required(body.title, 'Lesson title'),
      text: required(body.text, 'Lesson text', 12000), description: optional(body.description, 'Lesson description', 1000) });
  } else if (action === 'progress' && student && enrolled(course)) {
    if (!course.content?.some(lesson => lesson.id === body.lessonId)) fail(404, 'Lesson not found.');
    const completed = ((course.progressByStudent ||= {})[user.email] ||= []);
    if (!completed.includes(body.lessonId)) completed.push(body.lessonId);
  } else {
    fail(403, 'This action is unavailable for your account or course.');
  }
  return result({ course: summarize(course) });
}

module.exports = { workspace, required, fail };
