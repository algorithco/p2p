# Build context is the REPO ROOT (see docker-compose.yml build.context)
FROM node:20-alpine AS build
WORKDIR /app/signer
COPY signer/package*.json ./
RUN npm ci
COPY signer/tsconfig.json ./
COPY signer/src ./src
RUN npm run build

FROM node:20-alpine
ENV NODE_ENV=production
ENV PORT=3001
WORKDIR /app/signer
RUN apk upgrade --no-cache && addgroup -S signer && adduser -S signer -G signer
COPY signer/package*.json ./
RUN npm ci --omit=dev
# Drop bundled npm/npx: unused at runtime, but ships vulnerable tar/brace-expansion copies that trip image scanners.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
COPY --from=build /app/signer/dist ./dist
# Do NOT copy .env — injected via env_file at runtime
EXPOSE 3001
USER signer
HEALTHCHECK --interval=15s --timeout=3s --retries=5 --start-period=20s \
  CMD node -e "require('http').get('http://localhost:3001/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"
CMD ["node", "dist/index.js"]
