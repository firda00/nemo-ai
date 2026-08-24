# ADR 002: Execution Sandboxes, Media Rendering, and Multimodal Vision Ingestion

**Status:** Proposed
**Date:** 2026-08-24
**Deciders:** Core Engineering Team
**Consulted:** Security, Infrastructure, AI Research
**Informed:** Product, Executive Team
**Supercedes / Depends on:** ADR 001 (Durable Operations Runtime)

---

## 1. Core Architectural Invariant

> **The Zero-Trust Isolation Invariant:**
> Neither an execution sandbox, nor a GPU rendering node, nor an edge vision gateway shall ever have direct access to the Supabase database, raw tenant secrets, or the internal network perimeter.
> Each worker receives strictly a short-lived **Capability Manifest**, executes a single fenced compute job, and returns only a cryptographically signed **Artifact Manifest** or **Structured Event Manifest**.

---

## 2. Threat Model & Attack Vectors

| Threat Vector | Mitigation Strategy |
| :--- | :--- |
| **Host / Container Escape** | Read-only root filesystem, unprivileged user namespaces (`uid=10001`), seccomp filter dropping `CAP_SYS_ADMIN`, `CAP_NET_RAW`. WASM runtime for lightweight code. |
| **Network Exfiltration / SSRF** | Physical Egress Proxy with DNS rebinding defense, private/link-local address blocking (IPv4 `10.0.0.0/8`, `127.0.0.0/8`, `169.254.0.0/16`, `192.168.0.0/16`, `172.16.0.0/12`), strict allowlist only. |
| **Denial of Service & Bombs** | Linux cgroups v2 resource ceilings, hard CPU timeouts (`SIGKILL`), max file count limits, in-memory `tmpfs` disk quota (64 MB), decompression ratio limits. |
| **PII & Secret Leakage in Logs** | Automated stream redaction (regex masking for API keys, tokens, phones), hard-capped stdout/stderr captures (max 64 KiB), stripped environment variables. |
| **Prompt Injection via Vision/VLM** | All VLM outputs and OCR texts are treated as **Untrusted Data Strings**, never executed as direct instructions, and subject to strict JSON schema validation before ingestion. |
| **Camera Replay / Spoofing** | Device-level HMAC/TLS client certificates, monotonic millisecond timestamps with a ±30-second sliding window, and unique UUIDv7 event IDs. |

---

## 3. Workload Profiles & Resource Limits

| Profile | Target Workload | Runtime Engine | CPU Quota | Memory Ceiling | Timeout | Network Policy |
| :--- | :--- | :--- | :---: | :---: | :---: | :---: |
| **Profile A: WASI Core** | Pure logic, math, data transformation, eval scripts | Extism / Deno WASI | 0.5 vCPU | 64 MB | 5 sec | Deny-All (Air-gapped) |
| **Profile B: Documents** | Typst CLI, Marp presentation compiler | Dedicated CLI Container | 1.0 vCPU | 256 MB | 15 sec | Deny-All (Assets inlined) |
| **Profile C: Browser / Media** | Headless Chrome, Remotion, FFmpeg assembly | Multi-process Container | 2.0 vCPU | 1024 MB | 120 sec | Allowlist CDN/Proxy |
| **Profile D: GPU Worker** | Wan2GP, Image/Diffusion, Edge VLM | Isolated Host / CUDA | 4.0 vCPU | 4096 MB + VRAM | 300 sec | Isolated Host Loopback |

*Note on Local Development:* Linux KVM / Firecracker microVMs represent the production security tier. For local Windows/macOS development, an unprivileged Docker / WASI runner profile is provided as a non-security test harness.

---

## 4. Contract Specifications

### 4.1. Compute Job Model (`runtime.compute_jobs`)

Compute jobs are decoupled from external transactional side effects (`runtime.outbox_actions`) into a dedicated compute table:

