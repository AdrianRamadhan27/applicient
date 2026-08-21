# syntax=docker/dockerfile:1
FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

# Separate prod-only install for the runtime image. Copying a real
# `pnpm install --prod` tree keeps Next's pnpm symlinks intact and makes
# the runtime independent of the developer's local node_modules.
FROM base AS prod-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod

FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# NEXT_PUBLIC_* vars are inlined into the client bundle at build time,
# not read at container runtime — has to be a build ARG, not a
# docker-compose `environment:` entry. Defaults to the api service's
# published host port since the browser (not this container) is what
# actually calls it.
ARG NEXT_PUBLIC_API_URL=http://localhost:8000
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}
ENV NEXT_TELEMETRY_DISABLED=1

RUN pnpm build

FROM base AS runner
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN addgroup --system --gid 1001 nodejs \
    && adduser --system --uid 1001 nextjs

COPY --from=prod-deps --chown=nextjs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next ./.next
COPY --from=builder --chown=nextjs:nodejs /app/package.json /app/next.config.ts ./

USER nextjs
EXPOSE 3000

HEALTHCHECK --interval=5s --timeout=5s --retries=10 --start-period=15s \
    CMD node -e "fetch('http://127.0.0.1:3000').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node_modules/.bin/next", "start", "-H", "0.0.0.0", "-p", "3000"]
