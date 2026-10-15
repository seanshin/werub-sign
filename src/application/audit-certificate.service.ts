// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { SIGN_STORE, SignStore } from '../domain/ports/sign-store.port';
import { AuditChainService } from '../infrastructure/audit/audit-chain.service';
import { PadesSignerService } from '../infrastructure/pades/pades-signer.service';

/**
 * 감사추적인증서 — FR-05 / design §10.
 * 서명요청의 감사추적·서명 요약 PDF를 생성하고 **PAdES(실 X.509) 서명**하여 봉인.
 * = 법적 증거 산출물(self-contained). 라틴 폰트 한계로 본문은 ASCII.
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
@Injectable()
export class AuditCertificateService {
  constructor(
    @Inject(SIGN_STORE) private readonly store: SignStore,
    private readonly audit: AuditChainService,
    private readonly pades: PadesSignerService,
  ) {}

  /** 감사추적인증서 PDF(PAdES 서명) 생성 */
  async generate(requestId: string): Promise<Buffer> {
    const request = await this.store.getRequest(requestId);
    if (!request) throw new NotFoundException('request not found');
    const signatures = await this.store.signaturesByRequest(requestId);
    const entries = await this.store.auditEntries(requestId);
    const chain = this.audit.verify(entries);
    const head = entries.length ? entries[entries.length - 1].entryHash : '(none)';

    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Courier);
    const page = pdf.addPage([595, 842]);
    let y = 800;
    const line = (t: string, size = 9) => { page.drawText(t, { x: 40, y, size, font }); y -= size + 4; };

    line('AUDIT TRAIL CERTIFICATE', 16); y -= 6;
    line(`Request ID     : ${requestId}`);
    line(`External Doc   : CONSENT / ${request.externalDocId}`);
    line(`Document Hash  : ${request.documentHash}`);
    line(`Status         : ${request.status}`);
    line(`Sign Mode      : ${request.signMode}`);
    y -= 8;
    line('SIGNERS', 12); y -= 4;
    for (const s of signatures) {
      line(`- ${s.signerRole} | cert=${s.certSerial} | id=${s.identityMethod} | ${s.signedAt}`);
      line(`    format=${s.result?.ltv?.format ?? 'PAdES-B-LTA'} | sigAlg=${s.result?.signatureAlgorithm ?? 'SHA256withRSA'}`);
    }
    y -= 8;
    line('AUDIT CHAIN (hash-linked, tamper-evident)', 12); y -= 4;
    line(`Entries        : ${entries.length}  [${entries.map((e) => e.eventType).join(' > ')}]`, 8);
    line(`Chain valid    : ${chain.valid}`);
    line(`Head hash      : ${head}`);
    y -= 12;
    line('Sealed by Sign Audit Authority (PAdES, X.509 + PKCS#7). Verify the PDF signature.', 8);

    const pdfBytes = Buffer.from(await pdf.save({ useObjectStreams: false }));
    return this.pades.signPdf(pdfBytes, { reason: 'Audit Trail Certificate', name: 'Sign Audit Authority' });
  }
}
