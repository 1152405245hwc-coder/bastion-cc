const $ = (id) => document.getElementById(id);

const DRAFT_PREFIX = 'ccrf:draft:';
const LAST_SESSION_KEY = 'ccrf:last-session';

const state = {
  session: '',
  generation: 0,
  run: null,
  transcriptCursor: 0,
  search: '',
  sessionsCache: [],
  lastPrompt: '',
  localServerRunning: false,
  localRunnerRunning: false,
  lastCompositionEndAt: null,
};

const showError = (error) => {
  const text = error instanceof Error ? error.message : String(error || '');
  $('error').textContent = text;
  if (text && $('connect-drawer')) $('connect-drawer').open = true;
};

const showNotice = (message) => {
  const box = $('notice');
  if (!message) {
    box.hidden = true;
    box.textContent = '';
    return;
  }
  box.hidden = false;
  box.textContent = message;
};

const draftKey = (sessionId) => `${DRAFT_PREFIX}${sessionId}`;

const saveDraft = () => {
  if (!state.session) return;
  try {
    const value = $('prompt-input').value;
    if (value) localStorage.setItem(draftKey(state.session), value);
    else localStorage.removeItem(draftKey(state.session));
  } catch {
    // Ignore storage quota issues.
  }
};

const restoreDraft = (sessionId) => {
  try {
    $('prompt-input').value = sessionId ? (localStorage.getItem(draftKey(sessionId)) || '') : '';
  } catch {
    $('prompt-input').value = '';
  }
};

const renderEmptyState = (title = '🚀 欢迎使用 BastionCC（棱堡）桌面工作台') => {
  const box = document.createElement('div');
  box.id = 'empty-state';
  box.className = 'empty-guide';
  const heading = document.createElement('h3');
  heading.textContent = title;
  const list = document.createElement('ol');
  for (const step of [
    '点击上方 ⚡ 一键本地服务 快速体验，或展开 远程 VPS 连接设置 连入服务器。',
    '左侧选择项目目录并点击 + 新建 创建会话（自动保留服务器原生 claude --resume 上下文）。',
    '在下方输入指令，按 Enter 发送（支持中文输入法防误触），Shift + Enter 换行。',
  ]) {
    const li = document.createElement('li');
    li.textContent = step;
    list.append(li);
  }
  box.append(heading, list);
  $('transcript').replaceChildren(box);
};

const renderDesktopRuntime = (runtime) => {
  if (!runtime) return;
  state.localServerRunning = Boolean(runtime.localServer?.running);
  state.localRunnerRunning = Boolean(runtime.localRunner?.running);
  const serverBtn = $('toggle-local-server');
  serverBtn.textContent = state.localServerRunning ? '⚡ 本地服务运行中' : '⚡ 一键本地服务';
  serverBtn.className = state.localServerRunning ? 'active-toggle compact' : 'secondary compact';
  const runnerBtn = $('toggle-local-runner');
  runnerBtn.textContent = state.localRunnerRunning ? '🏃 本机执行器运行中' : '🏃 本机执行器';
  runnerBtn.className = state.localRunnerRunning ? 'active-toggle compact' : 'secondary compact';
  if (runtime.config?.baseUrl) $('base-url-input').value = runtime.config.baseUrl;
  if (runtime.config?.authToken) $('auth-token-input').value = runtime.config.authToken;
  if (runtime.config?.lastProject && !$('project-input').value) $('project-input').value = runtime.config.lastProject;
};

const refreshMetrics = async () => {
  try {
    const metrics = await window.relay.getMetrics();
    if (!metrics) return;
    $('metrics-pill').textContent = `📊 会话 ${metrics.totalSessions} · 轮次 ${metrics.totalRuns} · ~${metrics.estimatedTokens} Tokens · 缓存命中 ${metrics.cacheHitRate ?? 0}%`;
  } catch {
    // Ignore metrics polling failures before connection.
  }
};

const renderRunState = () => {
  const awaiting = Boolean(state.run?.leaseId && state.run.status === 'awaiting_approval');
  $('approval-banner').hidden = !awaiting;
  $('approve-yes').disabled = !awaiting;
  $('approve-no').disabled = !awaiting;
  $('cancel').disabled = !state.run?.leaseId || ['completed', 'failed', 'cancelled', 'unknown'].includes(state.run.status);
};

const setSessionEnabled = (enabled) => {
  for (const id of ['delete-session', 'disconnect', 'reconnect', 'start-run', 'rename-toggle', 'fork-session', 'export-session']) {
    $(id).disabled = !enabled;
  }
};

