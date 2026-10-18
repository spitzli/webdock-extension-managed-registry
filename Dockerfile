FROM oven/bun@sha256:ec06c3b6cea04192ae6770c434f668ca41d343ad19fa6472216c7b48be39c598 AS deps
WORKDIR /app
COPY package.json bun.lock ./
COPY vendor ./vendor
RUN bun install --production --frozen-lockfile --ignore-scripts
FROM oven/bun@sha256:ec06c3b6cea04192ae6770c434f668ca41d343ad19fa6472216c7b48be39c598
LABEL org.opencontainers.image.source="https://github.com/spitzli/webdock-extension-managed-registry"
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY src ./src
COPY ui ./ui
ENV NODE_ENV=production
USER bun
EXPOSE 3443 3444
CMD ["bun", "src/index.ts"]
