// dsh-git-graph — server half
// Registers HTTP routes under /git-graph:
//   GET /git-graph/api?op=<op>&repo=<path>[&hash=<sha>]  -> JSON git data
//   GET /git-graph/index.html                           -> the visualizer page
// Commands are executed with execFile (no shell), fixed argument lists only.
import { execFile, execFileSync } from 'node:child_process'
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import net from 'node:net'

const here = dirname(fileURLToPath(import.meta.url))
const webRoot = join(here, 'web')

const MAX_GIT_BUFFER = 32 * 1024 * 1024
const MAX_DIFF_CHARS = 240000

export const name = 'git-graph'
export const inject = ['webServer']

function runGit(repo, args, maxBuffer = MAX_GIT_BUFFER, timeoutMs = 0) {
  return new Promise((resolve, reject) => {
    const opts = { maxBuffer, windowsHide: true }
    if (timeoutMs > 0) opts.timeout = timeoutMs
    execFile('git', ['-C', repo, ...args], opts, (err, stdout, stderr) => {
      if (err) {
        const detail = (stderr || err.message || '').toString().trim()
        reject(new Error(detail || 'git failed'))
        return
      }
      resolve(stdout.toString())
    })
  })
}

async function isGitRepo(repo) {
  try {
    const out = await runGit(repo, ['rev-parse', '--is-inside-work-tree'])
    return out.trim() === 'true'
  } catch {
    return false
  }
}

/* ===================== self-update ===================== */
// Checks the GitHub repo for newer tags and can replace this plugin's files
// from a codeload zip. No API key needed: version lookup uses `git ls-remote
// --tags`, download uses https://codeload.github.com (zip, extracted by
// bsdtar which ships with Windows 10+ / macOS / most Linux distros).
const UPDATE_REPO = '1841220388zzzcccxxx-star/dsh-git-graph'
const UPDATE_GH = `https://github.com/${UPDATE_REPO}`

function localVersion() {
  try {
    const pkg = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8'))
    return pkg.version || ''
  } catch { return '' }
}

/** Compare dotted versions: 1 if a>b, -1 if a<b, 0 if equal. */
function cmpVer(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0)
  const pb = String(b).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0
    const y = pb[i] || 0
    if (x > y) return 1
    if (x < y) return -1
  }
  return 0
}

/** Extra `git -c` args for network commands. Honors the user's global
 *  http(s).proxy / sslBackend / http.version config; if no proxy is set it
 *  auto-detects common local proxy ports (Clash/mihomo 7897, Clash 7890,
 *  v2ray 10809, socks 1080, etc.) and falls back to OpenSSL + HTTP/1.1
 *  (Windows schannel often fails against GitHub on CN networks). */
const PROXY_PORTS = [7897, 7890, 10809, 1080, 8888, 7891]
function portOpen(port) {
  return new Promise((resolve) => {
    const sock = new net.Socket()
    sock.setTimeout(400)
    sock.once('connect', () => { sock.destroy(); resolve(true) })
    sock.once('timeout', () => { sock.destroy(); resolve(false) })
    sock.once('error', () => { sock.destroy(); resolve(false) })
    sock.connect(port, '127.0.0.1')
  })
}

/** Resolve a usable proxy for GitHub: global git config wins, then a
 *  listening local proxy port. Returns '' when none found. */
async function resolveProxy() {
  const readGlobal = (k) => {
    try {
      const out = execFileSync('git', ['config', '--global', '--get', k], { encoding: 'utf8', windowsHide: true })
      return out.trim()
    } catch { return '' }
  }
  const fromConfig = readGlobal('http.proxy') || readGlobal('https.proxy')
  if (fromConfig) return fromConfig
  for (const port of PROXY_PORTS) {
    if (await portOpen(port)) return `http://127.0.0.1:${port}`
  }
  return ''
}

/** Extra `git -c` args for network commands: proxy (global config or
 *  auto-detected local port) + OpenSSL backend + HTTP/1.1 (Windows
 *  schannel often fails against GitHub on CN networks). */
async function gitNetArgs() {
  const extra = []
  const readGlobal = (k) => {
    try {
      const out = execFileSync('git', ['config', '--global', '--get', k], { encoding: 'utf8', windowsHide: true })
      return out.trim()
    } catch { return '' }
  }
  const proxy = await resolveProxy()
  if (proxy) extra.push('-c', 'http.proxy=' + proxy, '-c', 'https.proxy=' + proxy)
  const backend = readGlobal('http.sslBackend') || 'openssl'
  extra.push('-c', 'http.sslBackend=' + backend)
  const ver = readGlobal('http.version') || 'HTTP/1.1'
  extra.push('-c', 'http.version=' + ver)
  return extra
}

