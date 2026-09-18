# Build context is REPO ROOT
FROM node:20-alpine AS build
WORKDIR /app/ubot
COPY ubot/package*.json ./
RUN npm ci
COPY ubot/tsconfig.json ./
COPY ubot/src ./src
RUN npm run build

FROM node:20-alpine
ENV NODE_ENV=production
ENV PORT=3002
ENV NODE_OPTIONS=--enable-source-maps
WORKDIR /app/ubot
RUN apk upgrade --no-cache && apk add --no-cache tini && addgroup -S ubot && adduser -S ubot -G ubot
COPY ubot/package*.json ./
RUN npm ci --omit=dev
# Drop bundled npm/npx: unused at runtime, but ships vulnerable tar/brace-expansion copies that trip image scanners.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
COPY --from=build /app/ubot/dist ./dist
# Do NOT copy .env — injected via env_file
RUN mkdir -p /app/ubot/sessions /app/ubot/logs && chown -R ubot:ubot /app/ubot/sessions /app/ubot/logs && chmod 700 /app/ubot/sessions
EXPOSE 3002
USER ubot
HEALTHCHECK --interval=20s --timeout=3s --retries=5 --start-period=40s \
  CMD node -e "require('http').get('http://localhost:3002/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
