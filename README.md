# RepoMind

RepoMind is a read-only assistant that answers questions about a software project. It indexes a public GitHub repository and answers with citations to the exact files and lines it used. When the evidence isn't there, it says so.

It never modifies, commits to or executes the repositories it reads.

**Status:** M0 (foundation). The API skeleton, security boundaries, tests and design tokens are in place; repository ingestion and chat come in later milestones.

## Stack

- React 19, TypeScript and Vite 8, served as Cloudflare Workers Static Assets.
- One Cloudflare Worker for the API under `/api/*`.
- Planned: D1, Vectorize, Workers AI and Queues, all on the Workers **Free** plan.

See [ADR 0001](docs/adr/0001-architecture-baseline.md) for the decisions and [docs/free-tier.md](docs/free-tier.md) for the verified limits.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Local dev server (Vite + Workers runtime) |
| `npm run lint` | oxlint |
| `npm run build` | Type-check all projects, then the production build |
| `npm test` | Unit tests (Vitest, Node) |
| `npm run test:integration` | Builds, then tests asset/API routing in the local workerd runtime |
| `npm run cf-typegen` | Regenerates `worker-configuration.d.ts` after changing `wrangler.jsonc` |
| `npm run deploy` | Build and deploy. Requires Cloudflare login; deploy only when authorized. |

## Layout

```
src/        React app (src/styles/tokens.css holds the design tokens)
worker/     Cloudflare Worker: app.ts (error boundary), router.ts, routes.ts, http.ts
shared/     Pure TypeScript shared by the Worker and the browser (API contract, URL validation)
tests/      unit/ (Node) and integration/ (built output in workerd)
docs/       Architecture decisions and free-tier policy
public/     Static files, including _headers (security headers for assets)
```

## Secrets

Never commit secrets:
- **Production:** use `wrangler secret put <NAME>`.
- **Local development:** use `.dev.vars`, which is git-ignored.

Nothing secret may use a `VITE_` prefix, because those values ship to the browser.