const loadTranscript = async (reset = false) => {
  if (!state.session || !state.run?.runId) {
    if (reset) renderEmptyState('💬 当前会话暂无对话记录');
    return;
  }
  if (reset) {
    state.transcriptCursor = 0;
    $('transcript').replaceChildren();
  }
  const page = await window.relay.getRunTranscript(state.session, state.run.runId, state.transcriptCursor);
  if (!page) return;
  state.run = { ...state.run, status: page.status };
  renderRunState();
  const chunks = page.chunks || [];
  if (chunks.length > 0) $('empty-state')?.remove();
  for (const chunk of chunks) {
    const box = document.createElement('div');
    box.className = `chunk ${chunk.role === 'prompt' ? 'prompt' : 'output'}`;
    const head = document.createElement('div');
    head.className = 'chunk-head';
    head.textContent = chunk.role === 'prompt' ? `👤 指令 #${chunk.chunkIndex}` : `🤖 输出 #${chunk.chunkIndex}`;
    const body = document.createElement('div');
    body.className = 'chunk-body';
    body.textContent = chunk.text;
    box.append(head, body);
    $('transcript').append(box);
  }
  if ($('transcript').children.length === 0) {
    renderEmptyState('💬 当前会话暂无对话记录');
  }
  $('transcript').scrollTop = $('transcript').scrollHeight;
  if (typeof page.nextCursor === 'number') state.transcriptCursor = page.nextCursor;
};

const renderSessionGroups = (sessions) => {
  const container = $('session-groups');
  container.replaceChildren();
  const grouped = new Map();
  for (const item of sessions || []) {
    const groupName = item.project || '默认项目 (未分类)';
    if (!grouped.has(groupName)) grouped.set(groupName, []);
    grouped.get(groupName).push(item);
  }
  for (const [groupName, items] of grouped.entries()) {
    const group = document.createElement('div');
    group.className = 'project-group';
    const heading = document.createElement('div');
    heading.className = 'project-title';
    heading.textContent = `📁 ${groupName} (${items.length})`;
    group.append(heading);
    const list = document.createElement('ul');
    for (const item of items) {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = item.sessionId === state.session ? 'session-btn selected' : 'session-btn secondary';
      const label = document.createElement('span');
      label.textContent = item.title || item.sessionId;
      const badge = document.createElement('span');
      badge.className = 'session-badge';
      badge.textContent = `${item.status} · ${item.runCount ?? 0}`;
      btn.append(label, badge);
      btn.addEventListener('click', () => selectSession(item.sessionId).catch(showError));
      li.append(btn);
      list.append(li);
    }
    group.append(list);
    container.append(group);
  }
};

const loadSessions = async () => {
  const filter = state.search ? { query: state.search } : undefined;
  const sessions = await window.relay.listSessions(filter);
  state.sessionsCache = sessions || [];
  renderSessionGroups(state.sessionsCache);
  await refreshMetrics();
};

const updateTagChip = (id, text) => {
  const el = $(id);
  if (!text) {
    el.hidden = true;
    el.textContent = '';
    return;
  }
  el.hidden = false;
  el.textContent = text;
};

const selectSession = async (sessionId) => {
  showError('');
  showNotice('');
  saveDraft();
  const previousRun = state.run;
  state.session = sessionId;
  state.run = null;
  try {
    localStorage.setItem(LAST_SESSION_KEY, sessionId);
  } catch {
    // Ignore storage failures.
  }
  const session = await window.relay.getSession(sessionId);
  $('active-session').textContent = session.title ? `${session.title} (${session.sessionId})` : session.sessionId;
  updateTagChip('active-project-tag', session.project ? `📁 ${session.project}` : '');
  updateTagChip('active-claude-tag', [
    session.accountProfile ? `🏠 ${session.accountProfile}` : '',
    session.providerSessionId ? `🔗 Claude续接:${session.providerSessionId.slice(0, 8)}` : '',
  ].filter(Boolean).join(' · '));
  $('session-status').textContent = session.status;
  $('generation').textContent = String(session.generation);
  $('rename-title-input').value = session.title || '';
  $('rename-project-input').value = session.project || '';
  if (session.approvalMode) $('approval-mode').value = session.approvalMode;
  if (session.reasoningEffort) $('reasoning-effort').value = session.reasoningEffort;
  $('account-profile').value = session.accountProfile || '';
  state.generation = session.generation;
  if (session.currentRunId) {
    state.run = {
      runId: session.currentRunId,
      status: previousRun?.runId === session.currentRunId ? previousRun.status : 'unknown',
      ...(previousRun?.runId === session.currentRunId && previousRun.leaseId ? { leaseId: previousRun.leaseId } : {}),
    };
  }
  setSessionEnabled(true);
  restoreDraft(sessionId);
  renderRunState();
  await Promise.all([loadSessions(), loadTranscript(true)]);
};

