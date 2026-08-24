# Domain modules

Transport adapters call domain services in this directory. Modules may depend
on infrastructure and shared pure helpers, but must not import `src/app`, React
components, or transport actions.

Each domain keeps a stable `service.ts` facade for callers. When a domain grows,
its implementation is split by business capability (for example lifecycle,
plan, publish, or duplicate handling) instead of rebuilding a single large
service file. Server-side implementation files must carry the `server-only`
guard; pure schemas, policies, and types may remain runtime-neutral.
