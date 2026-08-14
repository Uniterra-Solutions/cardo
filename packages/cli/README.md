# @uniterra-solutions/cardo

One-command installer for the Cardo macOS desktop app.

```bash
npm install -g @uniterra-solutions/cardo
cardo setup      # download the latest app from GitHub Releases → ~/Applications
cardo update     # update the CLI, then reinstall the latest app
```

The CLI downloads an unsigned macOS app zip over HTTPS with Node's `fetch`, so no
`com.apple.quarantine` attribute is ever set and Gatekeeper never blocks the app —
no Apple Developer signing/notarization is involved.

## Development

```bash
pnpm --filter @uniterra-solutions/cardo run build
pnpm --filter @uniterra-solutions/cardo run typecheck
pnpm --filter @uniterra-solutions/cardo run lint
```
