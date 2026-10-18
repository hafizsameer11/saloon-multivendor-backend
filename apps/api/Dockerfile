# Dokploy / production — API (Node + Prisma) behind nginx
# Build context: repository root (must contain apps/api + packages/shared)
# Dokploy → Build path: .  |  Dockerfile: apps/api/Dockerfile

FROM node:20-alpine AS build
WORKDIR /app

RUN apk add --no-cache openssl

COPY packages/shared ./packages/shared
COPY apps/api/package.json apps/api/package-lock.json ./apps/api/

WORKDIR /app/apps/api
RUN npm ci

COPY apps/api ./
RUN npx prisma generate
RUN npm run build

FROM node:20-alpine AS runtime
WORKDIR /app

RUN apk add --no-cache nginx openssl \
  && mkdir -p /run/nginx /var/lib/nginx/tmp /app/uploads/public /app/uploads/private

COPY apps/api/package.json apps/api/package-lock.json ./
RUN npm ci --omit=dev && npm install prisma@6.19.0 --omit=dev --no-save \
  && npm cache clean --force

COPY --from=build /app/apps/api/dist ./dist
COPY --from=build /app/apps/api/prisma ./prisma
COPY --from=build /app/apps/api/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /app/apps/api/node_modules/@prisma/client ./node_modules/@prisma/client

COPY apps/api/docker/nginx.conf /etc/nginx/http.d/default.conf
COPY apps/api/docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENV NODE_ENV=production
ENV PORT=4000
ENV HOST=127.0.0.1

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD wget -qO- http://127.0.0.1/api/v1/health || exit 1

ENTRYPOINT ["/entrypoint.sh"]
