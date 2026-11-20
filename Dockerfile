FROM node:20-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates tzdata \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
COPY src ./src
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh \
    && mkdir -p /data \
    && chown 1000:10 /data

ENV CROLI_AUTH_FILE=/data/auth.json \
    CROLI_STATE_DIR=/data/state \
    DAILY_CHAT_MODE=off \
    DASHBOARD_PORT=8787 \
    RUN_AT_HOUR=0 \
    RUN_AT_MINUTE=10 \
    TZ=Asia/Shanghai

EXPOSE 8787

# 以 NAS 上的 mango(1000:10) 身份运行：写出的状态文件归属正确，
# 宿主机不用 sudo 就能改。node:20 镜像里 node 用户正是 uid 1000。
USER 1000:10

# serve 放 CMD：默认常驻；`docker run ... node /app/src/cli.mjs status` 仍可临时覆盖
ENTRYPOINT []
CMD ["node", "/app/src/cli.mjs", "serve"]