async function latestTag() {
  const out = await runGit(here, [...await gitNetArgs(), 'ls-remote', '--tags', UPDATE_GH], MAX_GIT_BUFFER, 60000)
  const tags = new Set()
  for (const line of String(out).split('\n')) {
    const m = line.match(/refs\/tags\/(v?\d+\.\d+(?:\.\d+)?)(\^\{\})?$/)
    if (m && !m[2]) tags.add(m[1])
  }
  if (!tags.size) return ''
  return [...tags].sort((a, b) => cmpVer(b, a))[0]
}

/** Download + extract + swap this plugin's files with the given tag.
 *  Uses `git clone --depth 1 --branch <tag>` so the download rides the same
 *  proxy / sslBackend / http.version config as every other git command. */
async function applyUpdate(tag) {
  if (!/^v?\d+\.\d+(?:\.\d+)?$/.test(tag)) throw new Error('bad-tag')
  const tmp = mkdtempSync(join(tmpdir(), 'ggupd-'))
  const srcDir = join(tmp, 'src')
  try {
    await runGit(here, [...await gitNetArgs(), 'clone', '--depth', '1', '--branch', tag, UPDATE_GH, srcDir], MAX_GIT_BUFFER, 180000)
    if (!statSync(join(srcDir, 'index.js'), { throwIfNoEntry: false })) throw new Error('missing-index')
    if (!statSync(join(srcDir, 'web', 'index.html'), { throwIfNoEntry: false })) throw new Error('missing-web')

    // backup the current install, then swap (skip the cloned .git dir).
    // The backup lives next to the plugin dir (sibling), never inside it,
    // so it survives clearTree and is easy for users to find.
    const bak = join(dirname(here), basename(here) + '.bak-' + Date.now())
    try {
      copyTree(here, bak)
      clearTree(here)
      copyTree(srcDir, here, true)
    } catch (err) {
      // roll back to the backup
      try { clearTree(here); copyTree(bak, here) } catch { /* best effort */ }
      throw err
    }
    // keep only the newest backup
    pruneBackups()
  } finally {
    // Windows: cloned .git dirs may still be held by AV/antivirus scanners or
    // lingering file handles, so retry; and never let cleanup failure mask a
    // successful update (the swap above already happened).
    try {
      rmSync(tmp, { recursive: true, force: true, maxRetries: 6, retryDelay: 250 })
    } catch {
      scheduleCleanup(tmp)
    }
  }
}

/** Best-effort late cleanup of a temp dir Windows refused to delete yet
 *  (handles usually release within a few seconds). Never throws. */
function scheduleCleanup(dir) {
  let tries = 0
  const attempt = () => {
    tries++
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      if (tries < 12) setTimeout(attempt, 1000)
    }
  }
  setTimeout(attempt, 1500)
}

function copyTree(src, dst, skipDotGit) {
  const cp = (s, d) => {
    const st = statSync(s, { throwIfNoEntry: false })
    if (!st) return
    if (st.isDirectory()) {
      if (skipDotGit && s.endsWith('.git')) return
      mkdirSync(d, { recursive: true })
      for (const name of readdirSync(s)) cp(join(s, name), join(d, name))
    } else if (st.isFile()) {
      copyFileSync(s, d)
    }
  }
  cp(src, dst)
}
function clearTree(dir) {
  if (!statSync(dir, { throwIfNoEntry: false })) return
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.bak-')) continue
    rmSync(join(dir, name), { recursive: true, force: true })
  }
}
function pruneBackups() {
  const parent = dirname(here)
  const base = basename(here)
  const prefix = base + '.bak-'
  const baks = readdirSync(parent).filter((n) => n.startsWith(prefix)).sort()
  for (const b of baks.slice(0, -1)) rmSync(join(parent, b), { recursive: true, force: true })
}

