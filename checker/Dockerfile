# Build context is the REPO ROOT, so all COPY paths are relative to it.
# Standalone service — NOT referenced by docker-compose.yml on purpose.

# ---------- Stage 1: compile TypeScript ----------
FROM node:20-alpine AS build

WORKDIR /app/checker

COPY checker/package*.json ./
RUN npm ci || npm install

COPY checker/tsconfig.json ./
COPY checker/src ./src

RUN npm run build

# ---------- Stage 2: slim runtime ----------
FROM node:20-alpine

ENV NODE_ENV=production
ENV PORT=3004

WORKDIR /app/checker

RUN apk upgrade --no-cache && addgroup -S checker && adduser -S checker -G checker

COPY checker/package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev

# Drop bundled npm/npx: unused at runtime, but ships vulnerable copies that trip image scanners.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

COPY --from=build /app/checker/dist ./dist

RUN chown -R checker:checker /app

EXPOSE 3004

USER checker

HEALTHCHECK NONE

CMD ["node", "dist/index.js"]
