# sign 프론트엔드(Next.js) — standalone 멀티스테이지
# API는 same-origin(nginx가 /v1·/health를 sign-core로 프록시) → NEXT_PUBLIC_SIGN_API_URL="" 상대경로
FROM node:22-alpine AS deps
WORKDIR /app
# Playwright/axe 는 E2E 테스트 전용 devDep — 빌드 시 브라우저 다운로드 차단(런타임 미사용).
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package.json package-lock.json* ./
RUN npm ci

FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# 빈 값 = 상대경로(same-origin). 별도 API 도메인 쓰면 빌드 시 주입.
ARG NEXT_PUBLIC_SIGN_API_URL=""
ENV NEXT_PUBLIC_SIGN_API_URL=$NEXT_PUBLIC_SIGN_API_URL
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
RUN addgroup -S nodejs && adduser -S nextjs -G nodejs
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
USER nextjs
EXPOSE 3000
CMD ["node", "server.js"]
