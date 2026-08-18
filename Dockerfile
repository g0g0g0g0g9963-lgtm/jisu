# ── 1단계: 프런트엔드 정적 번들 빌드 ──
FROM node:24-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json vite.config.ts postcss.config.mjs ./
COPY standalone ./standalone
COPY app ./app
COPY public ./public
RUN npm run build

# ── 2단계: 실행 이미지 (express만 설치, DB는 Node 내장 SQLite) ──
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/app/data \
    TZ=Asia/Seoul

RUN apk add --no-cache tzdata

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# 서버가 app/config의 JSON(회의실·운영시간·시드)을 그대로 읽는다.
# --chmod=755: 호스트 파일 권한이 어떻든 컨테이너의 node 계정이 읽을 수 있게 고정.
COPY --chmod=755 server ./server
COPY --chmod=755 app/config ./app/config
COPY --chmod=755 --from=build /app/dist ./dist

RUN mkdir -p /app/data && chown -R node:node /app/data
USER node

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.mjs"]
