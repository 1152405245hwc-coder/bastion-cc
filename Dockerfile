FROM node:24-slim

WORKDIR /app

COPY package.json package-lock.json tsconfig.json ./
COPY core ./core
COPY server ./server
COPY runner ./runner
COPY clients ./clients
COPY compat ./compat
COPY scripts ./scripts

RUN mkdir -p /data && chown -R 1000:1000 /app /data

USER 1000:1000

ENV NODE_ENV=production
ENV CCRF_BIND_HOST=0.0.0.0
ENV CCRF_BIND_PORT=8787
ENV CCRF_EVENT_DB=/data/events.sqlite

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:' + (process.env.CCRF_BIND_PORT || 8787) + '/').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "scripts/start-server.mjs"]
