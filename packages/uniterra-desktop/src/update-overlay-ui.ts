/**
 * Static assets for the in-app update overlay (issue #15): the overlay page
 * and its sandboxed preload. Kept as embedded strings — no build step, no
 * external resources, no CSP issues — so the overlay works identically in dev
 * and packaged builds. Electron requires a file path for
 * `webPreferences.preload`, so main.ts writes the preload to disk at runtime
 * (userData) before creating the overlay window.
 */

/** Sandboxed preload for the overlay window: a tiny ipcRenderer bridge. */
export const UPDATE_OVERLAY_PRELOAD = `
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('uniterraUpdate', {
  onStatus: (callback) => {
    ipcRenderer.on('update:status', (_event, state) => callback(state));
  },
  retry: () => ipcRenderer.send('update:retry'),
  dismiss: () => ipcRenderer.send('update:dismiss'),
  openReleases: () => ipcRenderer.send('update:open-releases'),
});
`;

/** The overlay page: spinner + stage label during the run, the success copy on
 * completion, and retry/dismiss/releases buttons on failure (FR-15.1–15.6).
 * The Phase-1 message is the page's default so it renders before the first
 * state push from the main process. */
export const UPDATE_OVERLAY_HTML = `
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Updating Uniterra</title>
<style>
  :root {
    color-scheme: dark;
    --bg: #1b1c1f;
    --fg: #e8e8ea;
    --muted: #9aa0a6;
    --accent: #4f8cff;
    --border: #2d2f34;
    --danger: #e5534b;
    --ok: #3fb950;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { height: 100%; }
  body {
    background: var(--bg);
    color: var(--fg);
    font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    display: flex;
    align-items: center;
    justify-content: center;
    user-select: none;
  }
  .card { width: 100%; max-width: 420px; padding: 24px; }
  .row { display: flex; align-items: center; gap: 14px; }
  .spinner {
    width: 22px;
    height: 22px;
    flex: none;
    border: 3px solid var(--border);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.9s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .status { flex: 1; min-width: 0; }
  .status h1 { font-size: 14px; font-weight: 600; margin-bottom: 2px; }
  .status p { color: var(--muted); word-break: break-word; }
  .hint { margin-top: 14px; color: var(--muted); font-size: 12px; }
  .buttons { margin-top: 16px; display: none; gap: 8px; }
  .buttons.show { display: flex; flex-wrap: wrap; }
  button {
    background: var(--accent);
    color: #fff;
    border: 0;
    border-radius: 6px;
    padding: 7px 14px;
    font-size: 13px;
    cursor: pointer;
  }
  button.secondary {
    background: transparent;
    color: var(--fg);
    border: 1px solid var(--border);
  }
</style>
</head>
<body>
  <div class="card">
    <div class="row">
      <div class="spinner" id="spinner"></div>
      <div class="status">
        <h1 id="title">Updating Uniterra</h1>
        <p id="message">Initializing update... Do not close the application.</p>
      </div>
    </div>
    <p class="hint" id="hint">Do not close the application while the update is running.</p>
    <div class="buttons" id="buttons">
      <button id="retry">Retry</button>
      <button id="releases" class="secondary">Open releases page</button>
      <button id="dismiss" class="secondary">Dismiss</button>
    </div>
  </div>
  <script>
    (() => {
      const spinner = document.getElementById('spinner');
      const title = document.getElementById('title');
      const message = document.getElementById('message');
      const hint = document.getElementById('hint');
      const buttons = document.getElementById('buttons');
      const render = (state) => {
        message.textContent = state.message;
        if (state.phase === 'success') {
          spinner.style.display = 'none';
          title.textContent = 'Update complete';
          hint.style.display = 'none';
          buttons.classList.remove('show');
        } else if (state.phase === 'failure') {
          spinner.style.display = 'none';
          title.textContent = 'Update failed';
          hint.style.display = 'none';
          buttons.classList.add('show');
        } else {
          spinner.style.display = '';
          title.textContent = 'Updating Uniterra';
          hint.style.display = '';
          buttons.classList.remove('show');
        }
      };
      if (!window.uniterraUpdate) {
        message.textContent = 'Update UI failed to initialize.';
        return;
      }
      document.getElementById('retry').addEventListener('click', () => window.uniterraUpdate.retry());
      document.getElementById('releases').addEventListener('click', () => window.uniterraUpdate.openReleases());
      document.getElementById('dismiss').addEventListener('click', () => window.uniterraUpdate.dismiss());
      window.uniterraUpdate.onStatus(render);
    })();
  </script>
</body>
</html>
`;
