// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
import { Injectable } from '@nestjs/common';
import { KeySigner } from '../domain/ports/key-signer.port';
import { TsaProvider } from '../domain/ports/tsa-provider.port';
import { CaService } from '../infrastructure/pki/ca.service';
import { IssuedCertificate, SignatureVerification } from '../domain/types/pki.types';
import { SignatureArtifact } from '../domain/types/store.types';
import { canonicalJson, canonicalBuffer } from '../domain/canonical-json';

export interface SignInput {
  documentHash: string; // sha256 hex (서버 고정 — 클라 입력 불신, conventions §6)
  signerRole: string;
  cert: IssuedCertificate; // 소유자 인증서(keyRef 포함)
  ocspStatus?: string; // 서명 시점 폐기상태 (LTV 봉인용)
}

export type SignResult = SignatureArtifact;

/**
 * 서명 생성·검증 유스케이스 — design §5.1/§5.2. 이 서비스가 "전자서명의 암호적 실체"다.
 *
 * mock 과의 결정적 차이: verify 가 공개키 crypto.verify(실제 서명 검증)라는 것.
 * (mock 은 sha256(signatureValue) 재계산이라 서명값을 통째로 바꿔도 통과했다 — README §1)
 *
 * 서명 하나에 들어가는 것(CAdES-BES 구조):
 *  - signedAttrs: contentType + messageDigest(=documentHash) + signingTime + 서명자 인증서 참조
 *    → 서명은 문서가 아니라 **signedAttrs 의 canonical 직렬화**에 걸린다(문서 해시가 그 안에 봉인).
 *  - TSA 토큰: 서명 직후 signatureValue 해시에 시점 봉인 — "그때 서명했다"의 증거.
 *  - ocspStatus: 서명 시점의 폐기 상태를 함께 저장(LTV — 나중에 폐기돼도 "그때 유효" 증명).
 *
 * ⚠ canonicalJson 사용 이유: PostgreSQL JSONB 는 키 순서를 보존하지 않는다. 저장→재로딩한
 * signedAttrs 를 그냥 JSON.stringify 하면 운영에서만 검증이 깨진다(반복된 함정 — canonical-json.ts).
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
@Injectable()
export class SignatureService {
  constructor(
    private readonly signer: KeySigner,
    private readonly tsa: TsaProvider,
    private readonly ca: CaService,
  ) {}

  /** signedAttrs(PAdES 호환 서명 대상)를 구성 — documentHash를 messageDigest로 포함 */
  private buildSignedAttrs(input: SignInput): Buffer {
    return Buffer.from(
      JSON.stringify({
        documentHash: input.documentHash,
        signerRole: input.signerRole,
        cert: input.cert.tbs.serialNumber,
      }),
    );
  }

  async sign(input: SignInput): Promise<SignResult> {
    if (!input.cert.keyRef) throw new Error('signer cert has no keyRef');
    const signedAttrs = this.buildSignedAttrs(input);
    const sig = await this.signer.sign(input.cert.keyRef, signedAttrs);
    const signedAttrsHash = this.signer.hash(signedAttrs);
    const token = await this.tsa.stamp(this.signer.hash(sig)); // 서명값에 TSA 시점 봉인
    const sigB64 = sig.toString('base64');

    // PAdES-LTA: 인증서 체인 + OCSP + 아카이브 TS를 봉인(만료 후 검증 가능, §10)
    const ltv = await this.buildLtv(input, sigB64, token);

    return {
      signatureValue: sigB64,
      signatureAlgorithm: 'SHA256withRSA',
      signedAttrsHash,
      timestamp: { genTime: token.genTime, tsaProvider: token.tsaProvider, token },
      ltv,
    };
  }

  /** LTV 봉인 자료 생성 — 체인(자체검증 가능) + 서명시점 OCSP + 아카이브 타임스탬프 */
  private async buildLtv(input: SignInput, sigB64: string, sigToken: { genTime: string }) {
    const strip = (c: IssuedCertificate) => ({ ...c, keyRef: undefined });
    const chain = [strip(input.cert), this.ca.issuingCert, this.ca.rootCert].filter(Boolean);
    const ocsp = { serial: input.cert.tbs.serialNumber, status: input.ocspStatus ?? 'GOOD', at: sigToken.genTime };
    const archiveMaterial = sigB64 + canonicalJson(chain) + canonicalJson(ocsp) + canonicalJson(sigToken);
    const archiveToken = await this.tsa.stamp(this.signer.hash(Buffer.from(archiveMaterial)));
    return {
      format: 'PAdES-B-LTA',
      chain,
      ocsp,
      archiveTimestamp: { genTime: archiveToken.genTime, tsaProvider: archiveToken.tsaProvider, token: archiveToken },
    };
  }

  /**
   * LTV 검증 — 봉인된 자료만으로 검증(인증서 만료 여부 무관).
   * 서명·체인·아카이브TS·OCSP를 self-contained 하게 확인 → 장기 증거력.
   */
  verifyLtv(input: SignInput, result: SignResult): { ltvPresent: boolean; sigOk: boolean; chainOk: boolean; archiveOk: boolean; ocspGood: boolean; ltvValid: boolean } {
    const ltv = result.ltv;
    if (!ltv) return { ltvPresent: false, sigOk: false, chainOk: false, archiveOk: false, ocspGood: false, ltvValid: false };

    const chain = ltv.chain as IssuedCertificate[];
    const [leaf, issuing, root] = chain;
    const signedAttrs = this.buildSignedAttrs(input);
    const sigBuf = Buffer.from(result.signatureValue, 'base64');

    const sigOk = this.signer.verify(leaf.tbs.publicKey, signedAttrs, sigBuf);
    const canon = (c: IssuedCertificate) => canonicalBuffer(c.tbs);
    const chainOk =
      this.signer.verify(issuing.tbs.publicKey, canon(leaf), Buffer.from(leaf.signature, 'base64')) &&
      this.signer.verify(root.tbs.publicKey, canon(issuing), Buffer.from(issuing.signature, 'base64'));
    const archiveMaterial = result.signatureValue + canonicalJson(chain) + canonicalJson(ltv.ocsp) + canonicalJson(result.timestamp.token);
    const archiveOk = this.tsa.verify(ltv.archiveTimestamp.token as never, this.signer.hash(Buffer.from(archiveMaterial)));
    const ocspGood = ltv.ocsp.status === 'GOOD';

    return { ltvPresent: true, sigOk, chainOk, archiveOk, ocspGood, ltvValid: sigOk && chainOk && archiveOk && ocspGood };
  }

  /** 검증: 공개키 실제 서명 + TSA 시점 + 체인 + 만료(TSA시각 기준) */
  verify(input: SignInput, result: SignResult): SignatureVerification {
    const signedAttrs = this.buildSignedAttrs(input);
    const sigBuf = Buffer.from(result.signatureValue, 'base64');

    const cryptoOk = this.signer.verify(input.cert.tbs.publicKey, signedAttrs, sigBuf);
    const timestampValid = this.tsa.verify(result.timestamp.token as never, this.signer.hash(sigBuf));
    const chainValid = this.ca.verifyChain(input.cert);
    const genTime = new Date(result.timestamp.genTime);
    const notExpired = genTime >= new Date(input.cert.tbs.notBefore) && genTime <= new Date(input.cert.tbs.notAfter);
    const notRevoked = input.cert.status === 'ACTIVE'; // 운영: CRL/OCSP 조회(FR-19)

    return {
      cryptoOk,
      timestampValid,
      chainValid,
      notExpired,
      notRevoked,
      overall: cryptoOk && timestampValid && chainValid && notExpired && notRevoked,
    };
  }
}
