/** @type {import('next').NextConfig} */
const nextConfig = {
  // 운영(Docker)은 standalone. UI E2E(next start) 빌드 시 SIGN_E2E_BUILD=1 로 비활성(next start 호환).
  output: process.env.SIGN_E2E_BUILD ? undefined : 'standalone',
};

export default nextConfig;
