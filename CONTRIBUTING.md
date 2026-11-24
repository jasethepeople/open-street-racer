# Contributing

Thanks for helping make OpenStreetRacer an open, playable map game. Keep contributions small, readable, and scoped to the current phase. Phase 2 (3D, buildings, and vehicle simulation) is intentionally out of scope until the Phase 1 browser drive is stable.

## Development

Use Node.js 22 and pnpm 10:

```sh
pnpm install
pnpm dev
```

Before opening a pull request, run:

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Add tests for coordinate conversions and road constraints in `packages/world`. Do not commit build output, map tiles, API keys, or personal location data. Keep Nominatim use user-initiated, cached, and below one request per second. Preserve visible OpenStreetMap attribution.

Pull requests run CI and, for same-repository branches, receive a GitHub Pages preview comment. The project is licensed under AGPL-3.0-or-later; contributions are submitted under that license.