const generateSessionId = () => {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `session-${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
};

const promptInput = $('prompt-input');
promptInput.addEventListener('input', saveDraft);
promptInput.addEventListener('compositionend', (event) => {
  state.lastCompositionEndAt = event.timeStamp;
});
promptInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    if (
      event.isComposing
      || event.keyCode === 229
      || (state.lastCompositionEndAt !== null && Math.abs(event.timeStamp - state.lastCompositionEndAt) < 50)
    ) {
      return;
    }
    if (!$('start-run').disabled) {
      $('run-form').requestSubmit();
    }
  }
});

$('session-search').addEventListener('input', (event) => {
  state.search = event.currentTarget.value.trim();
  loadSessions().catch(showError);
});

$('pick-folder').addEventListener('click', async () => {
  try {
    const picked = await window.relay.pickFolder();
    if (!picked.canceled && picked.path) {
      $('project-input').value = picked.path;
    }
  } catch (error) {
    showError(error);
  }
});

$('toggle-local-server').addEventListener('click', async () => {
  showError('');
  showNotice('');
  try {
    const runtime = await window.relay.toggleLocalServer();
    renderDesktopRuntime(runtime);
    if (runtime.localServer?.running) {
      await loadSessions();
      showNotice(`本地服务已就绪: ${runtime.localServer.baseUrl}`);
    } else {
      showNotice('本地服务已停止');
    }
  } catch (error) {
    showError(error);
  }
});

$('toggle-local-runner').addEventListener('click', async () => {
  showError('');
  try {
    const runtime = await window.relay.toggleLocalRunner();
    renderDesktopRuntime(runtime);
    showNotice(runtime.localRunner?.running ? '本机执行器已启动，等待队列任务' : '本机执行器已停止');
  } catch (error) {
    showError(error);
  }
});

$('connect-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  showError('');
  const form = new FormData(event.currentTarget);
  try {
    await window.relay.configure({
      baseUrl: String(form.get('baseUrl') || 'http://127.0.0.1:8787'),
      authToken: String(form.get('authToken') || ''),
      totp: String(form.get('totp') || '').trim() || undefined,
    });
    await loadSessions();
    if ($('connect-drawer')) $('connect-drawer').open = false;
    showNotice('已连接到控制服务器');
  } catch (error) {
    showError(error);
  }
});

$('oauth-login').addEventListener('click', () => {
  window.relay.openExternal('https://claude.ai/login').catch(showError);
});

$('pair-code-btn').addEventListener('click', async () => {
  showError('');
  try {
    const challenge = await window.relay.createPairingCode({
      deviceId: `dev-${Date.now().toString(36)}`,
      label: 'Remote CLI / Mobile',
      scopes: ['control', 'read'],
    });
    showNotice(`一次性6位配对码（5分钟内有效，仅限单次兑换）: ${challenge.code}`);
  } catch (error) {
    showError(error);
  }
});

$('reload-sessions').addEventListener('click', () => loadSessions().catch(showError));

$('create-session-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  showError('');
  const rawInput = $('new-session-input').value.trim();
  const project = $('project-input').value.trim();
  const looksLikeId = /^[A-Za-z0-9._-]+$/.test(rawInput);
  const sessionId = rawInput && looksLikeId ? rawInput : generateSessionId();
  const title = rawInput && !looksLikeId ? rawInput : (rawInput || `对话 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`);
  try {
    await window.relay.createSession(sessionId, {
      title,
      ...(project ? { project } : {}),
      approvalMode: $('approval-mode').value,
      reasoningEffort: $('reasoning-effort').value,
      ...($('account-profile').value ? { accountProfile: $('account-profile').value } : {}),
    });
    if (project) await window.relay.saveConfig({ lastProject: project });
    $('new-session-input').value = '';
    await selectSession(sessionId);
  } catch (error) {
    showError(error);
  }
});

$('rename-toggle').addEventListener('click', () => {
  $('rename-bar').hidden = !$('rename-bar').hidden;
});

$('rename-cancel').addEventListener('click', () => {
  $('rename-bar').hidden = true;
});

$('rename-bar').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!state.session) return;
  try {
    await window.relay.updateSession(state.session, {
      title: $('rename-title-input').value.trim(),
      project: $('rename-project-input').value.trim(),
    });
    $('rename-bar').hidden = true;
    await selectSession(state.session);
  } catch (error) {
    showError(error);
  }
});

for (const id of ['approval-mode', 'reasoning-effort', 'account-profile']) {
  $(id).addEventListener('change', async () => {
    if (!state.session) return;
    try {
      await window.relay.updateSession(state.session, {
        approvalMode: $('approval-mode').value,
        reasoningEffort: $('reasoning-effort').value,
        accountProfile: $('account-profile').value,
      });
      await selectSession(state.session);
    } catch (error) {
      showError(error);
    }
  });
}

$('fork-session').addEventListener('click', async () => {
  if (!state.session) return;
  showError('');
  const newSessionId = `${state.session}-fork-${Date.now().toString(36)}`.slice(0, 180);
  try {
    await window.relay.forkSession(state.session, { newSessionId });
    await selectSession(newSessionId);
    showNotice(`已从 ${state.session} 分叉出新会话 ${newSessionId}`);
  } catch (error) {
    showError(error);
  }
});

$('export-session').addEventListener('click', async () => {
  if (!state.session) return;
  showError('');
  try {
    const exported = await window.relay.exportSession(state.session, 'markdown');
    const blob = new Blob([exported.markdown || JSON.stringify(exported, null, 2)], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${state.session}.md`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showNotice(`已导出 ${state.session}.md`);
  } catch (error) {
    showError(error);
  }
});

