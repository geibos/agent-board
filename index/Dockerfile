# Bun несёт свой SQLite с FTS5, поэтому образу не нужны ни сборка, ни
# зависимости: только исходники и рантайм.
FROM oven/bun:1.3-alpine
WORKDIR /app
COPY src ./src
ENV INDEX_DB=/data/index.db
VOLUME /data
EXPOSE 8080
USER bun
CMD ["bun", "run", "src/main.ts"]
