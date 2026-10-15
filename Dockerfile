# sign — 의료 전자서명 트러스트 서비스
# 멀티스테이지: build(tsc+prisma generate) → runtime(dist + prisma CLI 포함)
FROM node:22-alpine AS build
WORKDIR /app
# Prisma 엔진 OpenSSL 의존 (Alpine/musl)
RUN apk add --no-cache openssl libc6-compat
COPY package*.json ./
RUN npm ci --no-audit --no-fund
COPY prisma ./prisma
RUN npx prisma generate
COPY tsconfig.json nest-cli.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
# Prisma 쿼리/마이그레이션 엔진 OpenSSL 의존 (Alpine/musl)
RUN apk add --no-cache openssl libc6-compat
# prisma migrate deploy를 컨테이너 기동 시 수행하기 위해 전체 node_modules 유지(프라그마틱)
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
# 계약 서식 PDF 조판용 한글 폰트(나눔고딕, OFL) — contract-template.service
COPY assets ./assets
COPY package.json ./

EXPOSE 4000
# 기동: 마이그레이션(prisma) 후 서비스 시작. STORE_DRIVER!=prisma면 migrate는 no-op로 두기 위해 가드
CMD ["sh", "-c", "if [ \"$STORE_DRIVER\" = \"prisma\" ]; then npx prisma migrate deploy; fi && node dist/main.js"]

HEALTHCHECK --interval=15s --timeout=3s --retries=5 \
  CMD wget -qO- http://localhost:${SIGN_PORT:-4000}/health || exit 1