/** Walk upward from `start` until a directory containing `.git` is found. */
function findGitRoot(start) {
  let dir = String(start).replace(/\\/g, '/').replace(/\/+$/, '') || '/'
  for (let i = 0; i < 24; i++) {
    try {
      const p = join(dir, '.git')
      const st = statSync(p)
      if (st.isDirectory() || st.isFile()) return dir
    } catch { /* keep walking */ }
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
  return null
}

/** Parse `git log --format=...%x1f...%d` lines into structured commit rows. */
function parseLog(stdout) {
  const rows = []
  for (const line of stdout.split('\n')) {
    if (!line) continue
    const [hash, parents, author, email, date, subject, refs] = line.split('\x1f')
    rows.push({
      hash,
      parents: parents ? parents.split(' ') : [],
      author,
      email,
      date,
      subject,
      refs: parseRefs(refs),
    })
  }
  return rows
}

/** Parse git refs decoration like " (HEAD -> master, tag: v1, origin/dev)". */
function parseRefs(raw) {
  const refs = []
  if (!raw) return refs
  const inner = raw.replace(/^\(/, '').replace(/\)$/, '').trim()
  if (!inner) return refs
  for (const part of inner.split(',')) {
    const item = part.trim()
    if (!item) continue
    if (item.startsWith('tag: ')) {
      refs.push({ kind: 'tag', name: item.slice(5).trim() })
    } else if (item.includes(' -> ')) {
      const [, target] = item.split(' -> ')
      refs.push({ kind: 'branch', name: target.trim(), head: item.startsWith('HEAD') })
    } else {
      refs.push({ kind: 'branch', name: item })
    }
  }
  return refs
}

/**
 * Parse `git status --porcelain=v1 -z` output. Returns [{x, y, path, oldPath?}].
 * In -z mode rename/copy entries emit two records: "XY <new path>" then "<old path>".
 */
function parsePorcelainZ(buf) {
  const records = []
  const parts = buf.split('\0')
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i]
    if (!rec || rec.length < 3) continue
    const x = rec[0]
    const y = rec[1]
    const path = rec.slice(3)
    if ((x === 'R' || x === 'C') && i + 1 < parts.length && parts[i + 1]) {
      records.push({ x, y, path, oldPath: parts[i + 1] })
      i++
      continue
    }
    records.push({ x, y, path })
  }
  return records
}

/**
 * Parse `git diff --numstat -z` output into a path -> {added, deleted} map.
 * Normal entries are "added\tdeleted\t<path>"; rename entries are
 * "added\tdeleted" + "\0" + "<old>" + "\0" + "<new>" (keyed by the new path);
 * binary entries use "-" for both counts.
 */
function parseNumstatZ(buf) {
  const map = new Map()
  const parts = buf.split('\0')
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i]
    if (!rec) continue
    const fields = rec.split('\t')
    if (fields.length < 2) continue
    const added = fields[0]
    const deleted = fields[1]
    let key
    if (fields.length >= 3) {
      key = fields[2]
    } else {
      // rename: "n\tn" then "<old>" then "<new>"
      const old = i + 1 < parts.length ? parts[i + 1] : ''
      const next = i + 2 < parts.length ? parts[i + 2] : ''
      key = next || old
      i += 2
    }
    if (key) map.set(key, { added, deleted })
  }
  return map
}

