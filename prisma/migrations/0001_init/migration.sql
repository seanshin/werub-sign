-- CreateTable
CREATE TABLE "key_materials" (
    "id" UUID NOT NULL,
    "ownerType" VARCHAR(10) NOT NULL,
    "ownerRef" VARCHAR(64),
    "keyStoreType" VARCHAR(10) NOT NULL,
    "keyRef" VARCHAR(256) NOT NULL,
    "algorithm" VARCHAR(20) NOT NULL,
    "publicKey" TEXT NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "key_materials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "certificates" (
    "id" UUID NOT NULL,
    "serialNumber" VARCHAR(64) NOT NULL,
    "subjectDn" VARCHAR(500) NOT NULL,
    "issuerDn" VARCHAR(500) NOT NULL,
    "ownerType" VARCHAR(10) NOT NULL,
    "ownerRef" VARCHAR(64),
    "keyId" UUID NOT NULL,
    "x509Pem" TEXT NOT NULL,
    "fingerprint" VARCHAR(64) NOT NULL,
    "algorithm" VARCHAR(20) NOT NULL,
    "notBefore" TIMESTAMPTZ NOT NULL,
    "notAfter" TIMESTAMPTZ NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
    "revokedAt" TIMESTAMPTZ,
    "revokeReason" VARCHAR(200),
    "issuerCertId" UUID,
    "identityVerificationId" UUID,
    "licenseNumber" VARCHAR(50),
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "certificates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cert_revocations" (
    "id" UUID NOT NULL,
    "certId" UUID NOT NULL,
    "serialNumber" VARCHAR(64) NOT NULL,
    "revokedAt" TIMESTAMPTZ NOT NULL,
    "reason" VARCHAR(50) NOT NULL,
    "crlNumber" INTEGER NOT NULL,

    CONSTRAINT "cert_revocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "signature_requests" (
    "id" UUID NOT NULL,
    "externalSystem" VARCHAR(30) NOT NULL,
    "externalDocType" VARCHAR(50) NOT NULL,
    "externalDocId" VARCHAR(64) NOT NULL,
    "patientRef" VARCHAR(64),
    "title" VARCHAR(200) NOT NULL,
    "documentHash" VARCHAR(64) NOT NULL,
    "documentVersion" INTEGER NOT NULL DEFAULT 1,
    "documentUri" VARCHAR(500),
    "signMode" VARCHAR(20) NOT NULL,
    "channel" VARCHAR(20),
    "status" VARCHAR(20) NOT NULL DEFAULT 'CREATED',
    "requiredSigners" INTEGER NOT NULL DEFAULT 1,
    "completedSigners" INTEGER NOT NULL DEFAULT 0,
    "idempotencyKey" VARCHAR(64) NOT NULL,
    "callbackUrl" VARCHAR(500),
    "expiresAt" TIMESTAMPTZ,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "signature_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "signer_participants" (
    "id" UUID NOT NULL,
    "requestId" UUID NOT NULL,
    "signerRole" VARCHAR(20) NOT NULL,
    "signerType" VARCHAR(20) NOT NULL,
    "externalSignerRef" VARCHAR(64),
    "displayName" VARCHAR(100) NOT NULL,
    "signOrder" INTEGER NOT NULL DEFAULT 1,
    "requiredIdentityLevel" VARCHAR(20) NOT NULL DEFAULT 'INPERSON',
    "contactPhoneHash" VARCHAR(128),
    "guardianName" VARCHAR(100),
    "guardianRelation" VARCHAR(30),
    "guardianLegalBasis" VARCHAR(50),
    "status" VARCHAR(20) NOT NULL DEFAULT 'PENDING',

    CONSTRAINT "signer_participants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "signatures" (
    "id" UUID NOT NULL,
    "requestId" UUID NOT NULL,
    "participantId" UUID NOT NULL,
    "certificateId" UUID NOT NULL,
    "signatureValue" TEXT NOT NULL,
    "signatureAlgorithm" VARCHAR(30) NOT NULL,
    "signedAttrsHash" VARCHAR(64) NOT NULL,
    "format" VARCHAR(20) NOT NULL DEFAULT 'PAdES-B-LTA',
    "dssData" JSONB,
    "handwrittenImage" TEXT,
    "timestampId" UUID,
    "identityVerificationId" UUID NOT NULL,
    "signedAt" TIMESTAMPTZ NOT NULL,
    "ipAddress" VARCHAR(45),
    "userAgent" VARCHAR(500),
    "deviceId" VARCHAR(64),
    "isValid" BOOLEAN NOT NULL DEFAULT true,
    "verifiedAt" TIMESTAMPTZ,

    CONSTRAINT "signatures_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "timestamps" (
    "id" UUID NOT NULL,
    "tsaProvider" VARCHAR(30) NOT NULL,
    "hashedMessage" VARCHAR(64) NOT NULL,
    "hashAlgorithm" VARCHAR(20) NOT NULL,
    "tsToken" TEXT NOT NULL,
    "genTime" TIMESTAMPTZ NOT NULL,
    "tsaSerial" VARCHAR(64),
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "timestamps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity_verifications" (
    "id" UUID NOT NULL,
    "subjectRef" VARCHAR(64),
    "method" VARCHAR(20) NOT NULL,
    "provider" VARCHAR(30),
    "providerTxId" VARCHAR(128),
    "verifiedName" VARCHAR(100),
    "ciHash" VARCHAR(128),
    "phoneHash" VARCHAR(128),
    "result" VARCHAR(10) NOT NULL,
    "verifiedAt" TIMESTAMPTZ NOT NULL,
    "ipAddress" VARCHAR(45),

    CONSTRAINT "identity_verifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_trails" (
    "id" UUID NOT NULL,
    "requestId" UUID NOT NULL,
    "eventType" VARCHAR(30) NOT NULL,
    "actorType" VARCHAR(10) NOT NULL,
    "actorRef" VARCHAR(64),
    "ipAddress" VARCHAR(45),
    "userAgent" VARCHAR(500),
    "deviceId" VARCHAR(64),
    "eventData" JSONB,
    "prevHash" VARCHAR(64),
    "entryHash" VARCHAR(64) NOT NULL,
    "occurredAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_trails_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_certificates" (
    "id" UUID NOT NULL,
    "requestId" UUID NOT NULL,
    "contentHash" VARCHAR(64) NOT NULL,
    "pdfUri" VARCHAR(500),
    "timestampId" UUID,
    "generatedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_certificates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_anchors" (
    "id" UUID NOT NULL,
    "headHash" VARCHAR(64) NOT NULL,
    "timestampId" UUID NOT NULL,
    "periodAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "audit_anchors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consumer_apps" (
    "id" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "apiKeyHash" VARCHAR(128) NOT NULL,
    "mtlsFingerprint" VARCHAR(64),
    "allowedScopes" JSONB NOT NULL,
    "webhookSecret" VARCHAR(128) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',

    CONSTRAINT "consumer_apps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "store_records" (
    "seq" SERIAL NOT NULL,
    "kind" VARCHAR(20) NOT NULL,
    "rkey" VARCHAR(128) NOT NULL,
    "data" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "store_records_pkey" PRIMARY KEY ("seq")
);

-- CreateTable
CREATE TABLE "webhook_deliveries" (
    "id" UUID NOT NULL,
    "requestId" UUID NOT NULL,
    "eventType" VARCHAR(30) NOT NULL,
    "targetUrl" VARCHAR(500) NOT NULL,
    "payload" JSONB NOT NULL,
    "hmac" VARCHAR(128) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastAttempt" TIMESTAMPTZ,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "key_materials_ownerType_ownerRef_idx" ON "key_materials"("ownerType", "ownerRef");

-- CreateIndex
CREATE UNIQUE INDEX "certificates_serialNumber_key" ON "certificates"("serialNumber");

-- CreateIndex
CREATE UNIQUE INDEX "certificates_keyId_key" ON "certificates"("keyId");

-- CreateIndex
CREATE INDEX "certificates_ownerType_ownerRef_idx" ON "certificates"("ownerType", "ownerRef");

-- CreateIndex
CREATE INDEX "certificates_status_idx" ON "certificates"("status");

-- CreateIndex
CREATE INDEX "cert_revocations_serialNumber_idx" ON "cert_revocations"("serialNumber");

-- CreateIndex
CREATE UNIQUE INDEX "signature_requests_idempotencyKey_key" ON "signature_requests"("idempotencyKey");

-- CreateIndex
CREATE INDEX "signature_requests_externalSystem_externalDocType_externalD_idx" ON "signature_requests"("externalSystem", "externalDocType", "externalDocId");

-- CreateIndex
CREATE INDEX "signature_requests_status_createdAt_idx" ON "signature_requests"("status", "createdAt");

-- CreateIndex
CREATE INDEX "signer_participants_requestId_signOrder_idx" ON "signer_participants"("requestId", "signOrder");

-- CreateIndex
CREATE UNIQUE INDEX "signatures_participantId_key" ON "signatures"("participantId");

-- CreateIndex
CREATE UNIQUE INDEX "signatures_timestampId_key" ON "signatures"("timestampId");

-- CreateIndex
CREATE INDEX "signatures_requestId_idx" ON "signatures"("requestId");

-- CreateIndex
CREATE INDEX "identity_verifications_subjectRef_idx" ON "identity_verifications"("subjectRef");

-- CreateIndex
CREATE INDEX "audit_trails_requestId_occurredAt_idx" ON "audit_trails"("requestId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "audit_certificates_requestId_key" ON "audit_certificates"("requestId");

-- CreateIndex
CREATE INDEX "store_records_kind_rkey_idx" ON "store_records"("kind", "rkey");

-- CreateIndex
CREATE INDEX "webhook_deliveries_status_idx" ON "webhook_deliveries"("status");

-- AddForeignKey
ALTER TABLE "certificates" ADD CONSTRAINT "certificates_keyId_fkey" FOREIGN KEY ("keyId") REFERENCES "key_materials"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "certificates" ADD CONSTRAINT "certificates_issuerCertId_fkey" FOREIGN KEY ("issuerCertId") REFERENCES "certificates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cert_revocations" ADD CONSTRAINT "cert_revocations_certId_fkey" FOREIGN KEY ("certId") REFERENCES "certificates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signer_participants" ADD CONSTRAINT "signer_participants_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "signature_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signatures" ADD CONSTRAINT "signatures_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "signature_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signatures" ADD CONSTRAINT "signatures_participantId_fkey" FOREIGN KEY ("participantId") REFERENCES "signer_participants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signatures" ADD CONSTRAINT "signatures_certificateId_fkey" FOREIGN KEY ("certificateId") REFERENCES "certificates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signatures" ADD CONSTRAINT "signatures_timestampId_fkey" FOREIGN KEY ("timestampId") REFERENCES "timestamps"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signatures" ADD CONSTRAINT "signatures_identityVerificationId_fkey" FOREIGN KEY ("identityVerificationId") REFERENCES "identity_verifications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_trails" ADD CONSTRAINT "audit_trails_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "signature_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_certificates" ADD CONSTRAINT "audit_certificates_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "signature_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

