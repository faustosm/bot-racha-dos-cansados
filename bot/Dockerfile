# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# deps: dependencias completas (inclui dev) - reaproveitado por dev e builder
# ---------------------------------------------------------------------------
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ---------------------------------------------------------------------------
# dev: hot reload com tsx watch. Usado pelo docker-compose.override.yml.
# O codigo-fonte vem por bind mount, nao e copiado para a imagem.
# ---------------------------------------------------------------------------
FROM deps AS dev
ENV NODE_ENV=development
COPY tsconfig.json ./
EXPOSE 3000
CMD ["npm", "run", "dev"]

# ---------------------------------------------------------------------------
# builder: compila TypeScript -> dist/
# ---------------------------------------------------------------------------
FROM deps AS builder
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---------------------------------------------------------------------------
# runtime: imagem final, so com dependencias de producao
# ---------------------------------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist

USER node
EXPOSE 3000
CMD ["node", "dist/server.js"]
