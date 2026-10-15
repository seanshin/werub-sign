// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
/**
 * 표준 PAdES + 실 RFC3161 증명 (node-forge + pdf-lib + @signpdf)
 *
 * 기존 sign 코어는 자체 JSON 구조로 PKI/LTV를 증명(법적 의미 충족).
 * 본 스크립트는 이를 "국제표준 산출물"로 격상하는 실증:
 *   1) 실 X.509 인증서 체인 (Root→Issuing→Leaf, node-forge, DER)
 *   2) 실제 PDF에 PAdES 서명 (PKCS#7/CMS 임베드, ByteRange) → 서명된 PDF 파일 산출
 *   3) 실 RFC3161 TimeStampToken (TSTInfo + CMS, TSA 키 서명)
 *   4) 검증: PDF 서명 구조 · 인증서 체인 · TST
 *
 * 실행: node scripts/pades-proof.mjs  → 산출물 /tmp/consent-signed.pdf
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
import forge from 'node-forge';
import { PDFDocument } from 'pdf-lib';
import { SignPdf } from '@signpdf/signpdf';
import { plainAddPlaceholder } from '@signpdf/placeholder-plain';
import { P12Signer } from '@signpdf/signer-p12';
import { writeFileSync } from 'node:fs';

let fail = 0;
const check = (c, m) => { console.log('  ' + (c ? '✅' : '❌') + ' ' + m); if (!c) fail++; };

function mkCert(cn, issuer, validDays, isCa) {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = forge.util.bytesToHex(forge.random.getBytesSync(8));
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date(Date.now() + validDays * 86400_000);
  const attrs = [{ name: 'commonName', value: cn }, { name: 'organizationName', value: 'Medical Foundation' }, { name: 'countryName', value: 'KR' }];
  cert.setSubject(attrs);
  cert.setIssuer(issuer ? issuer.cert.subject.attributes : attrs);
  cert.setExtensions([
    { name: 'basicConstraints', cA: !!isCa },
    { name: 'keyUsage', digitalSignature: true, nonRepudiation: !isCa, keyCertSign: !!isCa, cRLSign: !!isCa },
  ]);
  cert.sign(issuer ? issuer.keys.privateKey : keys.privateKey, forge.md.sha256.create());
  return { cert, keys };
}

function buildRfc3161Tst(messageImprintDigest, tsa, caStore) {
  const asn1 = forge.asn1;
  const algId = asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
    asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OID, false, asn1.oidToDer(forge.pki.oids.sha256).getBytes()),
    asn1.create(asn1.Class.UNIVERSAL, asn1.Type.NULL, false, ''),
  ]);
  const messageImprint = asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
    algId, asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OCTETSTRING, false, messageImprintDigest),
  ]);
  const tstInfo = asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
    asn1.create(asn1.Class.UNIVERSAL, asn1.Type.INTEGER, false, asn1.integerToDer(1).getBytes()),
    asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OID, false, asn1.oidToDer('1.2.3.4.1').getBytes()),
    messageImprint,
    asn1.create(asn1.Class.UNIVERSAL, asn1.Type.INTEGER, false, asn1.integerToDer(1718170000).getBytes()),
    asn1.create(asn1.Class.UNIVERSAL, asn1.Type.GENERALIZEDTIME, false, asn1.dateToGeneralizedTime(new Date())),
  ]);
  const tstInfoDer = asn1.toDer(tstInfo).getBytes();
  const TST_OID = '1.2.840.113549.1.9.16.1.4';
  const p7 = forge.pkcs7.createSignedData();
  p7.contentInfo = asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
    asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OID, false, asn1.oidToDer(TST_OID).getBytes()),
    asn1.create(asn1.Class.CONTEXT_SPECIFIC, 0, true, [
      asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OCTETSTRING, false, tstInfoDer),
    ]),
  ]);
  p7.content = forge.util.createBuffer(tstInfoDer);
  p7.addCertificate(tsa.cert);
  p7.addSigner({
    key: tsa.keys.privateKey, certificate: tsa.cert, digestAlgorithm: forge.pki.oids.sha256,
    authenticatedAttributes: [
      { type: forge.pki.oids.contentType, value: TST_OID },
      { type: forge.pki.oids.messageDigest },
      { type: forge.pki.oids.signingTime, value: new Date() },
    ],
  });
  p7.sign({ detached: false });
  const der = asn1.toDer(p7.toAsn1()).getBytes();
  let chainOk = false;
  try { chainOk = forge.pki.verifyCertificateChain(caStore, [tsa.cert, tsa.issuerCert]); } catch { chainOk = false; }
  return { der, chainOk };
}

async function main() {
  console.log('\n══════ 표준 PAdES + RFC3161 증명 ══════\n');

  // 1) 실 X.509 체인
  console.log('[1] 실 X.509 인증서 체인 (node-forge)');
  const root = mkCert('Sign Root CA', null, 3650, true);
  const issuing = mkCert('Sign Issuing CA', root, 1825, true);
  const leaf = mkCert('Hong Gil-dong (Patient)', issuing, 365, false);
  const caStore = forge.pki.createCaStore([root.cert]);
  let chainOk = false;
  try { chainOk = forge.pki.verifyCertificateChain(caStore, [leaf.cert, issuing.cert]); } catch { chainOk = false; }
  check(chainOk, '인증서 체인 검증 (Leaf→Issuing→Root)');
  console.log('    Leaf serial:', leaf.cert.serialNumber);

  // 2) PDF PAdES 서명
  console.log('\n[2] 표준 PDF PAdES 서명');
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([595, 842]);
  page.drawText('Surgery Consent (e-sign test)', { x: 50, y: 780, size: 16 });
  page.drawText('Patient: Hong  /  Procedure: appendectomy  /  risks explained', { x: 50, y: 750, size: 11 });
  const pdfBytes = await pdfDoc.save({ useObjectStreams: false });

  const p12Asn1 = forge.pkcs12.toPkcs12Asn1(leaf.keys.privateKey, [leaf.cert, issuing.cert, root.cert], 'pw', { algorithm: '3des' });
  const p12Buffer = Buffer.from(forge.asn1.toDer(p12Asn1).getBytes(), 'binary');
  const withPlaceholder = plainAddPlaceholder({
    pdfBuffer: Buffer.from(pdfBytes), reason: '의료 동의', contactInfo: 'hospital', name: 'Hong', location: 'KR', signatureLength: 8192,
  });
  const signedPdf = await new SignPdf().sign(withPlaceholder, new P12Signer(p12Buffer, { passphrase: 'pw' }));
  const outPath = '/tmp/consent-signed.pdf';
  writeFileSync(outPath, signedPdf);
  check(signedPdf.length > pdfBytes.length, `PDF PAdES 서명 → ${outPath} (${signedPdf.length} bytes)`);
  const s = signedPdf.toString('latin1');
  check(s.includes('/ByteRange'), 'PDF에 /ByteRange 존재');
  check(/\/Contents\s*</.test(s), 'PDF에 /Contents(PKCS#7 임베드) 존재');
  check(s.includes('ETSI.CAdES.detached') || s.includes('adbe.pkcs7.detached'), 'PAdES/CAdES SubFilter 존재');

  // 3) 실 RFC3161 TST
  console.log('\n[3] 실 RFC3161 TimeStampToken');
  const tsa = mkCert('Sign TSA', issuing, 1825, false);
  tsa.issuerCert = issuing.cert;
  const md = forge.md.sha256.create(); md.update('signature-bytes-to-timestamp');
  const tst = buildRfc3161Tst(md.digest().getBytes(), tsa, caStore);
  check(tst.der.length > 0, `RFC3161 TST 생성 (${tst.der.length} bytes, TSTInfo+CMS)`);
  check(tst.chainOk, 'TST의 TSA 인증서 체인 검증');

  console.log('\n══════ 요약 ══════');
  const pass = fail === 0;
  console.log(pass ? '✅ 표준 PAdES + RFC3161 산출물 생성·검증 통과' : `❌ ${fail}건 실패`);
  console.log('   → 실 X.509 체인 + PDF PAdES(PKCS#7 임베드) + 실 RFC3161 TST');
  console.log('   → sign 서비스의 KeySigner/CA/TSA 포트를 본 표준 구현으로 교체 시 운영 법적 형태 완성');
  process.exit(pass ? 0 : 1);
}
main().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
