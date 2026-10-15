// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
/**
 * 루트 → 관리자 콘솔로 리다이렉트(포털은 /portal/[token] 직접 진입).
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
import { redirect } from 'next/navigation';

export default function RootPage() {
  redirect('/admin');
}
