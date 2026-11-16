# meta-sim: simulador da Graph API (dev/CI/staging). Nunca expor publicamente.
FROM node:22-alpine AS build
WORKDIR /repo
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm --filter @bm/meta-sim... build \
 && pnpm --filter @bm/meta-sim deploy --legacy --prod /out

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN addgroup -S app && adduser -S app -G app
COPY --from=build --chown=app:app /out ./
USER app
EXPOSE 4010
HEALTHCHECK --interval=15s --timeout=3s CMD wget -qO- http://127.0.0.1:4010/healthz || exit 1
CMD ["node", "dist/main.js"]
