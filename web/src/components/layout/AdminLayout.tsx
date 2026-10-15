'use client';
// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>

import React, { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { authApi, authStorage, contractsApi } from '@/lib/api';
import { AdminRole } from '@/types/api';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { useIdleLogout } from '@/lib/useIdleLogout';
import { getTheme, setTheme, applyTheme, type Theme } from '@/lib/theme';
import { APP_VERSION, MAKER } from '@/lib/version';
import styles from './AdminLayout.module.css';

// 비활동 자동 로그아웃 — 서버 미지정(기계 키 모드 등) 시 기본값(분), 만료 전 경고 시간(ms)
const DEFAULT_IDLE_MIN = 15;
const IDLE_WARNING_MS = 60_000;

interface NavItem {
  href: string;
  label: string;
  section: string | null;
  roles?: AdminRole[]; // 지정 시 해당 역할만 노출(세션 로그인). 미지정=모든 역할.
  sessionOnly?: boolean; // 세션(사람) 로그인에만 노출(기계 키 모드 숨김)
  feature?: 'contracts'; // 피처 게이팅 — 백엔드 기능 비활성(stats 404) 시 자동 숨김, 활성화하면 재배포 없이 등장
}

// 전자계약 기능 프로브 캐시 — 클라이언트 내비게이션마다 재조회 방지(탭 세션 동안 유지)
let contractsProbe: boolean | null = null;

const NAV_ITEMS: NavItem[] = [
  { href: '/admin', label: '대시보드', section: '서명요청', roles: ['admin', 'viewer'] },
  // 운영자(operator) 메뉴 정책(사용자 확정 2026-07-06): 전자계약 + 내 계정 + 운영 매뉴얼만 노출.
  // 그 외 화면은 admin(+열람성 화면은 viewer)만. 백엔드 스코프는 별도(서버가 강제) — 메뉴는 업무 동선 정리.
  { href: '/admin/requests/new', label: '새 서명요청', section: null, roles: ['admin'] },
  // 전자결재(결재함·전자결재 인증로그)는 메뉴 숨김 — weRB 문서인증(문서 인증 목록)이 결재 워크플로우를 담당.
  // 라우트·백엔드·플래그(ELECTRONIC_APPROVAL)·테스트는 보존. 결재자별 PKI 서명 보관이 필요해지면 이 항목만 복원:
  //   { href: '/admin/approvals', label: '결재함', section: '전자결재', roles: ['admin', 'operator'] },
  //   { href: '/admin/approval-audit', label: '전자결재 인증로그', section: '감사·로그', roles: ['admin', 'operator'] },
  // 일반 전자계약(행정·일반 계약) — GENERAL_CONTRACTS 비활성 시 섹션 자동 숨김(feature 프로브).
  { href: '/admin/contracts/overview', label: '계약 현황', section: '전자계약', roles: ['admin', 'operator'], feature: 'contracts' },
  { href: '/admin/contracts', label: '계약함', section: null, feature: 'contracts' },
  { href: '/admin/contracts/new', label: '새 계약', section: null, roles: ['admin', 'operator'], feature: 'contracts' },
  { href: '/admin/contracts/templates', label: '계약 서식', section: null, roles: ['admin', 'operator'], feature: 'contracts' },
  { href: '/admin/contracts/categories', label: '카테고리 관리', section: null, roles: ['admin', 'operator'], feature: 'contracts' },
  { href: '/admin/contracts/addressbook', label: '발송 주소록', section: null, roles: ['admin', 'operator'], feature: 'contracts' },
  { href: '/admin/contracts/notifications', label: '알림·리마인더', section: null, roles: ['admin', 'operator'], feature: 'contracts' },
  { href: '/admin/certificates', label: '인증서 발급', section: '인증서', roles: ['admin'] },
  { href: '/admin/certificates-list', label: '인증서 목록·관리', section: null, roles: ['admin', 'viewer'] },
  { href: '/admin/revocation', label: '폐기/OCSP·CRL', section: null, roles: ['admin'] },
  { href: '/admin/staff-sign', label: 'STAFF SSO 서명', section: '서명', roles: ['admin'] },
  { href: '/admin/users', label: '사용자 관리', section: '시스템', roles: ['admin'] },
  { href: '/admin/maintenance', label: '운영', section: null, roles: ['admin'] },
  { href: '/admin/system', label: '시스템 상태', section: null, roles: ['admin', 'viewer'] },
  { href: '/admin/integrations', label: '연동 설정', section: null, roles: ['admin'] },
  { href: '/admin/consumers', label: 'API 키 회전', section: null, roles: ['admin'] },
  { href: '/admin/activity-log', label: '문서·발급 로그', section: '감사·로그', roles: ['admin', 'viewer'] },
  { href: '/admin/event-log', label: '인증 행위 로그', section: null, roles: ['admin', 'viewer'] },
  { href: '/admin/wsign-documents', label: '문서 인증 목록', section: null, roles: ['admin'] },
  { href: '/admin/notifications', label: '발송 이력', section: null, roles: ['admin', 'viewer'] },
  { href: '/admin/audit-log', label: '감사·로그', section: null, roles: ['admin', 'viewer'] },
  { href: '/admin/account', label: '내 계정', section: '도움말', sessionOnly: true },
  { href: '/admin/manual', label: '운영 매뉴얼', section: '도움말' },
];

const ROLE_LABEL: Record<AdminRole, string> = { admin: '관리자', operator: '운영자', viewer: '열람자' };

interface AdminLayoutProps {
  children: React.ReactNode;
  title?: string;
}

export function AdminLayout({ children, title }: AdminLayoutProps) {
  const pathname = usePathname();
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [role, setRole] = useState<AdminRole | null>(null);
  const [username, setUsername] = useState<string | null>(null);
  const [idleMs, setIdleMs] = useState(0); // 0 = 미초기화/비활성(훅이 무시)
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [theme, setThemeState] = useState<Theme>('light');
  const [contractsOn, setContractsOn] = useState(contractsProbe === true);

  // 전자계약 기능 프로브(1회 캐시) — stats 200=활성, 404=비활성(메뉴 숨김)
  useEffect(() => {
    if (contractsProbe !== null) { setContractsOn(contractsProbe); return; }
    contractsApi.stats()
      .then(() => { contractsProbe = true; setContractsOn(true); })
      .catch(() => { contractsProbe = false; setContractsOn(false); });
  }, []);

  // 테마 적용(저장값 또는 OS 선호) — 관리자 콘솔 한정
  useEffect(() => {
    const t = getTheme();
    setThemeState(t);
    applyTheme(t);
  }, []);

  const toggleTheme = useCallback(() => {
    setThemeState((prev) => {
      const next: Theme = prev === 'dark' ? 'light' : 'dark';
      setTheme(next);
      return next;
    });
  }, []);

  useEffect(() => {
    if (!authStorage.hasAuth()) {
      router.replace('/admin/login');
    } else {
      setRole(authStorage.getRole());
      setUsername(authStorage.getUsername());
      // 비활동 자동 로그아웃: 서버 지정값 우선(0=서버가 idle 비활성), 미지정 시 기본 30분
      const m = authStorage.getIdleTimeoutMin();
      setIdleMs((m === null ? DEFAULT_IDLE_MIN : m) * 60_000);
      setExpiresAt(authStorage.getExpiresAt());
      setReady(true);
    }
  }, [router]);

  // 경로 변경 시 모바일 사이드바 닫기
  useEffect(() => {
    setSidebarOpen(false);
  }, [pathname]);

  const handleLogout = useCallback(async () => {
    try {
      if (authStorage.getSessionToken()) await authApi.logout();
    } catch { /* best-effort */ }
    authStorage.clear();
    router.push('/admin/login');
  }, [router]);

  // 비활동/만료 자동 로그아웃 — 사유를 로그인 페이지로 전달(안내 표시)
  const handleAutoLogout = useCallback(async (reason: 'timeout' | 'expired') => {
    try {
      if (authStorage.getSessionToken()) await authApi.logout();
    } catch { /* best-effort */ }
    authStorage.clear();
    router.replace(`/admin/login?reason=${reason}`);
  }, [router]);

  const { warnSecondsLeft, extend } = useIdleLogout({
    idleMs,
    warningMs: IDLE_WARNING_MS,
    absoluteExpiry: expiresAt,
    enabled: ready,
    onLogout: handleAutoLogout,
  });

  const handleOverlayClick = useCallback(() => {
    setSidebarOpen(false);
  }, []);

  if (!ready) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '100vh' }}>
        <span>인증 확인 중...</span>
      </div>
    );
  }

  // 역할 기반 메뉴 필터: 세션(role!=null)은 roles 매칭, sessionOnly는 세션만.
  // 기계 키(break-glass, role==null)는 sessionOnly 외 전체 노출(스코프는 서버가 강제).
  const visibleItems = NAV_ITEMS.filter((item) => {
    if (item.sessionOnly && !role) return false;
    if (role && item.roles && !item.roles.includes(role)) return false;
    if (item.feature === 'contracts' && !contractsOn) return false; // 기능 비활성 — 섹션 숨김
    return true;
  });

  let prevSection: string | null = null;

  // 활성 메뉴 = 현재 경로와 일치하는 항목 중 **가장 구체적인(긴) 1개만**.
  // (접두사 매칭만 쓰면 /admin/contracts/new 에서 계약함(/admin/contracts)까지 중복 활성 — 메뉴 선택 오류)
  const activeHref = visibleItems
    .filter((i) => pathname === i.href || pathname.startsWith(i.href + '/'))
    .sort((a, b) => b.href.length - a.href.length)[0]?.href;

  const navContent = (
    <>
      <div className={styles.sidebarHeader}>
        <div className={styles.logo}>
          <span aria-hidden="true">&#9670;</span>
          트러스트 서비스
        </div>
        <div className={styles.logoSub}>의료/IT 전자서명 관리 콘솔</div>
      </div>
      <nav className={styles.nav} aria-label="관리자 메뉴">
        {visibleItems.map((item) => {
          const showSection = item.section && item.section !== prevSection;
          if (item.section) prevSection = item.section;
          const isActive = item.href === activeHref;
          return (
            <React.Fragment key={item.href}>
              {showSection && (
                <div className={styles.navSection}>{item.section}</div>
              )}
              <Link
                href={item.href}
                className={[styles.navLink, isActive ? styles.active : ''].filter(Boolean).join(' ')}
                aria-current={isActive ? 'page' : undefined}
              >
                {item.label}
              </Link>
            </React.Fragment>
          );
        })}
      </nav>
      <div className={styles.sidebarFooter}>
        <div className={styles.userBox}>
          {role ? (
            <>
              <span className={styles.userName}>{username}</span>
              <span className={styles.userRole}>{ROLE_LABEL[role]}</span>
            </>
          ) : (
            <span className={styles.userRole}>API 키 (break-glass)</span>
          )}
        </div>
        <Button variant="ghost" size="sm" onClick={handleLogout} fullWidth>
          로그아웃
        </Button>
        <div className={styles.appMeta}>
          <span>sign v{APP_VERSION}</span>
          <span>제작 {MAKER}</span>
        </div>
      </div>
    </>
  );

  return (
    <div className={styles.layout}>
      {/* 접근성: 본문 바로가기(포커스 시 노출) */}
      <a href="#main-content" className={styles.skipLink}>본문으로 건너뛰기</a>
      {/* 데스크톱 사이드바 */}
      <aside className={styles.sidebar} aria-label="관리자 메뉴">
        {navContent}
      </aside>

      {/* 모바일 오버레이 */}
      {sidebarOpen && (
        <div
          className={styles.overlay}
          onClick={handleOverlayClick}
          aria-hidden="true"
        />
      )}

      {/* 모바일 사이드바 드로어 */}
      <aside
        className={[styles.drawer, sidebarOpen ? styles.drawerOpen : ''].filter(Boolean).join(' ')}
        aria-label="관리자 메뉴 (모바일)"
        aria-hidden={!sidebarOpen}
      >
        {navContent}
      </aside>

      <div className={styles.main}>
        <div className={styles.topbar}>
          {/* 모바일 햄버거 버튼 */}
          <button
            className={styles.hamburger}
            onClick={() => setSidebarOpen((v) => !v)}
            aria-expanded={sidebarOpen}
            aria-controls="mobile-sidebar"
            aria-label={sidebarOpen ? '메뉴 닫기' : '메뉴 열기'}
          >
            <span className={styles.hamburgerLine} />
            <span className={styles.hamburgerLine} />
            <span className={styles.hamburgerLine} />
          </button>
          {title && <h1 className={styles.pageTitle}>{title}</h1>}
          <div className={styles.topbarActions}>
            <button
              type="button"
              className={styles.themeToggle}
              onClick={toggleTheme}
              aria-label={theme === 'dark' ? '라이트 모드로 전환' : '다크 모드로 전환'}
              title={theme === 'dark' ? '라이트 모드로 전환' : '다크 모드로 전환'}
            >
              <span aria-hidden="true">{theme === 'dark' ? '☀' : '☾'}</span>
            </button>
          </div>
        </div>
        <main className={styles.content} id="main-content">
          {children}
        </main>
      </div>

      {/* 비활동 자동 로그아웃 경고(EMR 보안성 F004) — 만료 직전 카운트다운 */}
      <Modal
        open={warnSecondsLeft !== null}
        onClose={extend}
        title="세션 자동 로그아웃 안내"
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={handleLogout}>지금 로그아웃</Button>
            <Button size="sm" onClick={extend}>계속 사용</Button>
          </>
        }
      >
        <p style={{ margin: 0 }}>
          장시간 활동이 없어 <strong>{warnSecondsLeft ?? 0}초</strong> 후 자동으로 로그아웃됩니다.
        </p>
        <p style={{ margin: '8px 0 0', color: 'var(--color-text-muted, #6b7280)', fontSize: '0.875rem' }}>
          계속 사용하시려면 ‘계속 사용’을 누르거나 화면을 조작해 주세요.
        </p>
      </Modal>
    </div>
  );
}
