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

function notify(data, email, title, destination) {
  (data.notifications ||= []).unshift({ id: randomUUID(), email, title, destination,
    created_at: new Date().toISOString(), read_at: null });
}

function communications(data, user, action, body) {
  const admin = user.role === 'admin';
  const items = data.platformFeedback || [];
  if (action === 'list' || action === 'inbox') {
    const notices = (data.notifications || []).filter(n => n.email === user.email);
    return {
      unread: notices.filter(n => !n.read_at).length,
      notifications: notices.sort((a, b) => Boolean(a.read_at) - Boolean(b.read_at)).slice(0, 50)
        .map(({ email, ...notice }) => notice),
      feedback: action === 'inbox' ? [] : items.filter(item => admin || item.sender === user.email)
        .sort((a, b) => Number(a.status === 'resolved') - Number(b.status === 'resolved') || b.updated_at.localeCompare(a.updated_at))
        .map(({ sender, ...item }) => item),
    };
  }
  const now = new Date().toISOString();
  if (action === 'read' || action === 'read_all') {
    const onlyOne = action === 'read';
    const notices = (data.notifications || []).filter(n => n.email === user.email && (!onlyOne || n.id === body.notificationId));
    if (onlyOne && !notices.length) fail(404, 'Notification not found.');
    for (const notice of notices) notice.read_at ||= now;
    return { ok: true };
  }
  if (action === 'submit') {
    if (admin) fail(403, 'Teacher or student access required.');
    if (!['issue', 'suggestion', 'general'].includes(body.topic)) fail(400, 'Choose a feedback topic.');
    const item = { id: randomUUID(), sender: user.email, senderName: user.name, senderRole: user.role,
      topic: body.topic, subject: required(body.subject, 'Subject', 120), message: required(body.message, 'Message', 2000),
      status: 'new', response: '', created_at: now, updated_at: now };
    (data.platformFeedback ||= []).unshift(item);
    for (const account of data.users.filter(a => a.role === 'admin' && !a.suspended && !a.pending))
      notify(data, account.email, 'New platform feedback: ' + item.subject, '/admin/dashboard#feedback-' + item.id);
    return { id: item.id };
  }
  if (!admin) fail(403, 'Administrator access required.');
  if (!['new', 'reviewing', 'resolved'].includes(body.status)) fail(400, 'Choose a feedback status.');
  const response = optional(body.response, 'Response', 2000);
  const item = items.find(entry => entry.id === body.feedbackId);
  if (!item) fail(404, 'Feedback not found.');
  if (item.status !== body.status || item.response !== response) {
    Object.assign(item, { status: body.status, response, updated_at: now });
    (data.audit ||= []).push({ action: 'feedback.reviewed', actor: user.email, target: item.id, at: now });
    notify(data, item.sender, 'Feedback updated: ' + item.subject, '/' + item.senderRole + '/dashboard#feedback-' + item.id);
  }
  return { id: item.id };
}