$('delete-session').addEventListener('click', async () => {
  if (!state.session) return;
  try {
    await window.relay.deleteSession(state.session);
    try { localStorage.removeItem(draftKey(state.session)); } catch {}
    state.session = '';
    state.run = null;
    setSessionEnabled(false);
    $('active-session').textContent = '未选择会话';
    updateTagChip('active-project-tag', '');
    updateTagChip('active-claude-tag', '');
    $('session-status').textContent = '未连接';
    $('generation').textContent = '-';
    $('prompt-input').value = '';
    renderEmptyState();
    renderRunState();
    await loadSessions();
  } catch (error) {
    showError(error);
  }
});

$('compact-sessions').addEventListener('click', async () => {
  try {
    const res = await window.relay.compactSessions(5);
    showNotice(`历史压缩完成，清理分片 ${res?.prunedChunks ?? 0} 条`);
  } catch (error) {
    showError(error);
  }
});

const submitPrompt = async (promptText) => {
  showError('');
  showNotice('');
  state.lastPrompt = promptText;
  $('retry-last').hidden = true;
  const execute = $('run-form').elements.execute.checked;
  const approvalMode = $('approval-mode').value;
  const reasoningEffort = $('reasoning-effort').value;
  try {
    state.run = await window.relay.startRun(state.session, {
      requestId: crypto.randomUUID(),
      generation: state.generation,
      idempotencyKey: crypto.randomUUID(),
      prompt: promptText,
      execute,
      approvalMode,
      reasoningEffort,
    });
    $('prompt-input').value = '';
    saveDraft();
    await selectSession(state.session);
  } catch (error) {
    $('retry-last').hidden = false;
    showError(error);
  }
};

$('run-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const prompt = $('prompt-input').value;
  if (!prompt.trim()) return;
  await submitPrompt(prompt);
});

$('retry-last').addEventListener('click', async () => {
  if (!state.lastPrompt || !state.session) return;
  await submitPrompt(state.lastPrompt);
});

$('cancel').addEventListener('click', async () => {
  if (!state.run?.leaseId) return;
  try {
    state.run = await window.relay.cancelRun(state.session, { runId: state.run.runId, leaseId: state.run.leaseId });
    renderRunState();
  } catch (error) {
    showError(error);
  }
});

for (const [id, approved] of [['approve-yes', true], ['approve-no', false]]) {
  $(id).addEventListener('click', async () => {
    if (!state.run?.leaseId) return;
    try {
      state.run = await window.relay.respondApproval(state.session, { runId: state.run.runId, leaseId: state.run.leaseId, approved });
      renderRunState();
    } catch (error) {
      showError(error);
    }
  });
}

for (const [id, fn] of [['disconnect', 'disconnect'], ['reconnect', 'reconnect']]) {
  $(id).addEventListener('click', async () => {
    try {
      const updated = await window.relay[fn](state.session);
      $('session-status').textContent = updated.status;
      $('generation').textContent = String(updated.generation);
      state.generation = updated.generation;
    } catch (error) {
      showError(error);
    }
  });
}

window.addEventListener('DOMContentLoaded', async () => {
  try {
    const runtime = await window.relay.getDesktopState();
    renderDesktopRuntime(runtime);
    await loadSessions();
    const lastSession = localStorage.getItem(LAST_SESSION_KEY);
    if (lastSession && state.sessionsCache.some((s) => s.sessionId === lastSession)) {
      await selectSession(lastSession);
    }
  } catch {
    if ($('connect-drawer')) $('connect-drawer').open = true;
  }
});
