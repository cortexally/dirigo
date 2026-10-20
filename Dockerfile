# Dirigo — образ демона (Bun, без системных зависимостей кроме git).
#
# ВНИМАНИЕ: CLI-агенты (opencode/kilo/hermes/…) — хостовые программы. В контейнер
# они не попадают: либо монтируются бинарники (см. README «Self-host»), либо
# ставятся в образ дополнительным слоем. Сам пульт (UI/API/копии/планы) работает
# полностью.
FROM oven/bun:1

WORKDIR /app

# git — для worktree-режима; python3/make/g++ — сборка node-pty (PTY-режим).
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

# зависимости отдельным слоем (кэш)
COPY package.json ./
RUN bun install --production || bun install

COPY . .

# путь к каталогу копий и данным переопределяется через данные-волюм
ENV HOST=0.0.0.0 \
    PORT=7171 \
    DIRIGO_DATA=/data

VOLUME ["/data"]
EXPOSE 7171

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun -e "const p=process.env.PORT||7171;fetch('http://127.0.0.1:'+p+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["bun", "run", "src/server.ts"]