function modulePage(data, course, user, action, body, { admin, owner, learner, active }) {
  const threads = course.conversations || [];
  const visible = thread => admin || owner || (learner && thread.student === user.email);
  if (action === 'module_page') {
    return {
      outline: (course.content || []).map(({ id, title, description }) => ({ id, title, description })),
      assets: [],
      conversations: threads.filter(visible).map(({ id, kind, subject, studentName, closed, messages }) =>
        ({ id, kind, subject, student: studentName, closed, messages })),
    };
  }
  if (!active && !(admin && action === 'message_status')) fail(409, 'This module is closed to new messages.');
  if (action === 'message_create') {
    if (!learner) fail(403, 'Enroll in this module to contact your teacher.');
    if (!['question', 'feedback'].includes(body.kind)) fail(400, 'Choose a message type.');
    const subject = required(body.subject, 'Subject');
    const message = { author: user.name, role: user.role, text: required(body.text, 'Message', 2000) };
    const id = randomUUID();
    (course.conversations ||= []).unshift({ id, kind: body.kind, subject, student: user.email,
      studentName: user.name, closed: false, messages: [message] });
    notify(data, course.owner, 'Student message: ' + subject, '/modules/' + course.id + '#thread-' + id);
    return { id };
  }
  const thread = threads.find(item => item.id === body.threadId && visible(item));
  if (!thread) fail(404, 'Conversation not found.');
  if (action === 'message_status') {
    if (!admin) fail(403, 'Administrator access required.');
    if (typeof body.closed !== 'boolean') fail(400, 'Choose whether to close or reopen the conversation.');
    if (thread.closed !== body.closed) {
      thread.closed = body.closed;
      (data.audit ||= []).push({ action: thread.closed ? 'conversation.closed' : 'conversation.reopened',
        actor: user.email, target: thread.id, at: new Date().toISOString() });
    }
    return { ok: true };
  }
  if (thread.closed) fail(409, 'This conversation is closed.');
  thread.messages.push({ author: user.name, role: user.role, text: required(body.text, 'Reply', 2000) });
  const fromStudent = user.email === thread.student;
  notify(data, fromStudent ? course.owner : thread.student,
    (fromStudent ? 'Student message: ' : 'Reply in your module: ') + thread.subject, '/modules/' + course.id + '#thread-' + thread.id);
  return { id: thread.id };
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
  const communication = /^\/api\/communications(?:\/(inbox|submit|review|read|read_all))?$/.exec(route);
  if (communication && (!communication[1] || communication[1] === 'inbox' ? method === 'GET' : method === 'POST'))
    return result(communications(data, user, communication[1] || 'list', body));
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
      const course = { id: randomUUID(), title: required(body.title, 'Title'), status: 'published',
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
    notify(data, account.email, 'Your teacher account was approved.', '/teacher/dashboard');
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
  const match = /^\/api\/courses\/([\w-]+)(?:\/(enroll|publish|lessons|progress|edit|suspend|moderation|archive|restore|module_page|message_create|message_reply|message_status))?$/.exec(route);
  if (!match) fail(404, 'Route not found.');
  const action = match[2];
  if (['moderation', 'archive', 'restore'].includes(action) && !admin) fail(403, 'Administrator access required.');
  const course = data.courses.find(item => item.id === match[1] && visible(item));
  if (!course) fail(404, 'Course not found.');
  const pageRead = action === 'module_page' && method === 'GET';
  const messageWrite = ['message_create', 'message_reply', 'message_status'].includes(action) && method === 'POST';
  if (pageRead || messageWrite) return result(modulePage(data, course, user, action, body, {
    admin, owner: owns(course), learner: student && enrolled(course), active: published(course),
  }));
  if (method === 'GET' && action === 'moderation') return result({ assets: [] });
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
    course.previousStatus = course.status;
    course.status = 'suspended';
    addRevision(course);
    (data.audit ||= []).push({ action: 'course.suspended', actor: user.email, target: course.id, at: new Date().toISOString() });
  } else if (action === 'archive' || action === 'restore') {
    const archiving = action === 'archive';
    if (archiving === (course.status !== 'suspended')) {
      if (archiving) {
        course.previousStatus = course.status;
        course.status = 'suspended';
      } else {
        course.status = course.previousStatus || 'published';
        delete course.previousStatus;
      }
      addRevision(course);
      (data.audit ||= []).push({ action: archiving ? 'course.archived' : 'course.restored',
        actor: user.email, target: course.id, at: new Date().toISOString() });
    }
  } else if (action === 'lessons' && owns(course) && course.status !== 'suspended') {
    (course.content ||= []).push({ id: randomUUID(), title: required(body.title, 'Lesson title'),
      text: optional(body.text, 'Lesson notes', 12000), description: optional(body.description, 'Lesson description', 1000) });
  } else if (action === 'progress' && student && enrolled(course)) {
    if (!course.content?.some(lesson => lesson.id === body.lessonId)) fail(404, 'Lesson not found.');
    const completed = ((course.progressByStudent ||= {})[user.email] ||= []);
    if (!completed.includes(body.lessonId)) completed.push(body.lessonId);
  } else {
    fail(403, 'This action is unavailable for your account or course.');
  }
  return result({ course: summarize(course) });
}

module.exports = { workspace, required, fail, notify };
