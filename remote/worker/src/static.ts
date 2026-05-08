export const INDEX_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>commute.kimiflare.com</title>
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
  </style>
</head>
<body>
  <div id="app"></div>
  <script>
    const app = document.getElementById('app');
    let currentUser = null;
    let allRepos = [];

    function showScreen(id) {
      document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
      document.getElementById(id).classList.add('active');
    }

    async function init() {
      try {
        const res = await fetch('/api/me', { credentials: 'include' });
        if (res.ok) {
          currentUser = await res.json();
          renderRepoPicker();
        } else {
          renderLanding();
        }
      } catch {
        renderLanding();
      }
    }

    function renderLanding() {
      app.innerHTML = \`
        <div id="landing" class="screen active">
          <h1>commute</h1>
          <p>KimiFlare in the browser. Pick a repo, get a sandbox.</p>
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

      try {
        const res = await fetch('/api/repos', { credentials: 'include' });
        const data = await res.json();
        allRepos = data.repos ?? [];
        renderRepoList(allRepos);
      } catch (err) {
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

    async function setupRepo(owner, name) {
      app.innerHTML = \`
        <div id="setup" class="screen active">
          <h1>Setting up...</h1>
          <p>Cloning <strong>\${owner}/\${name}</strong> into a Cloudflare Sandbox.</p>
          <div class="spinner"></div>
        </div>
      \`;

      try {
        const res = await fetch('/api/setup', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ owner, name }),
        });
        const data = await res.json();

        if (data.success) {
          app.innerHTML = \`
            <div id="result" class="screen active">
              <h1 class="success">Connected to \${owner}/\${name}</h1>
              <p>Sandbox is ready. Here's the latest commit history:</p>
              <div class="result-box"><pre>\${escapeHtml(data.output || '(no output)')}</pre></div>
              <button class="btn" onclick="renderRepoPicker()" style="margin-top:1.5rem;">Pick another repo</button>
            </div>
          \`;
        } else {
          app.innerHTML = \`
            <div id="result" class="screen active">
              <h1 class="error">Setup failed</h1>
              <p>\${escapeHtml(data.error || 'Unknown error')}</p>
              <button class="btn" onclick="renderRepoPicker()" style="margin-top:1.5rem;">Try again</button>
            </div>
          \`;
        }
      } catch (err) {
        app.innerHTML = \`
          <div id="result" class="screen active">
            <h1 class="error">Setup failed</h1>
            <p>\${escapeHtml(err.message)}</p>
            <button class="btn" onclick="renderRepoPicker()" style="margin-top:1.5rem;">Try again</button>
          </div>
        \`;
      }
    }

    async function logout() {
      await fetch('/auth/logout', { method: 'POST', credentials: 'include' });
      currentUser = null;
      allRepos = [];
      renderLanding();
    }

    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }

    init();
  </script>
</body>
</html>`;
