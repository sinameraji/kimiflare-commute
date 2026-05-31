export const INDEX_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>KimiFlare Commute</title>
  <link rel="icon" type="image/x-icon" href="https://kimiflare.com/favicon.ico">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/css/xterm.css">
  <script src="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/lib/xterm.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.10.0/lib/addon-fit.min.js"></script>
  <style>
    :root {
      --bg: #ffffff;
      --bg-raised: #f9fafb;
      --bg-sunken: #f3f4f6;
      --text: #111827;
      --text-muted: #6b7280;
      --text-faint: #9ca3af;
      --accent: #f48120;
      --accent-dim: rgba(244, 129, 32, 0.08);
      --accent-hover: #e06b0a;
      --border: #e5e7eb;
      --border-hover: #d1d5db;
      --success: #16a34a;
      --success-bg: #f0fdf4;
      --error: #dc2626;
      --error-bg: #fef2f2;
      --font-sans: 'Inter', system-ui, -apple-system, sans-serif;
      --font-mono: 'JetBrains Mono', 'SF Mono', monospace;
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html { scroll-behavior: smooth; }
    body {
      font-family: var(--font-sans);
      background: var(--bg);
      color: var(--text);
      line-height: 1.6;
      -webkit-font-smoothing: antialiased;
      height: 100vh;
      overflow: hidden;
    }
    ::selection { background: var(--accent-dim); color: var(--accent-hover); }

    /* ── Navigation ── */
    nav {
      position: fixed; top: 0; left: 0; right: 0; z-index: 100;
      padding: 1rem 2rem;
      display: flex; align-items: center; justify-content: space-between;
      background: rgba(255,255,255,0.85);
      backdrop-filter: blur(16px) saturate(1.2);
      border-bottom: 1px solid var(--border);
    }
    .logo {
      font-family: var(--font-mono); font-weight: 600; font-size: 1.05rem;
      color: var(--text); text-decoration: none;
      display: flex; align-items: center; gap: 0.6rem;
    }
    .logo-dot {
      width: 8px; height: 8px; border-radius: 50%; background: var(--accent);
      display: inline-block;
    }
    .nav-links { display: flex; align-items: center; gap: 1.5rem; }
    .nav-links a {
      font-size: 0.875rem; color: var(--text-muted); text-decoration: none;
      font-weight: 500; transition: color 0.2s;
    }
    .nav-links a:hover { color: var(--text); }

    /* ── Layout ── */
    #app {
      height: 100vh; padding-top: 64px;
      display: flex; flex-direction: column;
    }
    .screen { display: none; flex: 1; overflow-y: auto; }
    .screen.active { display: flex; flex-direction: column; }

    /* ── Landing ── */
    .landing-wrap {
      flex: 1; display: flex; flex-direction: column;
      align-items: center; justify-content: center;
      padding: 2rem; text-align: center;
    }
    .landing-wrap h1 {
      font-size: clamp(2rem, 5vw, 3.5rem); font-weight: 700;
      letter-spacing: -0.02em; line-height: 1.15; margin-bottom: 1rem;
    }
    .landing-wrap h1 span { color: var(--accent); }
    .landing-wrap .subtitle {
      font-size: 1.125rem; color: var(--text-muted);
      max-width: 480px; margin-bottom: 2rem;
    }
    .btn-primary {
      display: inline-flex; align-items: center; gap: 0.5rem;
      padding: 0.875rem 1.75rem; border-radius: 8px;
      background: var(--accent); color: #fff;
      font-size: 1rem; font-weight: 600;
      border: none; cursor: pointer; text-decoration: none;
      transition: all 0.2s; box-shadow: 0 1px 2px rgba(0,0,0,0.05);
    }
    .btn-primary:hover { background: var(--accent-hover); transform: translateY(-1px); }
    .btn-primary svg { width: 20px; height: 20px; }
    .btn-ghost {
      display: inline-flex; align-items: center; gap: 0.5rem;
      padding: 0.625rem 1rem; border-radius: 6px;
      background: transparent; color: var(--text-muted);
      font-size: 0.875rem; font-weight: 500;
      border: 1px solid var(--border); cursor: pointer;
      transition: all 0.2s;
    }
    .btn-ghost:hover { background: var(--bg-raised); color: var(--text); }

    /* ── Repo Picker ── */
    .repo-wrap {
      flex: 1; max-width: 640px; width: 100%; margin: 0 auto;
      padding: 2rem 1.5rem;
    }
    .repo-header {
      display: flex; align-items: center; justify-content: space-between;
      margin-bottom: 1.5rem;
    }
    .repo-header h2 { font-size: 1.25rem; font-weight: 600; }
    .repo-header .user {
      display: flex; align-items: center; gap: 0.5rem;
      font-size: 0.875rem; color: var(--text-muted);
    }
    .repo-header .user img {
      width: 24px; height: 24px; border-radius: 50%;
    }
    .search-box {
      width: 100%; padding: 0.75rem 1rem; border-radius: 8px;
      border: 1px solid var(--border); background: var(--bg);
      color: var(--text); font-size: 0.9375rem; font-family: var(--font-sans);
      margin-bottom: 1rem; transition: border-color 0.2s, box-shadow 0.2s;
    }
    .search-box:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-dim); }
    .search-box::placeholder { color: var(--text-faint); }
    .repo-list { display: flex; flex-direction: column; gap: 0.5rem; }
    .repo-item {
      padding: 0.875rem 1rem; border-radius: 8px;
      background: var(--bg-raised); border: 1px solid var(--border);
      cursor: pointer; transition: all 0.15s;
      display: flex; flex-direction: column; gap: 0.25rem;
    }
    .repo-item:hover {
      border-color: var(--border-hover);
      background: #fff;
      box-shadow: 0 1px 3px rgba(0,0,0,0.04);
    }
    .repo-item .name {
      font-weight: 500; font-size: 0.9375rem;
      display: flex; align-items: center; gap: 0.5rem;
    }
    .repo-item .meta {
      font-size: 0.8125rem; color: var(--text-muted);
    }
    .private-badge {
      display: inline-block; padding: 0.1rem 0.4rem; border-radius: 4px;
      background: var(--bg-sunken); color: var(--text-muted);
      font-size: 0.6875rem; font-weight: 500;
    }
    .empty-state {
      text-align: center; color: var(--text-faint); padding: 3rem 1rem;
    }

    /* ── Setup Progress ── */
    .setup-wrap {
      flex: 1; max-width: 560px; width: 100%; margin: 0 auto;
      padding: 2rem 1.5rem;
    }
    .setup-wrap h1 { font-size: 1.5rem; font-weight: 700; margin-bottom: 0.25rem; }
    .setup-wrap .subtitle { color: var(--text-muted); margin-bottom: 1.5rem; font-size: 0.9375rem; }
    .progress-list { display: flex; flex-direction: column; gap: 0.5rem; }
    .progress-step {
      border-radius: 10px; border: 1px solid var(--border);
      background: var(--bg-raised); overflow: hidden;
      transition: all 0.3s ease;
    }
    .progress-step.completed { border-color: #bbf7d0; background: var(--success-bg); }
    .progress-step.active { border-color: #fed7aa; background: #fff7ed; }
    .progress-step.error { border-color: #fecaca; background: var(--error-bg); }
    .step-header {
      display: flex; align-items: center; gap: 0.75rem;
      padding: 0.875rem 1rem;
    }
    .step-icon {
      width: 22px; height: 22px; display: flex;
      align-items: center; justify-content: center; flex-shrink: 0;
    }
    .step-icon svg { width: 16px; height: 16px; }
    .step-spinner {
      width: 16px; height: 16px;
      border: 2px solid var(--border); border-top-color: var(--accent);
      border-radius: 50%; animation: spin 1s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .step-label { flex: 1; font-size: 0.9375rem; font-weight: 500; }
    .step-status {
      font-size: 0.75rem; font-weight: 600; text-transform: uppercase;
      letter-spacing: 0.03em; padding: 0.2rem 0.5rem; border-radius: 4px;
    }
    .step-status.done { color: var(--success); background: #dcfce7; }
    .step-status.run { color: var(--accent); background: #ffedd5; }
    .step-status.fail { color: var(--error); background: #fee2e2; }
    .step-status.wait { color: var(--text-faint); background: var(--bg-sunken); }

    /* ── Sub-logs ── */
    .step-logs {
      padding: 0 1rem 0.75rem 2.625rem;
      display: flex; flex-direction: column; gap: 0.35rem;
    }
    .step-logs:empty { display: none; }
    .log-line {
      font-family: var(--font-mono); font-size: 0.78rem;
      color: var(--text-muted); line-height: 1.5;
      opacity: 0; transform: translateY(4px);
      animation: logFadeIn 0.35s ease forwards;
    }
    @keyframes logFadeIn {
      to { opacity: 1; transform: translateY(0); }
    }
    .log-line::before {
      content: "›"; color: var(--accent); margin-right: 0.5rem;
      font-weight: 500;
    }
    .setup-error {
      margin-top: 1rem; padding: 1rem; border-radius: 8px;
      background: var(--error-bg); border: 1px solid #fecaca;
      color: var(--error); font-size: 0.875rem;
    }
    .setup-success {
      margin-top: 1rem; padding: 1rem; border-radius: 8px;
      background: var(--success-bg); border: 1px solid #bbf7d0;
      color: var(--success); font-size: 0.875rem; text-align: center;
    }

    /* ── Terminal ── */
    #terminal-screen { max-width: none; width: 100%; height: 100vh; padding: 0; }
    #terminal-screen .term-header {
      display: flex; justify-content: space-between; align-items: center;
      padding: 0.625rem 1rem;
      background: var(--bg-raised); border-bottom: 1px solid var(--border);
    }
    #terminal-screen .term-header span {
      font-size: 0.875rem; font-weight: 500; color: var(--text-muted);
      font-family: var(--font-mono);
    }
    #terminal-container { flex: 1; padding: 0.5rem; background: #0d1117; }
    .xterm { height: 100%; }

    /* ── Spinner ── */
    .spinner-wrap {
      display: flex; align-items: center; justify-content: center;
      padding: 3rem;
    }
    .spinner {
      width: 32px; height: 32px;
      border: 3px solid var(--border); border-top-color: var(--accent);
      border-radius: 50%; animation: spin 0.8s linear infinite;
    }
  </style>
</head>
<body>
  <nav>
    <a href="/" class="logo"><span class="logo-dot"></span>KimiFlare Commute</a>
    <div class="nav-links" id="nav-links"></div>
  </nav>
  <div id="app"></div>
  <script>
    const app = document.getElementById('app');
    const navLinks = document.getElementById('nav-links');
    let currentUser = null;
    let allRepos = [];
    let lastLogs = [];

    function clog(label, data) {
      console.log('[Client]', label, data);
    }

    function showScreen(id) {
      document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
      const el = document.getElementById(id);
      if (el) el.classList.add('active');
    }

    function setNav(user) {
      if (user) {
        navLinks.innerHTML = \`
          <span style="font-size:0.875rem;color:var(--text-muted);">\${user.login}</span>
          <button class="btn-ghost" onclick="logout()">Log out</button>
        \`;
      } else {
        navLinks.innerHTML = '';
      }
    }

    async function init() {
      clog('init — checking /api/me');
      try {
        const res = await fetch('/api/me', { credentials: 'include' });
        clog('init — /api/me response', { status: res.status, ok: res.ok });
        if (res.ok) {
          currentUser = await res.json();
          clog('init — logged in', currentUser);
          setNav(currentUser);
          renderRepoPicker();
        } else {
          clog('init — not logged in');
          setNav(null);
          renderLanding();
        }
      } catch (err) {
        clog('init — /api/me ERROR', err.message);
        setNav(null);
        renderLanding();
      }
    }

    function renderLanding() {
      app.innerHTML = \`
        <div id="landing" class="screen active">
          <div class="landing-wrap">
            <h1>Code anywhere with <span>KimiFlare</span></h1>
            <p class="subtitle">Pick any GitHub repo, get an instant terminal sandbox with KimiFlare pre-installed and ready to go.</p>
            <a class="btn-primary" href="/auth/github">
              <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/></svg>
              Log in with GitHub
            </a>
          </div>
        </div>
      \`;
    }

    async function renderRepoPicker() {
      app.innerHTML = \`
        <div id="repos" class="screen active">
          <div class="repo-wrap">
            <div class="repo-header">
              <h2>Your repositories</h2>
              <div class="user">
                <img src="\${currentUser.avatar_url}" alt="">
                <span>\${currentUser.login}</span>
              </div>
            </div>
            <input type="text" class="search-box" id="repo-search" placeholder="Search repositories...">
            <div class="repo-list" id="repo-list">
              <div class="spinner-wrap"><div class="spinner"></div></div>
            </div>
          </div>
        </div>
      \`;

      clog('renderRepoPicker — fetching /api/repos');
      try {
        const res = await fetch('/api/repos', { credentials: 'include' });
        clog('renderRepoPicker — /api/repos response', { status: res.status, ok: res.ok });
        const data = await res.json();
        clog('renderRepoPicker — /api/repos data', { repoCount: data.repos?.length, error: data.error });
        allRepos = data.repos ?? [];
        renderRepoList(allRepos);
      } catch (err) {
        clog('renderRepoPicker — /api/repos ERROR', err.message);
        document.getElementById('repo-list').innerHTML = '<div class="empty-state">Failed to load repos</div>';
      }

      document.getElementById('repo-search').addEventListener('input', (e) => {
        const q = e.target.value.toLowerCase();
        renderRepoList(allRepos.filter(r => r.full_name.toLowerCase().includes(q)));
      });
    }

    function renderRepoList(repos) {
      const list = document.getElementById('repo-list');
      if (repos.length === 0) {
        list.innerHTML = '<div class="empty-state">No repos found</div>';
        return;
      }
      list.innerHTML = repos.map(r => \`
        <div class="repo-item" data-owner="\${r.owner.login}" data-name="\${r.name}">
          <div class="name">
            \${r.full_name}
            \${r.private ? '<span class="private-badge">Private</span>' : ''}
          </div>
          <div class="meta">\${r.description || 'No description'}</div>
        </div>
      \`).join('');
      list.querySelectorAll('.repo-item').forEach(el => {
        el.addEventListener('click', () => setupRepo(el.dataset.owner, el.dataset.name));
      });
    }

    const STEP_ORDER = [
      { key: 'import', label: 'Preparing repository' },
      { key: 'token', label: 'Authenticating with repository' },
      { key: 'sandbox', label: 'Starting Cloudflare Sandbox' },
      { key: 'clone', label: 'Cloning repository into sandbox' },
      { key: 'verify', label: 'Verifying repository' },
      { key: 'install', label: 'Installing KimiFlare' },
      { key: 'config', label: 'Configuring Cloudflare credentials' },
      { key: 'finalize', label: 'Finalizing session' },
    ];

    function renderSetupProgress(completedSteps, activeStep, errorStep, errorMessage, logs) {
      const list = document.getElementById('progress-list');
      if (!list) return;

      // Track which logs we've already rendered to avoid re-animating
      const newLogs = logs || [];
      const prevLen = lastLogs.length;
      lastLogs = newLogs;

      list.innerHTML = STEP_ORDER.map((s) => {
        const isCompleted = completedSteps.includes(s.key);
        const isActive = activeStep === s.key;
        const isError = errorStep === s.key;
        const isPending = !isCompleted && !isActive && !isError;

        let icon;
        if (isError) {
          icon = '<svg viewBox="0 0 16 16" fill="#dc2626"><path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.749.749 0 0 1 1.275.326.749.749 0 0 1-.215.734L9.06 8l3.22 3.22a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215L8 9.06l-3.22 3.22a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z"/></svg>';
        } else if (isCompleted) {
          icon = '<svg viewBox="0 0 16 16" fill="#16a34a"><path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z"/></svg>';
        } else if (isActive) {
          icon = '<div class="step-spinner"></div>';
        } else {
          icon = '<span style="width:14px;height:14px;border:2px solid var(--border);border-radius:50%;display:block;"></span>';
        }

        const cls = isError ? 'error' : isActive ? 'active' : isCompleted ? 'completed' : '';
        const statusBadge = isCompleted
          ? '<span class="step-status done">Done</span>'
          : isActive
          ? '<span class="step-status run">Running</span>'
          : isError
          ? '<span class="step-status fail">Failed</span>'
          : '<span class="step-status wait">Waiting</span>';

        // Only show logs for the active step
        const stepLogs = isActive ? newLogs : [];
        const logsHtml = stepLogs.map((l, i) => {
          // Only animate logs that are new since last render
          const isNew = i >= prevLen;
          const delay = isNew ? (i - prevLen) * 0.12 : 0;
          const style = isNew ? 'animation-delay:' + delay + 's' : 'animation:none;opacity:1;transform:none;';
          return \`<div class="log-line" style="\${style}">\${escapeHtml(l)}</div>\`;
        }).join('');

        return \`
          <div class="progress-step \${cls}">
            <div class="step-header">
              <div class="step-icon">\${icon}</div>
              <div class="step-label">\${s.label}</div>
              \${statusBadge}
            </div>
            \${logsHtml ? \`<div class="step-logs">\${logsHtml}</div>\` : ''}
          </div>
        \`;
      }).join('');

      const errorBox = document.getElementById('setup-error');
      if (errorBox) {
        if (errorMessage) {
          errorBox.innerHTML = escapeHtml(errorMessage);
          errorBox.style.display = 'block';
        } else {
          errorBox.style.display = 'none';
        }
      }
    }

    async function setupRepo(owner, name, force = false) {
      clog('setupRepo — starting', { owner, name, force });
      lastLogs = [];
      app.innerHTML = \`
        <div id="setup" class="screen active">
          <div class="setup-wrap">
            <h1>\${force ? 'Resetting' : 'Setting up'}</h1>
            <p class="subtitle">Cloning <strong>\${owner}/\${name}</strong> into a Cloudflare Sandbox.</p>
            <div id="progress-list" class="progress-list"></div>
            <div id="setup-error" class="setup-error" style="display:none;"></div>
            <div id="setup-actions" style="margin-top:1.5rem;text-align:center;"></div>
          </div>
        </div>
      \`;
      renderSetupProgress([], 'import', null, null, []);

      let sessionId;
      try {
        clog('setupRepo — POST /api/setup', { owner, name, force });
        const res = await fetch('/api/setup', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ owner, name, force }),
        });
        clog('setupRepo — /api/setup response', { status: res.status, ok: res.ok });

        let data;
        try {
          data = await res.json();
        } catch (parseErr) {
          const text = await res.text();
          clog('setupRepo — /api/setup JSON parse FAIL', { text: text.slice(0, 500) });
          throw new Error('Server returned non-JSON: ' + text.slice(0, 200));
        }

        clog('setupRepo — /api/setup data', data);

        if (data.error) {
          throw new Error(data.error);
        }

        sessionId = data.sessionId;
        if (!sessionId) {
          throw new Error('No sessionId returned from server');
        }

        // Poll progress until complete or error
        const pollInterval = setInterval(async () => {
          try {
            const pres = await fetch(\`/api/setup/progress/\${sessionId}\`, { credentials: 'include' });
            if (!pres.ok) return;
            const progress = await pres.json();
            clog('setupRepo — progress', progress);

            renderSetupProgress(
              progress.completedSteps || [],
              progress.status === 'complete' ? null : progress.step,
              progress.status === 'error' ? progress.step : null,
              progress.error,
              progress.logs || []
            );

            if (progress.status === 'complete') {
              clearInterval(pollInterval);
              clog('setupRepo — SUCCESS', { sessionId });
              setTimeout(() => renderTerminal(sessionId, owner, name), 400);
            } else if (progress.status === 'error') {
              clearInterval(pollInterval);
              const actions = document.getElementById('setup-actions');
              if (actions) {
                actions.innerHTML = \`<button class="btn-ghost" onclick="renderRepoPicker()">← Back to repos</button>\`;
              }
            }
          } catch (pollErr) {
            clog('setupRepo — poll error', pollErr.message);
          }
        }, 700);

        // Safety timeout: stop polling after 5 minutes
        setTimeout(() => {
          clearInterval(pollInterval);
          clog('setupRepo — poll timeout');
        }, 5 * 60 * 1000);

      } catch (err) {
        clog('setupRepo — ERROR', err.message);
        renderSetupProgress([], null, 'import', err.message, []);
        const actions = document.getElementById('setup-actions');
        if (actions) {
          actions.innerHTML = \`<button class="btn-ghost" onclick="renderRepoPicker()">← Back to repos</button>\`;
        }
      }
    }

    function renderTerminal(sessionId, owner, name) {
      clog('renderTerminal', { sessionId, owner, name });
      app.innerHTML = \`
        <div id="terminal-screen" class="screen active">
          <div class="term-header">
            <span>\${owner}/\${name}</span>
            <div style="display:flex;gap:0.5rem;">
              <button class="btn-ghost" onclick="setupRepo('\${owner}', '\${name}', true)">Reset & Reclone</button>
              <button class="btn-ghost" onclick="disconnectRepo('\${sessionId}', '\${owner}', '\${name}')" style="color:var(--error);">Disconnect</button>
              <button class="btn-ghost" onclick="renderRepoPicker()">Close</button>
            </div>
          </div>
          <div id="terminal-container"></div>
        </div>
      \`;

      const term = new Terminal({
        fontSize: 14,
        fontFamily: '"JetBrains Mono", "SF Mono", Monaco, monospace',
        theme: { background: '#0d1117', foreground: '#c9d1d9', cursor: '#58a6ff' },
        cursorBlink: true,
      });
      const fitAddon = new FitAddon.FitAddon();
      term.loadAddon(fitAddon);
      term.open(document.getElementById('terminal-container'));
      fitAddon.fit();

      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = \`\${protocol}//\${location.host}/ws/\${sessionId}?cols=\${term.cols}&rows=\${term.rows}\`;
      clog('renderTerminal — WebSocket URL', wsUrl);

      const ws = new WebSocket(wsUrl);
      ws.binaryType = 'arraybuffer';

      ws.onopen = () => { clog('WebSocket — OPEN'); };
      ws.onmessage = (e) => {
        if (e.data instanceof ArrayBuffer) {
          term.write(new Uint8Array(e.data));
        } else {
          try {
            const msg = JSON.parse(e.data);
            if (msg.type === 'resize') { clog('WebSocket — resize msg', msg); }
          } catch { term.write(e.data); }
        }
      };
      ws.onerror = (e) => {
        clog('WebSocket — ERROR', e);
        term.writeln('\\r\\n[Connection error]');
      };
      ws.onclose = (e) => {
        clog('WebSocket — CLOSE', { code: e.code, reason: e.reason, wasClean: e.wasClean });
        term.writeln('\\r\\n[Connection closed]');
      };
      term.onData((data) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(new TextEncoder().encode(data));
        }
      });
      term.onResize(({ cols, rows }) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'resize', cols, rows }));
        }
      });
      window.addEventListener('resize', () => fitAddon.fit());
    }

    async function logout() {
      clog('logout');
      await fetch('/auth/logout', { method: 'POST', credentials: 'include' });
      currentUser = null;
      setNav(null);
      renderLanding();
    }

    async function disconnectRepo(sessionId, owner, name) {
      if (!confirm('Disconnect this repository? This deletes the sandbox and artifact copy, but will not affect your GitHub repository.')) {
        return;
      }
      clog('disconnectRepo — starting', { sessionId, owner, name });
      try {
        const res = await fetch(\`/api/disconnect/\${sessionId}\`, {
          method: 'POST',
          credentials: 'include',
        });
        const data = await res.json();
        if (data.success) {
          clog('disconnectRepo — success');
          renderRepoPicker();
        } else {
          alert('Disconnect failed: ' + (data.error || 'Unknown error'));
        }
      } catch (err) {
        clog('disconnectRepo — ERROR', err.message);
        alert('Disconnect failed: ' + err.message);
      }
    }

    function escapeHtml(str) {
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    init();
  </script>
</body>
</html>
`;
