'use client';
// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>

import React, { useRef } from 'react';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { MANUAL_HTML } from './manualHtml';
import styles from './page.module.css';

/**
 * 운영 매뉴얼 — 콘솔 인증 페이지 내에서만 렌더(srcDoc). 공개 정적 URL 미제공(LOW-1 게이트).
 * AdminLayout 이 미인증 시 /admin/login 으로 리다이렉트하므로 인증 뒤에서만 접근된다.
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
export default function ManualPage() {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const print = () => frameRef.current?.contentWindow?.print();
  return (
    <AdminLayout>
      <Card>
        <CardHeader
          title="운영 매뉴얼"
          description="등록·관리·운영·연동·EMR 대응·트러블슈팅·API 레퍼런스 (콘솔 인증 전용)"
          actions={
            <div className={styles.actions}>
              <Button variant="ghost" onClick={print}>인쇄 / PDF 🖨</Button>
            </div>
          }
        />
        <CardBody>
          <iframe ref={frameRef} className={styles.frame} title="sign 운영 매뉴얼" srcDoc={MANUAL_HTML} />
        </CardBody>
      </Card>
    </AdminLayout>
  );
}
