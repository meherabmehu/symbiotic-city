# SYMBIOTIC CITY — Competition FINAL (complete)

Binary deliverables for Hack the Vibe 2026 / World Problem Solver track
(A02 · Intelligent Decisions & Optimization, A07 · Automated Multi-Step Workflow).
This orphan branch keeps binaries **out of the main repository history**.

## Files

| File | Size (bytes) | SHA-256 |
|---|---|---|
| `SYMBIOTIC_CITY_Competition_FINAL.mp4` | 38,710,091 | `feaea30af7df76a53e7f550769f0b4fae587fa848c778465e6e8afedfe0b8148` |
| `SYMBIOTIC_CITY_Competition_FINAL.srt` | 12,088 | `56f860c828f815abb26139942a01ed912ae11661713ee268c07f14fd52184066` |

## Specs

- 8:58 (537.8 s) · 1920×1080 · 30 fps · H.264 CRF19 · yuv420p · AAC 192k · faststart
- −16.2 LUFS integrated · −1.5 dBFS true peak · 0 decode errors · 0 black frames
- 25 scenes · 114 synced subtitle cues · offline Piper TTS narration (no paid APIs, no music)

## What this cut demonstrates (all real application runs on the isolated demo stack)

- Full platform walkthrough: dashboard, 3D twin, infrastructure, AI panels, simulation,
  incidents, CP-SAT optimization, explainability, resources, dispatch, workflows,
  resilience, analytics, admin/audit, engineering limits.
- **A02 success + genuine infeasible case** (4:11–5:24): CP-SAT optimal allocation, then
  two mandatory priority-1 demands over-constrained — live preview proves INFEASIBLE
  ("total demand 400 exceeds total resource capacity 335"), persisted plan refuses
  approval, safe constraint-relief re-solve recovers.
- **A07 failure & recovery** (5:57–7:37): real workflow from a fresh on-camera incident
  report, human approval gate, armed fault fires mid-reservation, compensation releases
  every hold, idempotent retry, field execution, terminal state 10/10 + incident resolved.

## Honesty notes

- **AI text is the platform's labelled deterministic engine.** The recording sandbox has
  no `GROQ_API_KEY`, and its egress TLS-blocks api.groq.com; the live Render deployment
  cannot be recorded from this environment either. No scene displays or claims an
  `LLM (Groq)` label. Per-request API evidence (endpoint, status, provider, truncation):
  `SYMBIOTIC_CITY_Competition_Evidence_Report.md` on the main branch. To produce a
  genuine Groq cut, run the same pipeline with the key via the authorized env mechanism.
- Aurora Vale is a synthetic demonstration city; decision support, not a validated
  electrical solver. No production systems were touched.
