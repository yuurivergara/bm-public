# Imagem única da API: entrypoints api (padrão), webhooks e workers serão comandos distintos.
FROM node:22-alpine AS build
WORKDIR /repo
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm --filter @bm/api... build \
 && pnpm --filter @bm/api deploy --legacy --prod /out

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN addgroup -S app && adduser -S app -G app \
 && install -d -o app -g app -m 700 /data/imports
COPY --from=build --chown=app:app /out ./
# Arquivos de compose da mesma versão: o deploy na VPS (deploy/bm-deploy.sh) os extrai da imagem.
COPY deploy/docker-compose.prod.yml deploy/docker-compose.vps.yml deploy/docker-compose.sim.yml /app/deploy/
COPY deploy/postgres/ /app/deploy/postgres/
USER app
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
CMD ["node", "dist/main.js"]
