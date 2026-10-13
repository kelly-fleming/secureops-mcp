FROM node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS development
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build
CMD ["npm", "run", "check"]

FROM node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS runtime
WORKDIR /app
COPY --from=development /app/package.json /app/package-lock.json ./
COPY --from=development /app/node_modules ./node_modules
RUN npm prune --omit=dev
COPY --from=development /app/dist ./dist
COPY --from=development /app/config ./config
COPY --from=development /app/fixtures ./fixtures
ENV SECUREOPS_MODE=local-full SECUREOPS_DB_PATH=/app/data/demo/secureops-demo.db
CMD ["node", "dist/mcp/stdio.js"]
