# Fairquery Company Jobs Feed stdio MCP server - build context = repository root
# Used by Glama (glama.ai) and other MCP hosts to build and inspect the server.
# The Apify Actor image is .actor/Dockerfile.
FROM node:22-alpine AS builder
WORKDIR /app
COPY mcp/package.json mcp/package-lock.json ./
RUN npm ci --ignore-scripts
COPY mcp/tsconfig.json ./
COPY mcp/src ./src
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY mcp/package.json mcp/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && rm -rf /root/.npm
COPY --from=builder /app/dist ./dist
USER node
CMD ["node", "dist/index.js"]
