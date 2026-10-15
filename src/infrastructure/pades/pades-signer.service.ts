// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import forge from 'node-forge';
import { SignPdf } from '@signpdf/signpdf';
import { plainAddPlaceholder } from '@signpdf/placeholder-plain';
import { P12Signer } from '@signpdf/signer-p12';

/**
 * 표준 PAdES 서명기 — 실 X.509(node-forge) + PDF PAdES(@signpdf).
 * proof(scripts/pades-proof.mjs)를 운영 서비스로 통합. 감사추적인증서 PDF 봉인에 사용.
 * 운영: 본 forge CA를 sign의 KeySigner/CA(HSM)와 일원화하거나 외부 공인 인증서로 교체.
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
@Injectable()
export class PadesSignerService implements OnModuleInit {
  private readonly logger = new Logger('PadesSigner');
  private p12Buffer!: Buffer;
  private signerCertPem!: string;
  private root!: { cert: forge.pki.Certificate; keys: forge.pki.rsa.KeyPair };
  private issuing!: { cert: forge.pki.Certificate; keys: forge.pki.rsa.KeyPair };
  private readonly endEntities = new Map<string, { cert: forge.pki.Certificate; keys: forge.pki.rsa.KeyPair }>();

  onModuleInit(): void {
    this.root = this.mkCert('Sign Root CA (PAdES)', null, 3650, true);
    this.issuing = this.mkCert('Sign Issuing CA (PAdES)', this.root, 1825, true);
    const signer = this.mkCert('Sign Audit Authority', this.issuing, 1825, false);
    const p12 = forge.pkcs12.toPkcs12Asn1(signer.keys.privateKey, [signer.cert, this.issuing.cert, this.root.cert], 'sign-pades', { algorithm: '3des' });
    this.p12Buffer = Buffer.from(forge.asn1.toDer(p12).getBytes(), 'binary');
    this.signerCertPem = forge.pki.certificateToPem(signer.cert);
    this.logger.log('PAdES 서명용 X.509 체인 초기화 완료');
  }

  /** 서명자(환자/직원)용 실 X.509 말단 인증서 발급 — Issuing CA 서명 (FR-01 표준화) */
  issueEndEntity(cn: string, validDays = 365): { certPem: string; chainPem: string; x509Serial: string } {
    const leaf = this.mkCert(cn, this.issuing, validDays, false);
    this.endEntities.set(leaf.cert.serialNumber, leaf); // 개인키 보관(SOFT, 추후 HSM)
    return {
      certPem: forge.pki.certificateToPem(leaf.cert),
      chainPem: forge.pki.certificateToPem(this.issuing.cert) + forge.pki.certificateToPem(this.root.cert),
      x509Serial: leaf.cert.serialNumber,
    };
  }

  /** 실 CMS(PKCS#7/CAdES-BES) detached 서명 — 서명코어 표준화 (FR-02/20) */
  signCms(x509Serial: string, content: Buffer): string | null {
    const ee = this.endEntities.get(x509Serial);
    if (!ee) return null;
    const p7 = forge.pkcs7.createSignedData();
    p7.content = forge.util.createBuffer(content.toString('binary'));
    p7.addCertificate(ee.cert);
    p7.addSigner({
      key: ee.keys.privateKey,
      certificate: ee.cert,
      digestAlgorithm: forge.pki.oids.sha256,
      authenticatedAttributes: [
        { type: forge.pki.oids.contentType, value: forge.pki.oids.data },
        { type: forge.pki.oids.messageDigest },
        { type: forge.pki.oids.signingTime, value: new Date() as unknown as string },
      ],
    });
    p7.sign({ detached: true });
    return forge.util.encode64(forge.asn1.toDer(p7.toAsn1()).getBytes());
  }

  /**
   * CMS 검증 — signerInfo 서명(authAttrs) + messageDigest 일치. 자체완결(재시작 견고).
   * 서명자 인증서는 CMS에 내장되므로 그것으로 검증(인메모리 endEntities 불필요). 인증서 신뢰체인은
   * 별도 SignatureCore/영속 CA 검증이 담당(verify 서비스). 구조·서명·다이제스트 무결성만 판정.
   */
  verifyCms(cmsB64: string, content: Buffer, x509Serial: string): { sigOk: boolean; digestOk: boolean; chainOk: boolean; valid: boolean } {
    try {
      const der = forge.util.decode64(cmsB64);
      const msg = forge.pkcs7.messageFromAsn1(forge.asn1.fromDer(der));
      const si = (msg as { rawCapture: { authenticatedAttributes: forge.asn1.Asn1[]; signature: string } }).rawCapture;

      // 서명자 인증서: CMS 내장분(재시작 후에도 유효) 우선, 없으면 인메모리 발급분 폴백
      const certs = ((msg as unknown as { certificates?: forge.pki.Certificate[] }).certificates) ?? [];
      const embedded = certs.find((c) => c.serialNumber === x509Serial) ?? certs[0];
      const cert = embedded ?? this.endEntities.get(x509Serial)?.cert;
      if (!cert) return { sigOk: false, digestOk: false, chainOk: false, valid: false };

      // signerInfo 서명검증: 공개키로 authenticatedAttributes(DER, SET) 검증
      const authSet = forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SET, true, si.authenticatedAttributes);
      const authDer = forge.asn1.toDer(authSet).getBytes();
      const vmd = forge.md.sha256.create();
      vmd.update(authDer);
      const sigOk = (cert.publicKey as forge.pki.rsa.PublicKey).verify(vmd.digest().getBytes(), si.signature);

      // messageDigest 속성 == sha256(content)
      const want = forge.md.sha256.create();
      want.update(content.toString('binary'));
      const wantDigest = want.digest().getBytes();
      const digestOk = this.extractMessageDigest(si.authenticatedAttributes) === wantDigest;

      // 체인(현재 CA 기준, best-effort) — 신뢰판정은 별도 chainValid 가 담당하므로 valid 에서 제외
      let chainOk = false;
      try {
        chainOk = forge.pki.verifyCertificateChain(forge.pki.createCaStore([this.root.cert]), [cert, this.issuing.cert]);
      } catch {
        chainOk = false;
      }
      // CMS 구조·서명·다이제스트 무결성 판정(자체완결)
      return { sigOk, digestOk, chainOk, valid: sigOk && digestOk };
    } catch {
      return { sigOk: false, digestOk: false, chainOk: false, valid: false };
    }
  }

  private extractMessageDigest(attrs: forge.asn1.Asn1[]): string | null {
    const MD_OID = forge.pki.oids.messageDigest;
    for (const attr of attrs) {
      const seq = attr as unknown as { value: forge.asn1.Asn1[] };
      const oid = forge.asn1.derToOid((seq.value[0] as unknown as { value: string }).value);
      if (oid === MD_OID) {
        const set = seq.value[1] as unknown as { value: Array<{ value: string }> };
        return set.value[0].value;
      }
    }
    return null;
  }

  /** PDF 버퍼에 PAdES 서명 (PKCS#7 임베드, ByteRange) */
  async signPdf(pdfBuffer: Buffer, meta?: { reason?: string; name?: string; location?: string }): Promise<Buffer> {
    const withPlaceholder = plainAddPlaceholder({
      pdfBuffer,
      reason: meta?.reason ?? '감사추적인증서',
      contactInfo: 'sign',
      name: meta?.name ?? 'Sign Audit Authority',
      location: meta?.location ?? 'KR',
      signatureLength: 8192,
    });
    return new SignPdf().sign(withPlaceholder, new P12Signer(this.p12Buffer, { passphrase: 'sign-pades' }));
  }

  getSignerCertPem(): string {
    return this.signerCertPem;
  }
  getRootCertPem(): string {
    return forge.pki.certificateToPem(this.root.cert);
  }

  private mkCert(cn: string, issuer: { cert: forge.pki.Certificate; keys: forge.pki.rsa.KeyPair } | null, days: number, isCa: boolean) {
    const keys = forge.pki.rsa.generateKeyPair(2048);
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = forge.util.bytesToHex(forge.random.getBytesSync(8));
    cert.validity.notBefore = new Date();
    cert.validity.notAfter = new Date(Date.now() + days * 86400_000);
    const attrs = [
      { name: 'commonName', value: cn },
      { name: 'organizationName', value: 'Medical Foundation' },
      { name: 'countryName', value: 'KR' },
    ];
    cert.setSubject(attrs);
    cert.setIssuer(issuer ? issuer.cert.subject.attributes : attrs);
    cert.setExtensions([
      { name: 'basicConstraints', cA: isCa },
      { name: 'keyUsage', digitalSignature: true, nonRepudiation: !isCa, keyCertSign: isCa, cRLSign: isCa },
    ]);
    cert.sign(issuer ? issuer.keys.privateKey : keys.privateKey, forge.md.sha256.create());
    return { cert, keys };
  }
}
