export const INDEX_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Commute</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/css/xterm.css">
  <script src="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/lib/xterm.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.10.0/lib/addon-fit.min.js"></script>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0d1117;
      color: #c9d1d9;
      height: 100vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    #app { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 2rem; }
    .screen { display: none; width: 100%; max-width: 640px; }
    .screen.active { display: flex; flex-direction: column; }
    h1 { font-size: 1.75rem; font-weight: 600; margin-bottom: 0.5rem; text-align: center; }
    p { color: #8b949e; margin-bottom: 1.5rem; text-align: center; }
    .btn {
      display: inline-flex; align-items: center; gap: 0.5rem;
      padding: 0.75rem 1.5rem; border-radius: 6px; border: 1px solid #c9d1d9;
      background: #0d1117; color: #c9d1d9; font-size: 1rem; font-weight: 500;
      cursor: pointer; transition: all 0.2s; text-decoration: none;
    }
    .btn:hover { background: #c9d1d9; color: #0d1117; }
    .btn:disabled { opacity: 0.4; cursor: not-allowed; border-color: #30363d; color: #484f58; }
    .search-box {
      width: 100%; padding: 0.75rem 1rem; border-radius: 6px;
      border: 1px solid #30363d; background: #161b22; color: #c9d1d9;
      font-size: 1rem; margin-bottom: 1rem;
    }
    .search-box:focus { outline: none; border-color: #58a6ff; }
    .repo-list { flex: 1; overflow-y: auto; max-height: 60vh; }
    .repo-item {
      padding: 0.75rem 1rem; border-radius: 6px; cursor: pointer;
      transition: background 0.15s; border-bottom: 1px solid #21262d;
    }
    .repo-item:hover { background: #161b22; }
    .repo-item .name { font-weight: 500; }
    .repo-item .meta { font-size: 0.8125rem; color: #8b949e; margin-top: 0.25rem; }
    .repo-item .private-badge {
      display: inline-block; padding: 0.125rem 0.375rem; border-radius: 4px;
      background: #30363d; color: #c9d1d9; font-size: 0.6875rem; margin-left: 0.5rem;
    }
    .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem; }
    .header h2 { font-size: 1.25rem; }
    .logout { font-size: 0.875rem; color: #8b949e; cursor: pointer; background: none; border: none; }
    .logout:hover { color: #f85149; }
    .spinner { width: 40px; height: 40px; border: 3px solid #30363d; border-top-color: #58a6ff; border-radius: 50%; animation: spin 1s linear infinite; margin: 2rem auto; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .result-box { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 1rem; margin-top: 1rem; }
    .result-box pre { font-family: 'SF Mono', Monaco, monospace; font-size: 0.875rem; line-height: 1.5; white-space: pre-wrap; word-break: break-word; color: #c9d1d9; }
    .error { color: #f85149; text-align: center; }
    .success { color: #3fb950; text-align: center; }
    .progress-list { display: flex; flex-direction: column; gap: 0.5rem; margin-top: 1rem; }
    .progress-step {
      display: flex; align-items: center; gap: 0.75rem;
      padding: 0.625rem 1rem; border-radius: 6px;
      background: #161b22; border: 1px solid #21262d;
      font-size: 0.9375rem; color: #8b949e;
      transition: all 0.3s ease;
    }
    .progress-step.completed { color: #3fb950; border-color: #238636; background: #0d1f0d; }
    .progress-step.active { color: #c9d1d9; border-color: #58a6ff; background: #0d1f3d; }
    .progress-step.error { color: #f85149; border-color: #da3633; background: #3d0d0d; }
    .step-icon { width: 20px; height: 20px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
    .step-icon svg { width: 16px; height: 16px; }
    .step-spinner { width: 14px; height: 14px; border: 2px solid #30363d; border-top-color: #58a6ff; border-radius: 50%; animation: spin 1s linear infinite; }
    .step-label { flex: 1; }
    .step-detail { font-size: 0.8125rem; color: #8b949e; margin-top: 0.25rem; }
    #terminal-screen { max-width: none; width: 100%; height: 100vh; padding: 0; }
    #terminal-screen .term-header {
      display: flex; justify-content: space-between; align-items: center;
      padding: 0.5rem 1rem; background: #161b22; border-bottom: 1px solid #30363d;
    }
    #terminal-screen .term-header span { font-size: 0.875rem; color: #8b949e; }
    #terminal-screen .term-header button { font-size: 0.875rem; }
    #terminal-container { flex: 1; padding: 0.5rem; }
    .xterm { height: 100%; }
  </style>
</head>
<body>
  <div id="app"></div>
  <script>
    const app = document.getElementById('app');
    let currentUser = null;
    let allRepos = [];

    function clog(label, data) {
      console.log('[Client]', label, data);
    }

    function showScreen(id) {
      document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
      document.getElementById(id).classList.add('active');
    }

    async function init() {
      clog('init — checking /api/me');
      try {
        const res = await fetch('/api/me', { credentials: 'include' });
        clog('init — /api/me response', { status: res.status, ok: res.ok });
        if (res.ok) {
          currentUser = await res.json();
          clog('init — logged in', currentUser);
          renderRepoPicker();
        } else {
          clog('init — not logged in');
          renderLanding();
        }
      } catch (err) {
        clog('init — /api/me ERROR', err.message);
        renderLanding();
      }
    }

    function renderLanding() {
      app.innerHTML = \`
        <div id="landing" class="screen active">
          <h1>Commute</h1>
          <p>Pick a repo, get a sandbox.</p>
          <a class="btn" href="/auth/github">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/></svg>
            Log in with GitHub
          </a>
        </div>
      \`;
    }

    async function renderRepoPicker() {
      app.innerHTML = \`
        <div id="repos" class="screen active">
          <div class="header">
            <h2>\${currentUser.login}</h2>
            <button class="logout" onclick="logout()">Log out</button>
          </div>
          <input type="text" class="search-box" id="repo-search" placeholder="Search repositories...">
          <div class="repo-list" id="repo-list"><div class="spinner"></div></div>
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
        document.getElementById('repo-list').innerHTML = '<div class="error">Failed to load repos</div>';
      }

      document.getElementById('repo-search').addEventListener('input', (e) => {
        const q = e.target.value.toLowerCase();
        renderRepoList(allRepos.filter(r => r.full_name.toLowerCase().includes(q)));
      });
    }

    function renderRepoList(repos) {
      const list = document.getElementById('repo-list');
      if (repos.length === 0) {
        list.innerHTML = '<div style="text-align:center;color:#8b949e;padding:2rem;">No repos found</div>';
        return;
      }
      list.innerHTML = repos.map(r => \`
        <div class="repo-item" data-owner="\${r.owner.login}" data-name="\${r.name}">
          <div class="name">\${r.full_name}\${r.private ? '<span class="private-badge">Private</span>' : ''}</div>
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
      { key: 'install', label: 'Installing KimiFleur' },
      { key: 'config', label: 'Configuring Cloudflare credentials' },
      { key: 'finalize', label: 'Finalizing session' },
    ];

    function renderSetupProgress(completedSteps, activeStep, errorStep, errorMessage) {
      const list = document.getElementById('progress-list');
      if (!list) return;
      list.innerHTML = STEP_ORDER.map((s, idx) => {
        const isCompleted = completedSteps.includes(s.key);
        const isActive = activeStep === s.key;
        const isError = errorStep === s.key;
        let icon;
        if (isError) {
          icon = '<svg viewBox="0 0 16 16" fill="#f85149"><path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.749.749 0 0 1 1.275.326.749.749 0 0 1-.215.734L9.06 8l3.22 3.22a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215L8 9.06l-3.22 3.22a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z"/></svg>';
        } else if (isCompleted) {
          icon = '<svg viewBox="0 0 16 16" fill="#3fb950"><path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z"/></svg>';
        } else if (isActive) {
          icon = '<div class="step-spinner"></div>';
        } else {
          icon = '<span style="width:14px;height:14px;border:2px solid #30363d;border-radius:50%;display:block;"></span>';
        }
        const cls = isError ? 'error' : isActive ? 'active' : isCompleted ? 'completed' : '';
        return \`<div class="progress-step \${cls}"><div class="step-icon">\${icon}</div><div class="step-label">\${s.label}</div></div>\`;
      }).join('');

      const detail = document.getElementById('progress-detail');
      if (detail) {
        if (errorMessage) {
          detail.innerHTML = \`<span class="error">\${escapeHtml(errorMessage)}</span>\`;
        } else if (activeStep) {
          const step = STEP_ORDER.find(s => s.key === activeStep);
          detail.textContent = step ? step.label + '...' : '';
        } else {
          detail.textContent = '';
        }
      }
    }

    async function setupRepo(owner, name) {
      clog('setupRepo — starting', { owner, name });
      app.innerHTML = \`
        <div id="setup" class="screen active">
          <h1>Setting up...</h1>
          <p>Cloning <strong>\${owner}/\${name}</strong> into a Cloudflare Sandbox.</p>
          <div id="progress-list" class="progress-list"></div>
          <div id="progress-detail" class="step-detail" style="text-align:center;margin-top:1rem;"></div>
        </div>
      \`;
      renderSetupProgress([], 'import', null, null);

      let sessionId;
      try {
        clog('setupRepo — POST /api/setup', { owner, name });
        const res = await fetch('/api/setup', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ owner, name }),
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
              progress.error
            );

            if (progress.status === 'complete') {
              clearInterval(pollInterval);
              clog('setupRepo — SUCCESS', { sessionId });
              renderTerminal(sessionId, owner, name);
            } else if (progress.status === 'error') {
              clearInterval(pollInterval);
              throw new Error(progress.error || 'Setup failed');
            }
          } catch (pollErr) {
            clog('setupRepo — poll error', pollErr.message);
          }
        }, 800);

        // Safety timeout: stop polling after 5 minutes
        setTimeout(() => {
          clearInterval(pollInterval);
          clog('setupRepo — poll timeout');
        }, 5 * 60 * 1000);

      } catch (err) {
        clog('setupRepo — ERROR', err.message);
        renderSetupProgress([], null, 'import', err.message);
        app.innerHTML += \`
          <div style="text-align:center;margin-top:1.5rem;">
            <button class="btn" onclick="renderRepoPicker()">Try again</button>
          </div>
        \`;
      }
    }

    function renderTerminal(sessionId, owner, name) {
      clog('renderTerminal', { sessionId, owner, name });
      app.innerHTML = \`
        <div id="terminal-screen" class="screen active">
          <div class="term-header">
            <span>\${owner}/\${name}</span>
            <button class="logout" onclick="renderRepoPicker()">Close</button>
          </div>
          <div id="terminal-container"></div>
        </div>
      \`;

      const term = new Terminal({
        fontSize: 14,
        fontFamily: '"SF Mono", Monaco, "Cascadia Code", monospace',
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

      ws.onopen = () => {
        clog('WebSocket — OPEN');
      };

      ws.onmessage = (e) => {
        if (e.data instanceof ArrayBuffer) {
          term.write(new Uint8Array(e.data));
        } else {
          try {
            const msg = JSON.parse(e.data);
            if (msg.type === 'resize') {
              clog('WebSocket — resize msg', msg);
            }
          } catch {
            term.write(e.data);
          }
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

      window.addEventListener('resize', () => {
        fitAddon.fit();
      });
    }

    async function logout() {
      clog('logout');
      await fetch('/auth/logout', { method: 'POST', credentials: 'include' });
      currentUser = null;
      renderLanding();
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