```json
{
  "job_id": "01917b12-3a5c-7d9e-bf33-9118c7e7b8a1",
  "workflow_id": "01917b12-3a5c-7d9e-bf33-9118c7e7b800",
  "account_id": "01917b12-3a5c-7d9e-bf33-9118c7e7b801",
  "profile": "PROFILE_A_WASI",
  "fencing_token": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "lease_epoch": 1,
  "input_payload": {
    "entrypoint": "main.wasm",
    "parameters": { "tax_rate": 0.12, "items": [] }
  }
}
```

### 4.2. Output Manifest (`ArtifactManifest`)

```json
{
  "job_id": "01917b12-3a5c-7d9e-bf33-9118c7e7b8a1",
  "status": "COMPLETED",
  "exit_code": 0,
  "execution_time_ms": 342,
  "stdout_sanitized": "Compiled 1 document successfully.",
  "stderr_sanitized": "",
  "artifacts": [
    {
      "name": "commercial_offer.pdf",
      "mime_type": "application/pdf",
      "size_bytes": 104857,
      "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      "storage_path": "tenants/acc_01/artifacts/2026/08/24/commercial_offer.pdf"
    }
  ],
  "provenance": {
    "engine_version": "typst-v0.11.0",
    "template_hash": "a591a6d40bf420404a011733cfb7b190d62c65bf0bcda32b57b277d9ad9f146e",
    "seed": 42
  }
}
```

### 4.3. Vision Event Contract (`VisionEvent`)

```json
{
  "event_id": "01917b12-3a5c-7d9e-bf33-9118c7e7b8c2",
  "account_id": "01917b12-3a5c-7d9e-bf33-9118c7e7b801",
  "device_id": "cam-service-bay-02",
  "timestamp": "2026-08-24T14:58:40.120Z",
  "event_type": "BAY_VEHICLE_ENTERED",
  "precision_score": 0.96,
  "bounding_box": { "x": 120, "y": 340, "width": 800, "height": 450 },
  "untrusted_attributes": {
    "license_plate_raw": "01A777AA",
    "vehicle_color": "white"
  },
  "snapshot_ref": "tenants/acc_01/vision/2026/08/24/snap_01917b12.jpg",
  "device_signature": "ed25519:7f83b1657ff1fc53b92dc18148a1d65dfc2d4b1fa3d677284addd200126d9069"
}
```

---

## 5. Storage Security & Ephemeral Access

1. **Strict Key Scoping:** Object Storage keys enforce a rigid path hierarchy:
   `tenants/<account_id>/<category>/<year>/<month>/<day>/<uuid>.<ext>`
2. **Presigned Upload Policy:** Workers receive ephemeral S3 presigned PUT URLs with:
   - Strict max content-length header matching the profile ceiling.
   - Enforced `Content-Type` matching expected MIME.
   - Fixed SHA-256 checksum pre-calculation.
   - Expiration limit of 5 minutes.
3. **Vision Ring Buffer:** Ingested RTSP streams are kept in a circular volatile **RAM buffer (10 seconds)**. Frames are discarded automatically unless a high-confidence event trigger writes a single JPEG snapshot to tenant storage under data retention policies.

---

## 6. Implementation Roadmap

```text
[Stage 0: Contracts & Threat Model]
        │
        ▼
[Stage 1A: Network-Denied WASI/Deno Core Sandbox] ──► (Math, logic, data cleaning)
        │
        ▼
[Stage 1B: Document Generation Worker] ─────────────► (Typst PDF, Marp presentations)
        │
        ▼
[Stage 2: Asynchronous Media & Storage Pool] ───────► (FFmpeg, Remotion, S3 manifests)
        │
        ▼
[Stage 3: Vision Gateway (Shadow Ingest Only)] ──────► (RTSP, YOLO triggers, Inbox Events)
        │
        ▼
[Stage 4: Grounding, Precision Evals & Live Gate] ──► (Operational actions enabled)
```
