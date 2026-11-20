const { fail, required } = require('./workspace');

function createSupabaseApi({ url, key }) {
  if (!url || !key || new URL(url).protocol !== 'https:') {
    throw new Error('Set SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY.');
  }
  if (!key.startsWith('sb_publishable_')) throw new Error('Use a Supabase publishable key.');
  async function call(path, { token, body, method } = {}) {
    let response;
    try {
      response = await fetch(new URL(path, url), {
        method: method || (body === undefined ? 'GET' : 'POST'),
        headers: { apikey: key, ...(token && { Authorization: 'Bearer ' + token }),
          ...(body !== undefined && { 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      fail(503, 'Supabase is temporarily unavailable.');
    }
    if (response.status === 204) return {};
    const data = await response.json().catch(() => ({}));
    if (response.ok) return data;
    if (response.status === 429) fail(429, 'Please wait before trying again.');
    if (response.status >= 500) fail(503, 'Supabase could not complete the request.');
    const status = data.code === '42501' ? 403 : Number(data.code?.match?.(/^PT(\d{3})$/)?.[1]) || response.status;
    if (path.includes('grant_type=password')) fail(status === 400 ? 401 : status, 'Invalid email or password, or email confirmation is required.');
    fail(status, path.startsWith('/rest/') ? (status === 400 ? 'Check the submitted values.' : data.message || 'Request denied.')
      : data.msg || data.message || 'Authentication request failed.');
  }
  const rpc = (token, action, payload = {}) =>
    call('/rest/v1/rpc/sls_workspace', { token, body: { action, payload } });

  return async function dispatch(req, route, body) {
    const token = /^Bearer (\S{1,8192})$/.exec(req.headers.authorization || '')?.[1];
    const post = req.method === 'POST';
    if (post && ['/api/login', '/api/register'].includes(route)) {
      const email = required(body.email, 'Email', 254).toLowerCase();
      const password = typeof body.password === 'string' ? body.password : '';
      if (!password || password.length > 128) fail(400, 'Enter a valid password.');
      if (route === '/api/register') {
        if (password.length < 12) fail(400, 'Use at least 12 characters.');
        const name = required(body.name, 'Name');
        await call('/auth/v1/signup', { body: { email, password, data: { name, teacher: body.teacher === true } } });
        return { status: 201, value: { checkEmail: true, pending: body.teacher === true } };
      }
      const auth = await call('/auth/v1/token?grant_type=password', { body: { email, password } });
      const { user } = await rpc(auth.access_token, 'me');
      return { status: 200, value: { user, token: auth.access_token } };
    }
    if (!token) fail(401, 'Sign in to continue.');
    if (post && route === '/api/logout') {
      await call('/auth/v1/logout?scope=local', { token, method: 'POST' });
      return { status: 200, value: { ok: true } };
    }

    const reads = { '/api/me': 'me', '/api/dashboard': 'dashboard', '/api/courses': 'courses', '/api/users': 'users' };
    const writes = { '/api/courses': 'create', '/api/users/approve': 'approve', '/api/users/suspension': 'suspension' };
    const action = req.method === 'GET' ? reads[route] : post ? writes[route] : null;
    if (action) {
      if (action === 'create') required(body.title, 'Title');
      return { status: action === 'create' ? 201 : 200, value: await rpc(token, action, post ? body : {}) };
    }
    const course = /^\/api\/courses\/([\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12})(?:\/(enroll|publish|lessons|progress|edit|suspend))?$/.exec(route);
    if (course && ((req.method === 'GET' && !course[2]) || (post && course[2]))) {
      return { status: 200, value: await rpc(token, course[2] || 'course', { ...body, courseId: course[1] }) };
    }
    fail(404, 'Route not found.');
  };
}

module.exports = { createSupabaseApi };