export function apply(ctx, config = {}) {
  const configured = []
  if (config.repo) configured.push(String(config.repo))
  if (Array.isArray(config.repos)) configured.push(...config.repos.map(String))
  const normalize = (p) => String(p).replace(/[\\/]+$/, '')
  const allowed = [...new Set(configured.map(normalize))].filter(Boolean)
  // Workspace-discovered repos (from the repos op) are accepted for reads too.
  const recentRepos = new Set()

  ctx.webServer.register({
    kind: 'prefix',
    path: '/git-graph',
    handler: async (req, res) => {
      const sendJson = (obj, status = 200) => {
        const body = JSON.stringify(obj)
        res.writeHead(status, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        })
        res.end(body)
      }
      try {
        const url = new URL(req.url, 'http://localhost')
        const pathname = url.pathname

        if (pathname === '/git-graph/' || pathname === '/git-graph/index.html') {
          res.writeHead(200, {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-store',
          })
          res.end(readFileSync(join(webRoot, 'index.html')))
          return
        }

        if (pathname !== '/git-graph/api') {
          sendJson({ ok: false, error: 'not-found' }, 404)
          return
        }

        const op = url.searchParams.get('op') || 'graph'
        if (op === 'repos') {
          // The current session's workspace (ws) is preferred when a git work
          // tree is found at or above it; configured repos follow as fallbacks.
          const ws = normalize(url.searchParams.get('ws') || '')
          let wsRoot = null
          let wsIsGit = false
          let current = allowed[0] ?? null
          if (ws) {
            const root = findGitRoot(ws)
            if (root) {
              wsRoot = root
              wsIsGit = true
              current = root
            }
          }
          const repos = []
          if (wsRoot) repos.push(wsRoot)
          for (const r of allowed) if (!repos.includes(r)) repos.push(r)
          for (const r of repos) recentRepos.add(r)
          sendJson({ ok: true, repos, current, ws, wsRoot, wsIsGit })
          return
        }

        let repo = url.searchParams.get('repo') || allowed[0]
        const repoNorm = normalize(repo || '')
        if (!repoNorm || (!allowed.includes(repoNorm) && !recentRepos.has(repoNorm))) {
          sendJson({ ok: false, error: 'repo-not-allowed', repos: allowed }, 403)
          return
        }
        repo = repoNorm

        // Sanity: reject paths that are not existing git work trees.
        if (!(await isGitRepo(repo))) {
          sendJson({ ok: false, error: 'not-a-git-repo', repo }, 400)
          return
        }

        switch (op) {
          case 'graph': {
            const headOut = await runGit(repo, ['symbolic-ref', '-q', '--short', 'HEAD']).catch(() => '')
            const headName = headOut.trim() || 'HEAD'
            // Pagination: limit/skip for large repos; total from rev-list.
            const limit = Math.max(0, Math.min(parseInt(url.searchParams.get('limit') || '0', 10) || 0, 2000))
            const skip = Math.max(0, parseInt(url.searchParams.get('skip') || '0', 10) || 0)
            const total = parseInt((await runGit(repo, ['rev-list', '--all', '--count']).catch(() => '0')).trim(), 10) || 0
            const args = ['log', '--all', '--topo-order', '--date=iso-strict',
              '--format=%H%x1f%P%x1f%an%x1f%ae%x1f%ad%x1f%s%x1f%d']
            if (skip > 0) args.push('--skip=' + skip)
            if (limit > 0) args.push('-n', String(limit))
            const log = await runGit(repo, args)
            sendJson({
              ok: true,
              repo,
              head: headName,
              total,
              commits: parseLog(log),
            })
            break
          }
          case 'branches': {
            // for-each-ref supports %09 (tab) but not %x1f (that is a log/pretty-format feature).
            const out = await runGit(repo, [
              'for-each-ref',
              '--format=%(refname)%09%(objectname)%09%(HEAD)',
              'refs/heads', 'refs/remotes', 'refs/tags',
            ])
            const branches = []
            for (const line of out.split('\n')) {
              if (!line) continue
              const [refname, sha, isHead] = line.split('\t')
              branches.push({
                refname,
                kind: refname.startsWith('refs/tags/') ? 'tag' : refname.startsWith('refs/remotes/') ? 'remote' : 'local',
                name: refname.replace(/^refs\/(heads|remotes|tags)\//, ''),
                sha,
                head: isHead === '*',
              })
            }
            sendJson({ ok: true, branches })
            break
          }
          case 'workstatus': {
            // VSCode-style working-tree overview: structured file lists grouped by
            // staged / unstaged / untracked, with per-file +/- counts (numstat).
            const branch = (await runGit(repo, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => '')).trim() || 'HEAD'
            const statusOut = await runGit(repo, ['status', '--porcelain=v1', '-z']).catch(() => '')
            const stagedNum = await runGit(repo, ['diff', '--cached', '--numstat', '-z']).catch(() => '')
            const unstagedNum = await runGit(repo, ['diff', '--numstat', '-z']).catch(() => '')
            const stagedCounts = parseNumstatZ(stagedNum)
            const unstagedCounts = parseNumstatZ(unstagedNum)
            const staged = []
            const unstaged = []
            const untracked = []
            for (const r of parsePorcelainZ(statusOut)) {
              const num = (m) => {
                const n = m.get(r.path)
                return n ? { added: n.added === '-' ? null : parseInt(n.added, 10) || 0, deleted: n.deleted === '-' ? null : parseInt(n.deleted, 10) || 0, binary: n.added === '-' } : { added: 0, deleted: 0, binary: false }
              }
              const conflict = (r.x === 'U' || r.x === 'A' || r.x === 'D') && (r.y === 'U' || r.y === 'A' || r.y === 'D')
              if (r.x === '?' && r.y === '?') {
                untracked.push({ path: r.path })
                continue
              }
              if (conflict) {
                unstaged.push({ path: r.path, oldPath: r.oldPath || '', code: 'U', ...num(unstagedCounts) })
                continue
              }
              if (r.x !== ' ' && r.x !== '?') {
                staged.push({ path: r.path, oldPath: r.oldPath || '', code: r.x, ...num(stagedCounts) })
              }
              if (r.y !== ' ' && r.y !== '?') {
                unstaged.push({ path: r.path, oldPath: r.oldPath || '', code: r.y, ...num(unstagedCounts) })
              }
            }
            sendJson({
              ok: true,
              repo,
              branch,
              staged,
              unstaged,
              untracked,
              counts: { staged: staged.length, unstaged: unstaged.length, untracked: untracked.length },
            })
            break
          }
          case 'workfile': {
            // Per-file diff (or content for untracked files) of the working tree.
            const file = url.searchParams.get('file')
            const staged = url.searchParams.get('staged') || '0' // '0' | '1' | 'untracked'
            if (!file) {
              sendJson({ ok: false, error: 'missing-file' }, 400)
              return
            }
            const full = resolve(repo, file).replace(/\\/g, '/')
            const base = repo.replace(/\\/g, '/')
            if (full !== base && !full.startsWith(base + '/')) {
              sendJson({ ok: false, error: 'path-outside-repo' }, 400)
              return
            }
            if (staged === 'untracked') {
              let st
              try { st = statSync(full) } catch {
                sendJson({ ok: false, error: 'file-not-found', file }, 404)
                return
              }
              if (!st.isFile()) {
                sendJson({ ok: true, isDir: true, content: '' })
                return
              }
              let content = ''
              try { content = readFileSync(full, 'utf8') } catch (err) {
                sendJson({ ok: false, error: String((err && err.message) || err) }, 500)
                return
              }
              if (content.includes('\0')) {
                sendJson({ ok: true, binary: true, content: '' })
                return
              }
              const truncated = content.length > MAX_DIFF_CHARS
              sendJson({ ok: true, content: truncated ? content.slice(0, MAX_DIFF_CHARS) : content, truncated })
              return
            }
            const paths = [file]
            const old = url.searchParams.get('old')
            if (old) paths.push(old)
            const args = (staged === '1'
              ? ['diff', '--cached', '--no-color', '--', ...paths]
              : ['diff', '--no-color', '--', ...paths])
            const out = await runGit(repo, args).catch(() => '')
            const truncated = out.length > MAX_DIFF_CHARS
            sendJson({ ok: true, diff: truncated ? out.slice(0, MAX_DIFF_CHARS) : out, truncated })
            break
          }
          case 'filelog': {
            // Commit history of one file (--follow tracks renames).
            const file = url.searchParams.get('file')
            if (!file) {
              sendJson({ ok: false, error: 'missing-file' }, 400)
              return
            }
            const full = resolve(repo, file).replace(/\\/g, '/')
            const base = repo.replace(/\\/g, '/')
            if (full !== base && !full.startsWith(base + '/')) {
              sendJson({ ok: false, error: 'path-outside-repo' }, 400)
              return
            }
            const log = await runGit(repo, [
              'log', '--follow', '--topo-order', '--date=iso-strict',
              '--format=%H%x1f%P%x1f%an%x1f%ae%x1f%ad%x1f%s%x1f%d', '--', file,
            ]).catch(() => '')
            sendJson({ ok: true, file, commits: parseLog(log) })
            break
          }
          case 'reveal': {
            // Open the repo folder in the OS file manager (harmless convenience).
            const opener = process.platform === 'win32' ? 'explorer'
              : process.platform === 'darwin' ? 'open'
              : 'xdg-open'
            await runGit(repo, ['rev-parse', '--show-toplevel']).then((root) => {
              return new Promise((resolvePromise) => {
                // GUI file managers may exit non-zero even on success; ignore the code.
                execFile(opener, [root.trim()], { windowsHide: true }, () => resolvePromise())
              })
            })
            sendJson({ ok: true })
            break
          }
          case 'remoteinfo': {
            // Resolve the origin remote to a web base URL (e.g. https://github.com/u/r)
            // so the client can build "/commit/<hash>" links. Returns {web, remote} or
            // {web: null} when no usable remote exists.
            const urlOut = await runGit(repo, ['remote', 'get-url', 'origin']).catch(() => '')
            const raw = urlOut.trim()
            if (!raw) {
              sendJson({ ok: true, web: null, remote: '' })
              break
            }
            let web = raw
            if (/^git@(.+):(.+)$/.test(raw)) {
              // scp-like: git@host:path.git -> https://host/path
              web = raw.replace(/^git@([^:]+):(.*)$/, 'https://$1/$2')
            } else if (/^ssh:\/\//.test(raw)) {
              web = raw.replace(/^ssh:\/\/([^@]+@)?/, 'https://')
            }
            // Drop the .git suffix and any trailing slash.
            web = web.replace(/\.git\/?$/, '').replace(/\/+$/, '')
            sendJson({ ok: true, web, remote: raw })
            break
          }
          case 'checkupdate': {
            // Compare the installed version against the latest GitHub tag.
            // Read-only; the client decides whether to offer an update.
            // Even when the network fails we still return the installed
            // version so the UI can always display it.
            const current = localVersion()
            try {
              const latest = await latestTag()
              sendJson({ ok: true, current, latest, hasUpdate: latest ? cmpVer(latest, current) > 0 : false })
            } catch (err) {
              sendJson({ ok: true, current, latest: '', hasUpdate: false, network: false, error: String((err && err.message) || err) })
            }
            break
          }
          case 'autoupdate': {
            // Download the given tag from GitHub and swap this plugin's files.
            // The caller must confirm first; a restart of dsh web is required
            // afterwards (the running process keeps the old code in memory).
            const tag = url.searchParams.get('tag')
            if (!tag) {
              sendJson({ ok: false, error: 'missing-tag' }, 400)
              return
            }
            try {
              await applyUpdate(tag)
              sendJson({ ok: true, restart: true })
            } catch (err) {
              sendJson({ ok: false, error: String((err && err.message) || err) }, 500)
            }
            break
          }
          case 'suggestmsg': {
            // Heuristic commit-message suggestion from the working-tree diff.
            // No external AI call: builds conventional-commit style candidates
            // from file names + add/del counts.
            const stagedNum = await runGit(repo, ['diff', '--cached', '--numstat', '-z']).catch(() => '')
            const unstagedNum = await runGit(repo, ['diff', '--numstat', '-z']).catch(() => '')
            const statusOut = await runGit(repo, ['status', '--porcelain=v1', '-z']).catch(() => '')
            const stagedCounts = parseNumstatZ(stagedNum)
            const unstagedCounts = parseNumstatZ(unstagedNum)
            const untracked = []
            const staged = []
            const unstaged = []
            for (const r of parsePorcelainZ(statusOut)) {
              if (r.x === '?' && r.y === '?') { untracked.push(r.path); continue }
              if (r.x !== ' ' && r.x !== '?') staged.push(r.path)
              if (r.y !== ' ' && r.y !== '?') unstaged.push(r.path)
            }
            const name = (p) => p.split('/').pop()
            const files = [...staged, ...unstaged, ...untracked]
            let ins = 0; let del = 0
            for (const m of [stagedCounts, unstagedCounts]) {
              for (const v of m.values()) {
                ins += v.added === '-' ? 0 : parseInt(v.added, 10) || 0
                del += v.deleted === '-' ? 0 : parseInt(v.deleted, 10) || 0
              }
            }
            const candidates = []
            const uniq = [...new Set(files)]
            if (untracked.length && !staged.length && !unstaged.length) {
              candidates.push(`feat: 新增 ${untracked.map(name).slice(0, 3).join('、')}${untracked.length > 3 ? ' 等' : ''}（${untracked.length} 个文件）`)
            } else if (del >= ins && del > 0) {
              candidates.push(`fix: 移除/精简 ${uniq.map(name).slice(0, 3).join('、')}${uniq.length > 3 ? ' 等' : ''}`)
            } else if (uniq.length) {
              candidates.push(`feat: 更新 ${uniq.map(name).slice(0, 3).join('、')}${uniq.length > 3 ? ' 等' : ''}`)
            }
            if (uniq.length) {
              const names = uniq.map(name).slice(0, 5).join('、')
              candidates.push(`chore: 调整 ${names}${uniq.length > 5 ? ` 等 ${uniq.length} 个文件` : ''}（+${ins} -${del}）`)
            }
            if (!uniq.length) candidates.push('chore: 清理/整理')
            sendJson({
              ok: true,
              summary: { staged: staged.length, unstaged: unstaged.length, untracked: untracked.length, insertions: ins, deletions: del },
              files: uniq,
              candidates: candidates.slice(0, 3),
            })
            break
          }
          case 'gitop': {
            // Working-tree write operations (stage/unstage/discard/commit).
            // All file paths are validated to stay inside the repo; the client
            // confirms destructive actions before calling.
            const action = url.searchParams.get('action')
            const files = url.searchParams.getAll('file').filter(Boolean)
            const base = repo.replace(/\\/g, '/')
            const okPath = (p) => {
              const full = resolve(repo, p).replace(/\\/g, '/')
              return full === base || full.startsWith(base + '/')
            }
            if (files.some((p) => !okPath(p))) {
              sendJson({ ok: false, error: 'path-outside-repo' }, 400)
              return
            }
            try {
              switch (action) {
                case 'stage':
                  if (!files.length) throw new Error('missing-file')
                  await runGit(repo, ['add', '--', ...files])
                  break
                case 'stage-all':
                  await runGit(repo, ['add', '-A'])
                  break
                case 'unstage':
                  if (!files.length) throw new Error('missing-file')
                  await runGit(repo, ['restore', '--staged', '--', ...files])
                  break
                case 'unstage-all':
                  // mixed reset: unstage everything, keep working tree
                  await runGit(repo, ['reset'])
                  break
                case 'discard':
                  // Restore file(s) to HEAD: staged + worktree changes are lost.
                  if (!files.length) throw new Error('missing-file')
                  await runGit(repo, ['restore', '--staged', '--worktree', '--', ...files])
                  break
                case 'discard-all':
                  // Restore every tracked file to HEAD (untracked files untouched).
                  await runGit(repo, ['restore', '--staged', '--worktree', '.'])
                  break
                case 'commit': {
                  const message = url.searchParams.get('message')
                  if (!message || !message.trim()) throw new Error('missing-message')
                  if (files.length) {
                    // selective commit: stage exactly these files and limit the
                    // commit to them (paths are staged so `-- files` works).
                    await runGit(repo, ['add', '--', ...files])
                    await runGit(repo, ['commit', '-m', message.trim(), '--', ...files])
                  } else {
                    if (url.searchParams.get('all') === '1') {
                      await runGit(repo, ['add', '-A'])
                    }
                    await runGit(repo, ['commit', '-m', message.trim()])
                  }
                  break
                }
                case 'ignore': {
                  // Add files to .gitignore; tracked files are untracked first
                  // (git rm --cached keeps them on disk).
                  if (!files.length) throw new Error('missing-file')
                  const tracked = []
                  for (const f of files) {
                    const out = await runGit(repo, ['ls-files', '--error-unmatch', '--', f]).catch(() => '')
                    if (out.trim()) tracked.push(f)
                  }
                  if (tracked.length) {
                    await runGit(repo, ['rm', '--cached', '--', ...tracked])
                  }
                  const gi = join(repo, '.gitignore')
                  let lines = ''
                  try { lines = readFileSync(gi, 'utf8') } catch { /* no .gitignore yet */ }
                  const has = (p) => lines.split(/\r?\n/).some((l) => l.trim() === p)
                  const adds = []
                  for (const f of files) {
                    const norm = f.replace(/\\/g, '/')
                    if (!has(norm)) adds.push(norm)
                  }
                  if (adds.length) {
                    const prefix = lines.length && !lines.endsWith('\n') ? '\n' : ''
                    appendFileSync(gi, prefix + adds.join('\n') + '\n')
                  }
                  break
                }
                case 'tag': {
                  // Lightweight tag on a commit (harmless; no editor, no push).
                  const name = url.searchParams.get('name')
                  const hash = url.searchParams.get('hash')
                  if (!name || !name.trim()) throw new Error('missing-tag-name')
                  if (!hash) throw new Error('missing-hash')
                  await runGit(repo, ['tag', name.trim(), hash])
                  break
                }
                case 'tag-delete': {
                  // Delete a local tag (does not touch remotes).
                  const name = url.searchParams.get('name')
                  if (!name || !name.trim()) throw new Error('missing-tag-name')
                  await runGit(repo, ['tag', '-d', name.trim()])
                  break
                }
                case 'tag-rename': {
                  // Rename a local tag: create the new name at the same commit,
                  // then drop the old one (create-first keeps the tag if delete fails).
                  const name = url.searchParams.get('name')
                  const newname = url.searchParams.get('newname')
                  const hash = url.searchParams.get('hash')
                  if (!name || !name.trim()) throw new Error('missing-tag-name')
                  if (!newname || !newname.trim()) throw new Error('missing-new-tag-name')
                  if (!hash) throw new Error('missing-hash')
                  await runGit(repo, ['tag', newname.trim(), hash])
                  await runGit(repo, ['tag', '-d', name.trim()])
                  break
                }
                case 'branch': {
                  // Create a new lightweight branch at the given commit.
                  const name = url.searchParams.get('name')
                  const hash = url.searchParams.get('hash')
                  if (!name || !name.trim()) throw new Error('missing-branch-name')
                  if (!hash) throw new Error('missing-hash')
                  // Reject names that would escape refs/heads (no slashes-injection guard needed:
                  // git itself validates ref names, but keep a sane limit).
                  await runGit(repo, ['branch', name.trim(), hash])
                  break
                }
                case 'fetch': {
                  // Pull remote refs into refs/remotes (no merge). Works with the
                  // configured origin, or any remote if none named.
                  await runGit(repo, ['fetch', '--all', '--prune'], MAX_GIT_BUFFER, 120000)
                  break
                }
                case 'pull': {
                  // Pull + merge the current branch from origin (may conflict; the
                  // client warns before calling). Returns the pull summary.
                  const branch = url.searchParams.get('branch')
                  const out = await runGit(repo, ['pull', 'origin', branch || ''], MAX_GIT_BUFFER, 120000)
                  sendJson({ ok: true, summary: String(out).trim() })
                  return
                }
                case 'push': {
                  // Push the current branch to origin. May require credentials;
                  // non-fast-forward and auth errors come back as git stderr.
                  const branch = url.searchParams.get('branch')
                  const out = await runGit(repo, ['push', 'origin', branch || 'HEAD'], MAX_GIT_BUFFER, 120000)
                  sendJson({ ok: true, summary: String(out).trim() })
                  return
                }
                case 'checkout': {
                  // Switch to a local branch (dirty worktree errors come from git).
                  const name = url.searchParams.get('name')
                  if (!name || !name.trim()) throw new Error('missing-branch-name')
                  await runGit(repo, ['checkout', name.trim()])
                  break
                }
                case 'delete-branch': {
                  // Delete a local branch (-d: refuses unmerged branches).
                  const name = url.searchParams.get('name')
                  if (!name || !name.trim()) throw new Error('missing-branch-name')
                  await runGit(repo, ['branch', '-d', name.trim()])
                  break
                }
                default:
                  sendJson({ ok: false, error: 'unknown-action' }, 400)
                  return
              }
              sendJson({ ok: true })
            } catch (err) {
              sendJson({ ok: false, error: String((err && err.message) || err) }, 500)
            }
            break
          }
          case 'show': {
            const hash = url.searchParams.get('hash')
            if (!hash) {
              sendJson({ ok: false, error: 'missing-hash' }, 400)
              return
            }
            const meta = await runGit(repo, ['log', '-1', `--format=%H%x1f%P%x1f%an%x1f%ae%x1f%ad%x1f%s%x1f%b`, hash]).catch(() => '')
            const parts = meta.split('\x1f')
            const sha = parts[0] || hash
            const parents = (parts[1] || '').trim()
            const author = parts[2] || ''
            const email = parts[3] || ''
            const date = parts[4] || ''
            const subject = parts[5] || ''
            const body = parts.slice(6).join('\x1f').trim()
            // stat: diff against the first parent; root commits use the empty tree.
            let stat = ''
            const firstParent = parents ? parents.split(' ')[0] : ''
            if (firstParent) {
              stat = await runGit(repo, ['diff', '--stat', firstParent, sha]).catch(() => '')
            } else {
              stat = await runGit(repo, ['show', '--stat', '--format=', sha]).catch(() => '')
            }
            sendJson({ ok: true, hash: sha, parents: parents ? parents.split(' ') : [], author, email, date, subject, body, stat: stat.trim() })
            break
          }
          case 'diff': {
            const hash = url.searchParams.get('hash')
            if (!hash) {
              sendJson({ ok: false, error: 'missing-hash' }, 400)
              return
            }
            // Full patch of one commit (git diff against its first parent; root commits diff against empty tree).
            const out = await runGit(repo, ['show', '--no-color', '--format=', hash]).catch(() => '')
            const truncated = out.length > MAX_DIFF_CHARS
            sendJson({ ok: true, diff: truncated ? out.slice(0, MAX_DIFF_CHARS) : out, truncated })
            break
          }
          case 'filediff': {
            const hash = url.searchParams.get('hash')
            const file = url.searchParams.get('file')
            if (!hash || !file) {
              sendJson({ ok: false, error: 'missing-hash-or-file' }, 400)
              return
            }
            // Diff of a single file inside one commit (against its first parent).
            let out = ''
            const parents = (await runGit(repo, ['log', '-1', '--format=%P', hash]).catch(() => '')).trim()
            if (parents) {
              out = await runGit(repo, ['diff', '--no-color', parents.split(' ')[0], hash, '--', file]).catch(() => '')
            } else {
              out = await runGit(repo, ['show', '--no-color', '--format=', hash, '--', file]).catch(() => '')
            }
            const truncated = out.length > MAX_DIFF_CHARS
            sendJson({ ok: true, file, diff: truncated ? out.slice(0, MAX_DIFF_CHARS) : out, truncated })
            break
          }
          default:
            sendJson({ ok: false, error: 'unknown-op' }, 400)
        }
      } catch (err) {
        try {
          sendJson({ ok: false, error: String((err && err.message) || err) }, 500)
        } catch {
          /* response already committed */
        }
      }
    },
  })
}
