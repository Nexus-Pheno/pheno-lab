<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Pheno Lab repository rules

Before changing this application, read and follow [`../AGENTS.md`](../AGENTS.md) and
[`../docs/development-standards.md`](../docs/development-standards.md). The root
`AGENTS.md` is the authoritative project policy; this file keeps the Next.js-generated block above so
`next dev` does not recreate an unexplained diff.

Production deployment is not implied by a code change. When Louis explicitly requests deployment, follow only
[`deploy/README.md`](deploy/README.md) and the existing scripts/templates. Do not create another env file,
deployment directory, service, vhost, process manager, or parallel deployment workflow.
