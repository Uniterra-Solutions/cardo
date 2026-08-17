# App-Type Tool Reference

Tool-specific commands for each cardo-qa pipeline.

## UI App — Pipeline A (visual first, then function)

### 1. DOM geometry (playwright)

Navigate to each key screen, then run geometry checks with `browser_evaluate`.
Every check is a pass/fail with a cited element:

```js
// No horizontal overflow
document.documentElement.scrollWidth <= window.innerWidth

// No zero-size elements among things that must be visible
[...document.querySelectorAll('button, a, input, img, h1, h2')]
  .map((el) => ({ tag: el.tagName, text: (el.textContent || '').trim().slice(0, 30),
                  w: el.getBoundingClientRect().width, h: el.getBoundingClientRect().height }))
  .filter((e) => e.w === 0 || e.h === 0)

// Interactive hit targets ≥ 24px
[...document.querySelectorAll('button, a, [role="button"]')]
  .map((el) => el.getBoundingClientRect())
  .filter((r) => r.width < 24 || r.height < 24)

// Pairwise overlap of primary controls (intersection of bounding boxes)
// Report any pair whose boxes intersect with visible area > 0.
```

Key screens = every journey entry state: initial, empty, filled, error, plus
375 / 768 / 1280 breakpoints when the app is responsive.

### 2. Screenshot + pixel analysis (playwright)

```js
browser_screenshot((fullPage = true)); // save the image as evidence
```

Analyze the saved image:

- **Mechanical** — a small script over the image pixels: overall not blank
  (mean brightness / distinct colors), per-region variance (no giant
  solid-color block where content is expected), count of near-duplicate
  rows/columns (text clipping bleeds edges into uniformity).
- **Semantic** — read the image (vision) and confirm the layout matches the
  PRD's description for that state; no broken-image placeholders, no
  obviously clipped/overlapping text.

Both analyses go into the report; the screenshot path is the evidence.

### 3. Functional journeys — operate the UI

External tools FIRST, playwright end-to-end as fallback:

- **Desktop app** → `computer-use` skill: observe → click/type on the real
  app window.
- **Web app with an ops surface** → the project's own CLI / ops endpoint /
  UI-driving tool.
- **No external tool** → playwright end-to-end:

```
browser_navigate(url="http://localhost:3000/signup")
browser_snapshot()                    # get @eN refs for interactive elements
browser_fill(ref="@e1", text="value") # fill form fields
browser_click(ref="@e2")              # click buttons/links
browser_screenshot()                  # journey evidence
browser_evaluate("...")               # console/error check after each action
browser_scroll(direction="down")      # scroll to reveal content
browser_press(ref="@e2", key="Enter") # keyboard interaction
```

Check the console after every interaction — red console entries are bugs.

## Pure Backend — Pipeline B (container install + smoke boot)

Run the WHOLE flow in a clean container so install, build, and boot are
tested exactly as a fresh user hits them (locked lockfiles, CI flags, no
pre-warmed caches):

```bash
# Node/pnpm service: pristine install → build → boot → readiness
docker run --rm -v "$PWD":/src -w /src -p 3000:3000 node:22 sh -c '
  CI=true pnpm install --frozen-lockfile &&
  pnpm run build &&
  pnpm start & APP=$!;
  for i in $(seq 1 60); do
    curl -sf http://localhost:3000/health && break;
    sleep 1;
  done;
  kill $APP'
```

- Install or build failure inside the container = 🔴 FAIL, container log is
  the evidence.
- Readiness = the app's own health/ready signal (health endpoint, first
  ready log line, or port listening); the loop above waits for it.
- Then run every journey against the containerized instance:

```bash
# API journey: status + body assertions
curl -s -w '\n%{http_code}' -X POST http://localhost:3000/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"alice.wong@example.com","password":"Pass123!"}'
# Expected: 201, body contains user_id

# Error branch: 422 with validation errors in body
```

```bash
# CLI journey (inside the container): exit code + stdout/stderr
docker run --rm -v "$PWD":/src -w /src node:22 sh -c '
  npm run build && node cli.js create-user --email "" --name ""
  echo "exit=$?"'
# Expected: exit 1, stderr contains a validation error
```

## Library/SDK

No UI, no service — no container needed. Use `execute_code` or `terminal`
to import and exercise:

```
execute_code(code="""
from mylib import create_user
result = create_user(email="alice.wong@example.com", password="Pass123!")
assert result.success, f"Expected success, got error: {result.error}"
print("PASS: create_user works")
""")
```
