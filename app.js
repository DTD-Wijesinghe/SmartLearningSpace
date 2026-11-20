'use strict';

(function boot() {
  const main = document.querySelector('#main');
  const nav = document.querySelector('#account-nav');
  let token = sessionStorage.getItem('sls-session');
  let user;
  let revision = 0;
  let courseRevision = 0;
  let capabilities = {};
  let liveRoom;
  let livePanel;
  let liveKitReady;
  let classRecorder;
  let savedRecording;
  const liveId = value => /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(value || '');
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const dashboard = () => `/${user.role}/dashboard`;
  const labels = { admin: 'Platform administration', teacher: 'Teaching studio', student: 'Learning workspace' };
  const workspaceCopy = {
    admin: { description: 'Manage accounts, modules, and lesson materials.', action: 'User management', target: 'users' },
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
    if (classRecorder) {
      if (livePanel) livePanel.querySelector('.provider-status').textContent = 'Stop and save the recording before leaving.';
      return;
    }
    liveRoom?.disconnect();
    history[replace ? 'replaceState' : 'pushState']({}, '', path);
    void render();
    window.scrollTo({ top: 0 });
  }

  function clearSession() {
    if (savedRecording) URL.revokeObjectURL(savedRecording.url);
    savedRecording = undefined;
    token = null;
    user = null;
    sessionStorage.removeItem('sls-session');
  }

  function form(action, fields, caption, confirmation = '') {
    const confirmAttribute = confirmation ? ` data-confirm="${escape(confirmation)}"` : '';
    return `<form data-submit="${action}"${confirmAttribute}>${fields}<button class="primary" type="submit">${caption}</button><p class="error" role="status"></p></form>`;
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
    const status = { draft: 'Draft', published: 'Published', suspended: 'Archived', archived: 'Archived',
      in_progress: 'Available', up_next: 'Available', saved: 'Available' }[course.status] || 'Course';
    const progress = Math.max(0, Math.min(100, Number(course.progress) || 0));
    return `<article class="course-card" data-course-card data-enrolled="${course.enrolled ? 'yes' : 'no'}">
      <div class="course-cover shade-${index % 3}"><span class="course-glyph" aria-hidden="true">✦</span><span class="status">${course.enrolled ? 'Enrolled' : status}</span></div>
      <div class="course-body"><h3>${escape(course.title)}</h3>
        ${course.subject ? `<p class="eyebrow">${escape(course.subject)}</p>` : ''}
        <p class="course-meta">${escape(course.teacher)} · ${escape(course.lessonCount)} ${Number(course.lessonCount) === 1 ? 'lesson' : 'lessons'}</p>
        ${course.description ? `<p class="course-description">${escape(course.description)}</p>` : ''}
        ${course.enrolled ? `<div class="progress-label"><span>Progress</span><strong>${progress}%</strong></div><progress max="100" value="${progress}" aria-label="Course completion"></progress>` : ''}
        <a class="secondary module-link" data-link href="/modules/${encodeURIComponent(course.id)}">${course.enrolled ? 'Continue learning' : 'Open module'}</a>
      </div></article>`;
  }

  function moduleFields(course = {}) {
    return `<label>Course title<input name="title" maxlength="160" value="${escape(course.title)}" required></label>
      <label>Subject<input name="subject" maxlength="100" value="${escape(course.subject)}"></label>
      <label>Course description<textarea name="description" maxlength="2000">${escape(course.description)}</textarea></label>`;
  }

  function examQuestion(index) {
    return `<fieldset class="exam-question" data-question><legend>Question ${index + 1}</legend>
      <label>Question text<input name="prompt" maxlength="500" required></label>
      ${Array.from({ length: 4 }, (_, option) => `<label>Choice ${option + 1}<input name="option" maxlength="200" required></label>`).join('')}
      <label>Correct choice<select name="correct">${[1, 2, 3, 4].map((value, i) => `<option value="${i}">Choice ${value}</option>`).join('')}</select></label></fieldset>`;
  }

  function examsView(exams, route, manage, enrolled) {
    if (!manage && !enrolled) return '';
    const list = exams.map(exam => `<details class="panel exam"><summary>${escape(exam.title)} · ${exam.questions.length} questions</summary>
      ${manage ? exam.submissions.map(submission => `<article class="submission"><h3>${escape(submission.name)}</h3>
        <ol>${exam.questions.map((q, i) => `<li><strong>${escape(q.prompt)}</strong><p>${escape(q.options[submission.answers[i]])}</p></li>`).join('')}</ol>
        ${submission.released ? `<p class="completed">Released · ${submission.score}/${submission.total}</p>` : form(route + '/exam_release',
          `<input type="hidden" name="examId" value="${escape(exam.id)}"><input type="hidden" name="studentId" value="${escape(submission.student)}">
          <label>Score out of ${submission.total}<input name="score" type="number" min="0" max="${submission.total}" value="${submission.score}" required></label>
          <label>Feedback<textarea name="feedback" maxlength="2000"></textarea></label>
          ${capabilities.ai ? `<button type="button" data-provider-action="${route}/ai_feedback">Draft feedback with AI</button><p class="provider-status" role="status"></p>` : ''}`, 'Release result')}
      </article>`).join('') || '<p>No submissions yet.</p>' : exam.result
      ? `<p class="completed">Result · ${exam.result.score}/${exam.result.total}</p><p>${escape(exam.result.feedback)}</p>`
      : exam.submitted ? '<p>Submitted. Your result will appear here when the teacher releases it.</p>'
      : form(route + '/exam_submit', `<input type="hidden" name="examId" value="${escape(exam.id)}">` +
        exam.questions.map((q, i) => `<fieldset class="exam-question"><legend>${i + 1}. ${escape(q.prompt)}</legend>
          ${q.options.map((option, j) => `<label class="checkbox"><input type="radio" name="answer-${i}" value="${j}" required>${escape(option)}</label>`).join('')}</fieldset>`).join(''), 'Submit answers')}
      </details>`).join('');
    return `<section class="module-section"><h2>Exams and results</h2>${manage ? `<details class="panel exam"><summary>Create MCQ exam</summary>
        ${form(route + '/exam_create', `<label>Exam title<input name="title" maxlength="160" required></label>
          <div data-question-list>${examQuestion(0)}</div><button type="button" data-add-question>Add question</button>`, 'Publish exam')}</details>` : ''}
      ${list || '<p class="muted">No exams have been published for this module.</p>'}</section>`;
  }

  const helpAnswers = [
    [/enrol|join/i, 'Open a published course module from Explore courses and select Enroll. Your lessons and available exams will then appear on that page.'],
    [/exam|quiz|mark|result/i, 'Open your enrolled module and expand an exam under Exams and results. After you submit, return there when your teacher releases the result.'],
    [/lesson|progress|improve/i, 'Open your module, work through the lessons, and select Mark complete. Return to incomplete lessons and use any feedback your teacher has released.'],
    [/password|sign in|login/i, 'Use the shared sign-in page with your registered email. The Show password button reveals what you typed.'],
    [/teacher|publish|course/i, 'Approved teachers can create a course in Teaching Studio, add lessons in its module, and publish it from that page.'],
  ];

  function helpDesk() {
    return `<details class="panel help-desk"><summary>Learning help</summary><p>Ask how to enroll, find results, or complete a lesson. ${capabilities.ai ? 'The assistant uses the site’s help guide.' : 'Answers come from the built-in help guide.'}</p>
      <form data-help-form><label>Your question<input name="question" maxlength="300" required></label><button type="submit">Ask</button><p role="status"></p></form></details>`;
  }

  function lessonMaterials(assets, route, lesson, manage, admin, storageEnabled) {
    const kinds = [
      { video: true, title: 'Videos', accept: '.mp4,.webm', hint: 'MP4 or WebM, up to 2 GiB and four hours.' },
      { video: false, title: 'Documents and notes', accept: '.pdf,.txt,.docx,.pptx,.xlsx,.png,.jpg,.jpeg', hint: 'PDF, notes, Office files, and images up to 20 MB.' },
    ];
    return `<div class="lesson-materials provider-panel">
      ${kinds.map(({ video, title, accept, hint }) => {
        const items = assets.filter(asset => asset.mime.startsWith('video/') === video).map(asset => {
          const status = asset.archived_at ? 'Removed' : asset.ready_at ? '' : 'Pending upload';
          const preview = asset.ready_at && !asset.archived_at
            ? `<button type="button" data-provider-action="${route}/${admin ? 'review_asset' : 'open_asset'}" data-asset="${escape(asset.id)}">${video ? 'Watch video' : 'Open file'}</button>`
            : manage ? `<button type="button" data-provider-action="${route}/confirm_asset" data-asset="${escape(asset.id)}">Verify upload</button>` : '';
          const moderation = admin ? form(route + '/material_moderation',
            `<input type="hidden" name="assetId" value="${escape(asset.id)}"><input type="hidden" name="archived" value="${!asset.archived_at}">`,
            asset.archived_at ? 'Restore file' : 'Remove file', asset.archived_at ? '' : 'Remove this file from the lecture?') : '';
          return `<li><div><strong>${escape(asset.name)}</strong>${status ? `<small>${status}</small>` : ''}</div>
            <div class="record-right">${preview}${moderation}</div></li>`;
        }).join('');
        const label = video ? 'Add video' : 'Add document';
        return `<section class="lesson-material-group"><h4>${title}</h4>
          ${items ? `<ul class="module-list">${items}</ul>` : '<p class="muted">None added yet.</p>'}
          ${manage && storageEnabled ? `<details><summary>${label}</summary>
            <form data-upload-material="${route}" data-video="${video}"><input type="hidden" name="lessonId" value="${escape(lesson.id)}">
              <label>${video ? 'Video file' : 'Document file'}<input name="file" type="file" accept="${accept}" required></label>
              <p class="muted">${hint}</p><button class="primary" type="submit">Upload ${video ? 'video' : 'document'}</button>
              <progress max="100" value="0" aria-label="Upload progress" hidden></progress>
            </form></details>` : ''}</section>`;
      }).join('')}
      ${manage && !storageEnabled ? '<p class="muted">File storage is currently unavailable.</p>' : ''}
      <p class="provider-status" role="status"></p><div data-material-view></div></div>`;
  }

  function moduleLive(services, route, manage, invite, enrolled) {
    if (!services?.enabled.live && !invite && !manage) return '';
    const session = services?.live;
    const active = session && (!invite || invite === session.id);
    const roomId = route.split('/')[1];
    const joinLink = active && manage ? new URL('/modules/' + roomId + '?live=' + session.id, location.origin).href : '';
    return `<section class="module-section panel provider-panel" id="live-classroom" tabindex="-1" data-live-module="${route}"><h2>Live classroom</h2>
      ${invite && !manage && !enrolled ? '<p>Only students already enrolled in this module can use this invitation.</p>'
        : !services?.enabled.live ? '<p class="muted">Live classroom service is currently unavailable.</p>'
        : active ? `<p>${escape(session.title)}</p><div class="actions">
          <button type="button" data-provider-action="${route}/join_live" data-session="${escape(session.id)}">${manage ? 'Join as teacher' : 'Join live class'}</button>
          ${manage ? `<button type="button" data-provider-action="${route}/end_live" data-session="${escape(session.id)}">End class</button>` : ''}
          </div>${joinLink ? `<label>Student join link<input type="url" readonly data-live-link value="${escape(joinLink)}"></label>
          <button type="button" data-live-control="copy">Copy join link</button>` : ''}`
        : invite ? '<p>This live class has ended or the invite is no longer valid.</p>'
        : manage ? `<form data-live-start="${route}/start_live"><label>Class title<input name="title" maxlength="160" required></label>
          <button class="primary" type="submit">Start private class</button></form>` : '<p>No active live class.</p>'}
      <div class="actions" data-live-host hidden>
        <button type="button" data-live-control="mic" aria-pressed="false">Turn on microphone</button>
        <button type="button" data-live-control="camera" aria-pressed="false">Turn on camera</button>
        <button type="button" data-live-control="screen" aria-pressed="false">Share screen</button>
        <button type="button" data-live-control="record" aria-pressed="false">Record class</button>
      </div>
      <button type="button" data-live-control="audio" hidden>Enable class audio</button>
      <button type="button" data-live-control="leave" hidden>Leave room</button>
      <p class="provider-status" role="status"></p><p data-live-download hidden></p><div class="live-media" data-live-media></div></section>`;
  }

  function uploadFile(url, file, type, progress) {
    return new Promise((resolve, reject) => {
      const request = new XMLHttpRequest();
      request.open('PUT', url);
      request.setRequestHeader('Content-Type', type);
      request.setRequestHeader('If-None-Match', '*');
      request.upload.onprogress = event => { if (event.lengthComputable) progress.value = Math.round(event.loaded * 100 / event.total); };
      request.onload = () => request.status >= 200 && request.status < 300 ? resolve() : reject(new Error('Storage rejected the upload.'));
      request.onerror = () => reject(new Error('The upload connection was interrupted.'));
      request.send(file);
    });
  }

  async function checkVideo(file) {
    if (!['video/mp4', 'video/webm'].includes(file.type)) return;
    const url = URL.createObjectURL(file);
    const probe = document.createElement('video');
    try {
      const duration = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Could not read the video duration.')), 15000);
        probe.preload = 'metadata';
        probe.onloadedmetadata = () => { clearTimeout(timer); resolve(probe.duration); };
        probe.onerror = () => { clearTimeout(timer); reject(new Error('This recording could not be read. Use MP4 or WebM with a browser-supported codec.')); };
        probe.src = url;
      });
      if (!Number.isFinite(duration) || duration <= 0 || duration > 14400)
        throw new Error('Choose a video with a duration of no more than four hours.');
    } finally {
      probe.removeAttribute('src');
      URL.revokeObjectURL(url);
    }
  }

  function loadLiveKit() {
    if (!liveKitReady) {
      liveKitReady = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = '/vendor/livekit.js';
        script.onload = () => window.LivekitClient ? resolve(window.LivekitClient) : reject(new Error('Live classroom player is unavailable.'));
        script.onerror = () => reject(new Error('Live classroom player could not load.'));
        document.head.append(script);
      }).catch(error => { liveKitReady = undefined; throw error; });
    }
    return liveKitReady;
  }

  function updateLiveControls(panel) {
    const participant = liveRoom?.localParticipant;
    const states = [
      ['mic', participant?.isMicrophoneEnabled, 'Turn on microphone', 'Mute microphone'],
      ['camera', participant?.isCameraEnabled, 'Turn on camera', 'Turn off camera'],
      ['screen', participant?.isScreenShareEnabled, 'Share screen', 'Stop sharing'],
      ['record', Boolean(classRecorder), 'Record class', 'Stop and save recording'],
    ];
    for (const [key, enabled, off, on] of states) {
      const button = panel.querySelector(`[data-live-control="${key}"]`);
      button.textContent = enabled ? on : off;
      button.setAttribute('aria-pressed', String(Boolean(enabled)));
    }
  }

  function showRecording(panel) {
    const slot = panel.querySelector('[data-live-download]');
    if (savedRecording?.module !== panel.dataset.liveModule) return;
    const link = document.createElement('a');
    link.href = savedRecording.url;
    link.download = savedRecording.filename;
    link.textContent = 'Download class recording';
    link.dataset.liveControl = 'download';
    slot.replaceChildren(link);
    slot.hidden = false;
  }

  async function startClassRecording(panel) {
    if (!window.MediaRecorder || !window.AudioContext || !HTMLCanvasElement.prototype.captureStream)
      throw new Error('Recording requires a desktop browser with MediaRecorder support.');
    const mimes = ['video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'];
    const mimeType = mimes.find(type => MediaRecorder.isTypeSupported(type));
    if (!mimeType) throw new Error('This browser does not support MP4 or WebM recording.');
    const audio = new AudioContext();
    const canvas = document.createElement('canvas');
    canvas.width = 1280;
    canvas.height = 720;
    const context = canvas.getContext('2d');
    const capture = canvas.captureStream(15);
    const output = audio.createMediaStreamDestination();
    const silence = audio.createOscillator();
    const muted = audio.createGain();
    muted.gain.value = 0;
    silence.connect(muted).connect(output);
    silence.start();
    const stream = new MediaStream([...capture.getVideoTracks(), ...output.stream.getAudioTracks()]);
    let animation, duration, source, microphone;
    let size = 0;
    const chunks = [];
    const status = panel.querySelector('.provider-status');
    let recorder;
    const cleanup = () => {
      clearInterval(animation);
      clearTimeout(duration);
      silence.stop();
      for (const track of stream.getTracks()) track.stop();
      void audio.close();
    };
    try {
      await audio.resume();
      if (!liveRoom || livePanel !== panel) throw new Error('Join the classroom before recording.');
      recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 900000, audioBitsPerSecond: 64000 });
      const drawVideo = (video, x, y, w, h) => {
        if (!video || video.readyState < 2 || !video.videoWidth) return;
        const scale = Math.min(w / video.videoWidth, h / video.videoHeight);
        const width = video.videoWidth * scale;
        const height = video.videoHeight * scale;
        context.drawImage(video, x + (w-width)/2, y + (h-height)/2, width, height);
      };
      const draw = () => {
        context.fillStyle = '#161a2d';
        context.fillRect(0, 0, 1280, 720);
        const camera = panel.querySelector('[data-live-source="camera"]:not([hidden])');
        const screen = panel.querySelector('[data-live-source="screen_share"]:not([hidden])');
        drawVideo(screen || camera, 0, 0, 1280, 720);
        if (screen && camera) drawVideo(camera, 980, 540, 280, 160);
        capture.getVideoTracks()[0].requestFrame?.();
        const next = liveRoom?.localParticipant.isMicrophoneEnabled
          ? liveRoom.localParticipant.getTrackPublication('microphone')?.track?.mediaStreamTrack : null;
        if (next !== microphone) {
          source?.disconnect();
          source = next ? audio.createMediaStreamSource(new MediaStream([next])) : null;
          source?.connect(output);
          microphone = next;
        }
      };
      recorder.ondataavailable = event => {
        if (!event.data.size) return;
        chunks.push(event.data);
        size += event.data.size;
        if (size >= 400 * 1024 * 1024 && recorder.state === 'recording') recorder.stop();
      };
      recorder.onstop = () => {
        cleanup();
        classRecorder = undefined;
        if (chunks.length) {
          if (savedRecording) URL.revokeObjectURL(savedRecording.url);
          const ext = mimeType.startsWith('video/mp4') ? 'mp4' : 'webm';
          savedRecording = { module: panel.dataset.liveModule, downloaded: false,
            url: URL.createObjectURL(new Blob(chunks, { type: mimeType.split(';')[0] })),
            filename: `class-${new Date().toISOString().replace(/[:.]/g, '-') }.${ext}` };
          showRecording(document.getElementById('live-classroom') || panel);
          status.textContent = 'Recording ready. Download it before closing this page.';
        } else status.textContent = 'No recording data was captured.';
        updateLiveControls(panel);
      };
      draw();
      recorder.start(1000);
      classRecorder = recorder;
      animation = setInterval(draw, 1000 / 15);
      duration = setTimeout(() => stopClassRecording(), 60 * 60 * 1000);
      status.textContent = 'Recording on this device. Keep this tab open until you save the file.';
    } catch (error) {
      cleanup();
      throw error;
    }
  }

  function stopClassRecording() {
    if (classRecorder?.state === 'recording') classRecorder.stop();
  }

  async function connectClass(grant, panel) {
    const kit = await loadLiveKit();
    if (!panel.isConnected) return;
    await liveRoom?.disconnect();
    const room = new kit.Room();
    const media = panel.querySelector('[data-live-media]');
    const status = panel.querySelector('.provider-status');
    const audio = panel.querySelector('[data-live-control="audio"]');
    const leave = panel.querySelector('[data-live-control="leave"]');
    const host = panel.querySelector('[data-live-host]');
    const detach = track => track.detach().forEach(element => element.remove());
    const attach = (track, publication) => {
      const element = track.attach();
      element.dataset.liveSource = publication.source;
      element.hidden = publication.isMuted;
      media.append(element);
    };
    const refreshMedia = publication => {
      publication.track?.attachedElements.forEach(element => { element.hidden = publication.isMuted; });
      updateLiveControls(panel);
    };
    room.on(kit.RoomEvent.TrackSubscribed, attach);
    room.on(kit.RoomEvent.TrackUnsubscribed, detach);
    room.on(kit.RoomEvent.LocalTrackPublished, publication => {
      if (publication.track?.kind === 'video') attach(publication.track, publication);
      updateLiveControls(panel);
    });
    room.on(kit.RoomEvent.LocalTrackUnpublished, publication => {
      if (publication.track) detach(publication.track);
      updateLiveControls(panel);
    });
    room.on(kit.RoomEvent.TrackMuted, refreshMedia);
    room.on(kit.RoomEvent.TrackUnmuted, refreshMedia);
    room.on(kit.RoomEvent.AudioPlaybackStatusChanged, () => { audio.hidden = room.canPlaybackAudio; });
    room.on(kit.RoomEvent.Disconnected, () => {
      if (liveRoom !== room) return;
      stopClassRecording();
      liveRoom = livePanel = undefined;
      media.replaceChildren();
      host.hidden = audio.hidden = leave.hidden = true;
      panel.querySelector('[data-session]')?.removeAttribute('hidden');
      status.textContent = 'Disconnected from the live class.';
    });
    await room.connect(grant.url, grant.token);
    if (!panel.isConnected) return room.disconnect();
    liveRoom = room;
    livePanel = panel;
    leave.hidden = false;
    host.hidden = !grant.host;
    audio.hidden = room.canPlaybackAudio;
    panel.querySelector('[data-session]')?.setAttribute('hidden', '');
    updateLiveControls(panel);
    status.textContent = grant.host ? 'Connected. Turn on your microphone, camera, or screen when ready.' : 'Connected to the private live class.';
  }

  async function liveControl(button) {
    const panel = button.closest('[data-live-module]');
    const status = panel.querySelector('.provider-status');
    const action = button.dataset.liveControl;
    if (action === 'download') {
      if (savedRecording) savedRecording.downloaded = true;
      return;
    }
    button.disabled = true;
    try {
      if (action === 'copy') {
        const field = panel.querySelector('[data-live-link]');
        try {
          await navigator.clipboard.writeText(field.value);
          status.textContent = 'Join link copied. Share it with enrolled students.';
        } catch {
          field.focus();
          field.select();
          status.textContent = 'The link is selected. Copy it to share.';
        }
        return;
      }
      const room = liveRoom;
      if (!room || panel !== livePanel) return;
      if (action === 'leave') {
        stopClassRecording();
        await room.disconnect();
      } else if (action === 'audio') {
        await room.startAudio();
      } else if (action === 'record') {
        if (classRecorder) stopClassRecording();
        else if (savedRecording && !savedRecording.downloaded)
          throw new Error('Download the previous recording before starting another.');
        else await startClassRecording(panel);
      } else {
        const participant = room.localParticipant;
        if (action === 'mic') await participant.setMicrophoneEnabled(!participant.isMicrophoneEnabled);
        if (action === 'camera') await participant.setCameraEnabled(!participant.isCameraEnabled);
        if (action === 'screen') await participant.setScreenShareEnabled(!participant.isScreenShareEnabled);
      }
      updateLiveControls(panel);
    } catch (error) {
      status.textContent = error.name === 'NotAllowedError' ? 'Media access was declined or the browser blocked it.' : error.message;
    } finally {
      button.disabled = false;
    }
  }

  function adminAccounts(accounts) {
    return `<section id="users" class="dashboard-section" tabindex="-1">
      <header class="section-head"><h2>User management</h2><p>Review requests and manage account access.</p></header>
      <ul class="records">${accounts.users.map(account => `<li><div class="record-person">
        <span class="avatar" aria-hidden="true">${escape((account.name || '?').charAt(0).toUpperCase())}</span>
        <div><strong>${escape(account.name)}</strong><small>${escape(account.email)}</small></div></div>
        <div class="record-right"><span class="role-pill">${escape(account.role)}${account.pending ? ' · Awaiting approval' : ''}${account.suspended ? ' · Deactivated' : ''}</span>
        ${account.pending ? form('users/approve', `<input type="hidden" name="email" value="${escape(account.email)}">`, 'Approve') : ''}
        ${account.role !== 'admin' ? form('users/suspension', `<input type="hidden" name="email" value="${escape(account.email)}">
          <input type="hidden" name="suspended" value="${!account.suspended}">`, account.suspended ? 'Reactivate' : 'Deactivate',
          account.suspended ? '' : 'Deactivate this account and block its access?') : ''}</div>
      </li>`).join('')}</ul>
    </section>`;
  }

  function moduleConversations(course, route, items) {
    const active = course.status !== 'suspended' && course.status !== 'draft';
    const admin = user.role === 'admin';
    const canStart = user.role === 'student' && course.enrolled;
    const threads = items.map(thread => {
      const threadId = `<input type="hidden" name="threadId" value="${escape(thread.id)}">`;
      return `<details class="module-thread" id="thread-${escape(thread.id)}">
        <summary><strong>${escape(thread.subject)}</strong>
          <span>${thread.kind === 'question' ? 'Question' : 'Feedback'} · ${escape(thread.student)} · ${thread.closed ? 'Closed' : 'Open'}</span></summary>
        <ol class="thread-messages">${thread.messages.map(message => `<li><strong>${escape(message.author)}</strong>
          <small>${message.role === 'admin' ? ' · System admin' : message.role === 'teacher' ? ' · Teacher' : ' · Student'}</small>
          <p>${escape(message.text)}</p></li>`).join('')}</ol>
        ${active && !thread.closed ? form(route + '/message_reply', threadId +
          '<label>Reply<textarea name="text" rows="3" maxlength="2000" required></textarea></label>', 'Send reply') : ''}
        ${admin ? form(route + '/message_status', threadId +
          `<input type="hidden" name="closed" value="${!thread.closed}">`, thread.closed ? 'Reopen conversation' : 'Close conversation') : ''}
      </details>`;
    }).join('');
    return `<section class="module-section panel" id="module-messages">
      <h2>Questions and feedback</h2>
      ${canStart && active ? `<details><summary>Contact your teacher</summary>
        <p class="muted">Your conversation is visible to you, your module teacher, and system admins.</p>
        ${form(route + '/message_create',
          '<label>Type<select name="kind"><option value="question">Question</option><option value="feedback">Feedback</option></select></label>' +
          '<label>Subject<input name="subject" maxlength="160" required></label>' +
          '<label>Message<textarea name="text" rows="4" maxlength="2000" required></textarea></label>', 'Send message')}</details>` : ''}
      ${threads || '<p class="muted">No conversations yet.</p>'}
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
    const moduleId = /^\/modules\/([\w-]+)$/.exec(path)?.[1];
    const invite = new URLSearchParams(location.search).get('live');
    if (!user) return go(moduleId ? '/login?module=' + encodeURIComponent(moduleId) +
      (liveId(invite) ? '&live=' + encodeURIComponent(invite) : '') : '/login', true);
    if (!moduleId && path !== dashboard()) return go(dashboard(), true);
    if (moduleId) {
      main.innerHTML = `<div class="module-page"><a href="${dashboard()}" data-link>← Back to dashboard</a>
        <section id="course-detail" tabindex="-1" aria-label="Module details"></section></div>`;
      await openCourse(moduleId);
      return;
    }
    main.innerHTML = '<p class="loading" role="status">Loading your workspace…</p>';
    try {
      const [summary, catalog, accounts, available] = await Promise.all([api('dashboard'), api('courses'),
        user.role === 'admin' ? api('users') : null, api('capabilities').catch(() => ({}))]);
      if (current !== revision) return;
      capabilities = available;
      const cards = catalog.courses.map(courseCard).join('');
      const role = user.role;
      const copy = workspaceCopy[role];
      const courseHeading = role === 'student' ? 'Explore courses' : role === 'teacher' ? 'My courses' : 'Module management';
      const empty = role === 'teacher' ? 'Create your first course to start adding lessons.' : 'Published courses will appear here.';
      main.innerHTML = `<section class="workspace ${role} enter">
        <aside class="workspace-nav">
          <div class="workspace-identity"><span class="avatar" aria-hidden="true">${escape((user.name || '?').charAt(0).toUpperCase())}</span><div><strong>${escape(user.name)}</strong><small>${labels[role]}</small></div></div>
          <nav aria-label="Workspace sections"><button type="button" data-jump="overview">Overview</button>
            ${accounts ? '<button type="button" data-jump="users">User management</button>' : ''}
            <button type="button" data-jump="courses">${courseHeading}</button>
            ${role === 'teacher' ? '<button type="button" data-jump="create">Create module</button>' : ''}
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
            ${role === 'teacher' ? `<details id="create" class="panel course-create" tabindex="-1"><summary>Create module</summary>
              <p class="muted">Students can discover the module as soon as you create it. Then add lectures from its module page.</p>
              ${form('courses', moduleFields(), 'Create module')}</details>` : ''}
            ${cards ? `<div class="course-toolbar"><label>Search courses<input type="search" data-course-search placeholder="Search by course or teacher"></label>
              ${role === 'student' ? '<label>Show<select data-course-filter><option value="all">All courses</option><option value="yes">My enrollments</option><option value="no">Available to join</option></select></label>' : ''}</div>
              <div class="course-grid">${cards}</div><p class="empty muted" data-no-matches hidden>No courses match your search.</p>`
              : `<div class="empty"><span class="empty-icon" aria-hidden="true">✦</span><strong>No courses yet</strong><p>${empty}</p></div>`}
          </section>
          ${role === 'student' ? helpDesk() : ''}
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
      const route = `courses/${id}`;
      const [{ course, lessons, students, completed, exams, history = [], learnerProgress = [] }, page, available] = await Promise.all([
        api(route), api(route + '/module_page').catch(error => ({ error: error.message })),
        api('capabilities').catch(() => ({})),
      ]);
      if (current !== revision || request !== courseRevision || !detail.isConnected) return;
      capabilities = available;
      const admin = user.role === 'admin';
      const manage = user.role === 'teacher' && course.status !== 'suspended';
      const invite = new URLSearchParams(location.search).get('live');
      const services = (manage || course.enrolled) && (capabilities.materials || capabilities.live)
        ? await api(route + '/services').catch(() => null) : null;
      if (current !== revision || request !== courseRevision || !detail.isConnected) return;
      const outlineOnly = user.role === 'student' && !course.enrolled;
      const outline = page.outline || [];
      const order = new Map(outline.map((lecture, i) => [lecture.id, i]));
      const lectures = outlineOnly ? outline : [...lessons].sort((a, b) =>
        (order.get(a.id) ?? outline.length) - (order.get(b.id) ?? outline.length));
      const assets = admin ? page.assets || [] : services?.assets || [];
      const archived = course.status === 'suspended';
      detail.innerHTML = `<article class="panel course-detail enter"><header class="module-heading"><p class="eyebrow">${escape(course.subject || 'Subject module')}</p><h2>${escape(course.title)}</h2><p>${escape(course.teacher)} · ${escape(course.lessonCount)} lessons</p>
        ${course.description ? `<p class="module-description">${escape(course.description)}</p>` : ''}</header>
        ${manage && course.status === 'draft' ? form(`${route}/publish`, '', 'Publish course') : ''}
        ${manage ? `<details class="panel"><summary>Edit module details</summary>${form(`${route}/edit`, moduleFields(course), 'Save module')}</details>` : ''}
        ${admin ? form(route + (archived ? '/restore' : '/archive'), '', archived ? 'Restore module' : 'Archive module',
          archived ? '' : 'Archive this module and remove it from student access?') : ''}
        ${outlineOnly && !invite ? form(`${route}/enroll`, '', 'Enroll in module') : ''}
        ${moduleLive(services, route, manage && course.status !== 'draft', invite, course.enrolled)}
        <section class="module-section lecture-series" aria-labelledby="lecture-heading">
          <h2 id="lecture-heading">Lectures</h2>
          ${manage ? `<details class="panel"><summary>Add lecture</summary>${form(`${route}/lessons`,
            '<label>Lecture title<input name="title" maxlength="160" required></label><label>Description<input name="description" maxlength="1000"></label><label>Lecture notes<textarea name="text" maxlength="12000"></textarea></label>',
            'Save lecture')}</details>` : ''}
          ${outlineOnly ? '<p class="muted">Enroll to access the lecture notes, videos, and documents.</p>' : ''}
          ${lectures.length ? `<ol class="lecture-list">${lectures.map((lesson, index) => `<li class="lecture-card" id="lecture-${escape(lesson.id)}" tabindex="-1">
            <p class="eyebrow">Lecture ${index + 1}</p><h3>${escape(lesson.title)}</h3>
            ${lesson.description ? `<p class="muted">${escape(lesson.description)}</p>` : ''}
            ${lesson.text ? `<p class="lecture-notes">${escape(lesson.text)}</p>` : ''}
            ${!outlineOnly && (admin || manage || course.enrolled) ? lessonMaterials(assets.filter(asset => asset.lesson === lesson.id),
              route, lesson, manage, admin, services?.enabled.materials) : ''}
            ${course.enrolled ? completed.includes(lesson.id) ? '<p class="completed">✓ Completed</p>' :
              form(`${route}/progress`, `<input type="hidden" name="lessonId" value="${escape(lesson.id)}">`, 'Mark complete') : ''}
          </li>`).join('')}</ol>` : '<p class="muted">No lectures have been added yet.</p>'}
        </section>
        ${page.error ? `<p class="error" role="status">${escape(page.error)}</p>`
          : !outlineOnly ? moduleConversations(course, route, page.conversations) : ''}
        ${students ? `<section class="module-section"><h2>Learner progress</h2>${learnerProgress.length ? `<ul class="module-list">${learnerProgress.map(p => `<li><strong>${escape(p.name)}</strong><span>${escape(p.completed)} of ${lessons.length} lessons complete</span></li>`).join('')}</ul>` : `<p>${students.map(s => escape(s.name)).join(', ') || 'No students enrolled yet.'}</p>`}</section>` : ''}
        ${course.enrolled ? `<section class="module-tip provider-panel"><strong>Your next step</strong> ${course.progress >= 100 ? 'Review the module and check for available exams.' : 'Continue with your next unfinished lesson.'}
          ${capabilities.ai ? `<p><button type="button" data-provider-action="${route}/ai_progress">Suggest study steps</button></p><p class="provider-status" role="status"></p>` : ''}</section>` : ''}
        ${Array.isArray(exams) ? examsView(exams, route, manage, course.enrolled) : ''}
        ${manage && history.length ? `<details class="panel module-section"><summary>Module version history</summary><ul class="module-list">${history.map(r => `<li><strong>${escape(r.snapshot.title)} · ${escape(r.snapshot.status)}</strong><span>${escape(new Date(r.recorded_at).toLocaleString())}</span>${r.snapshot.subject ? `<p>${escape(r.snapshot.subject)}</p>` : ''}${r.snapshot.description ? `<p>${escape(r.snapshot.description)}</p>` : ''}</li>`).join('')}</ul></details>` : ''}
        </article>`;
      const roomPanel = detail.querySelector('[data-live-module]');
      if (roomPanel && livePanel?.dataset.liveModule === route) roomPanel.replaceWith(livePanel);
      const classroom = detail.querySelector('[data-live-module]');
      if (classroom) showRecording(classroom);
      if (invite && classroom) classroom.focus();
      else detail.focus();
    } catch (error) {
      if (current === revision && request === courseRevision) detail.textContent = error.message;
    }
  }

  document.addEventListener('click', async event => {
    const control = event.target.closest('[data-link],[data-theme],[data-logout],[data-retry],[data-password-toggle],[data-jump],[data-add-question],[data-provider-action],[data-live-control]');
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
      if (classRecorder || (savedRecording && !savedRecording.downloaded)) {
        window.alert('Stop and download your class recording before signing out.');
        return;
      }
      try { await api('logout', {}); } catch { /* Clear the browser session even if the API is offline. */ }
      clearSession();
      go('/login', true);
    } else if (control.hasAttribute('data-live-control')) {
      await liveControl(control);
    } else if (control.hasAttribute('data-provider-action')) {
      const panel = control.closest('.provider-panel') || control.form;
      const status = panel.querySelector('.provider-status');
      const action = control.dataset.providerAction;
      const body = control.dataset.asset ? { assetId: control.dataset.asset } : {};
      if (control.dataset.session) body.sessionId = control.dataset.session;
      if (action.endsWith('/ai_feedback')) {
        body.examId = panel.elements.examId.value;
        body.studentId = panel.elements.studentId.value;
      }
      control.disabled = true;
      status.textContent = 'Working…';
      try {
        const result = await api(action, body);
        if (action.endsWith('/open_asset') || action.endsWith('/review_asset')) {
          const area = panel.querySelector('[data-material-view]');
          let player;
          if (result.mime.startsWith('video/')) {
            player = document.createElement('video');
            player.controls = true;
            player.playsInline = true;
            player.preload = 'metadata';
            player.src = result.url;
            status.textContent = 'The recording is ready to play.';
          } else {
            player = document.createElement('a');
            player.href = result.url;
            player.target = '_blank';
            player.rel = 'noopener noreferrer';
            player.textContent = 'Open the requested file';
            status.textContent = 'Your private link is ready.';
          }
          area.replaceChildren(player);
        } else if (action.endsWith('/join_live')) {
          await connectClass(result, panel);
        } else if (result.answer) {
          status.textContent = result.answer;
          if (action.endsWith('/ai_feedback') && !panel.elements.feedback.value.trim()) panel.elements.feedback.value = result.answer.slice(0, 2000);
        } else {
          if (action.endsWith('/end_live')) {
            stopClassRecording();
            await liveRoom?.disconnect();
          }
          await render();
        }
      } catch (error) {
        status.textContent = error.message;
      } finally {
        control.disabled = false;
      }
    } else if (control.hasAttribute('data-add-question')) {
      const list = control.form.querySelector('[data-question-list]');
      const count = list.children.length;
      if (count < 25) {
        list.insertAdjacentHTML('beforeend', examQuestion(count));
        list.lastElementChild.querySelector('input').focus();
      }
      if (count >= 24) control.disabled = true;
    } else {
      await render();
    }
  });

  function filterCourses() {
    const search = (main.querySelector('[data-course-search]')?.value || '').trim().toLowerCase();
    const enrollment = main.querySelector('[data-course-filter]')?.value || 'all';
    let matches = 0;
    for (const card of main.querySelectorAll('[data-course-card]')) {
      const text = card.querySelector('.course-body').textContent;
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
    if (element.hasAttribute('data-upload-material') || element.hasAttribute('data-live-start')) {
      event.preventDefault();
      const panel = element.closest('.provider-panel');
      const status = panel.querySelector('.provider-status');
      const button = element.querySelector('[type=submit]');
      button.disabled = true;
      status.textContent = 'Working…';
      try {
        if (element.dataset.liveStart) {
          const grant = await api(element.dataset.liveStart, { title: element.elements.title.value });
          if (!panel.isConnected) return;
          await render();
          const refreshed = document.querySelector('[data-live-media]')?.closest('.provider-panel');
          if (refreshed?.dataset.liveModule === panel.dataset.liveModule) {
            try { await connectClass(grant, refreshed); }
            catch { refreshed.querySelector('.provider-status').textContent = 'Class opened. Select Join as teacher to connect.'; }
          }
        } else {
          const route = element.dataset.uploadMaterial;
          const file = element.elements.file.files[0];
          if (!file) throw new Error('Choose a file first.');
          const lectureId = 'lecture-' + element.elements.lessonId.value;
          if (file.type.startsWith('video/') !== (element.dataset.video === 'true'))
            throw new Error(element.dataset.video === 'true' ? 'Choose a supported video.' : 'Use Add video to upload a video.');
          const maximum = file.type.startsWith('video/') ? 2147483648 : 20971520;
          if (file.size > maximum) throw new Error('The selected file exceeds the allowed size.');
          await checkVideo(file);
          const { asset, uploadUrl } = await api(route + '/reserve_asset', { lessonId: element.elements.lessonId.value,
            name: file.name, mime: file.type, size: file.size });
          const progress = element.querySelector('progress');
          progress.value = 0;
          progress.hidden = false;
          status.textContent = 'Uploading directly to storage…';
          await uploadFile(uploadUrl, file, asset.mime, progress);
          await api(route + '/confirm_asset', { assetId: asset.id });
          await render();
          document.getElementById(lectureId)?.focus();
        }
      } catch (error) {
        status.textContent = error.message;
      } finally {
        button.disabled = false;
      }
      return;
    }
    if (element.hasAttribute('data-help-form')) {
      event.preventDefault();
      const question = element.elements.question.value;
      const status = element.querySelector('[role=status]');
      const fallback = helpAnswers.find(([pattern]) => pattern.test(question))?.[1]
        || 'Try asking “How do I enroll?”, “Where are my results?”, or “How do I complete a lesson?”';
      if (!capabilities.ai) { status.textContent = fallback; return; }
      const button = element.querySelector('[type=submit]');
      button.disabled = true;
      status.textContent = 'Looking up your question…';
      try { status.textContent = (await api('help/ai', { question })).answer; }
      catch { status.textContent = 'AI is unavailable. From the help guide: ' + fallback; }
      finally { button.disabled = false; }
      return;
    }
    if (!element.dataset.submit) return;
    event.preventDefault();
    if (element.dataset.confirm && !window.confirm(element.dataset.confirm)) return;
    const button = element.querySelector('button[type="submit"]');
    const status = element.querySelector('[role=status]');
    button.disabled = true;
    status.textContent = '';
    const values = Object.fromEntries(new FormData(element));
    const action = element.dataset.submit;
    if (action.endsWith('/exam_create')) {
      values.questions = Array.from(element.querySelectorAll('[data-question]'), field => ({
        prompt: field.querySelector('[name="prompt"]').value,
        options: Array.from(field.querySelectorAll('[name="option"]'), input => input.value),
        correct: Number(field.querySelector('[name="correct"]').value),
      }));
      for (const name of ['prompt', 'option', 'correct']) delete values[name];
    }
    if (action.endsWith('/exam_submit')) {
      values.answers = Array.from(element.querySelectorAll('fieldset'), (_, i) => Number(values['answer-' + i]));
    }
    if (values.teacher) values.teacher = true;
    if ('suspended' in values) values.suspended = values.suspended === 'true';
    if ('archived' in values) values.archived = values.archived === 'true';
    if ('closed' in values) values.closed = values.closed === 'true';
    try {
      const result = await api(action, values);
      if (action === 'login') {
        ({ token, user } = result);
        sessionStorage.setItem('sls-session', token);
        const params = new URLSearchParams(location.search);
        const module = params.get('module');
        const invite = params.get('live');
        go(module && /^[\w-]+$/.test(module) ? '/modules/' + module + (liveId(invite) ? '?live=' + invite : '') : dashboard(), true);
      } else if (action === 'register') {
        element.reset();
        const password = element.elements.password;
        password.type = 'password';
        element.querySelector('[data-password-toggle]').textContent = 'Show password';
        status.textContent = result.checkEmail
          ? 'Check your email to confirm your account. Teacher accounts also require administrator approval.'
          : result.pending ? 'Your application is awaiting administrator approval.' : 'Account created. You can sign in.';
      } else {
        if (action === 'courses' && result.course?.id) go('/modules/' + encodeURIComponent(result.course.id));
        else {
          const lectureId = element.closest('.lecture-card')?.id;
          await render();
          if (action.includes('/message_')) {
            const thread = document.getElementById('thread-' + (result.id || values.threadId));
            if (thread) {
              thread.open = true;
              thread.querySelector('summary')?.focus();
            }
          } else if (action.endsWith('/lessons')) {
            document.querySelector('.lecture-card:last-child')?.focus();
          } else if (lectureId) document.getElementById(lectureId)?.focus();
        }
      }
    } catch (error) {
      status.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });

  window.addEventListener('popstate', () => {
    if (livePanel && location.pathname !== '/modules/' + livePanel.dataset.liveModule.split('/')[1]) {
      stopClassRecording();
      void liveRoom?.disconnect();
    }
    void render();
  });
  window.addEventListener('beforeunload', event => {
    if (!classRecorder && (!savedRecording || savedRecording.downloaded)) return;
    event.preventDefault();
    event.returnValue = '';
  });
  document.documentElement.classList.toggle('dark', localStorage.getItem('sls-theme') === 'dark');
  void (async () => {
    if (token) {
      try { ({ user } = await api('me')); }
      catch { clearSession(); }
    }
    await render();
  })();
})();
