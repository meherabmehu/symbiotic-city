# SYMBIOTIC CITY — Competition Final (Pre-Edge-Cases)

Binary deliverables for Hack the Vibe 2026 / World Problem Solver track.
This orphan branch keeps the binaries **out of the main repository history**.

## Files

| File | Size (bytes) | SHA-256 |
|---|---|---|
| `SYMBIOTIC_CITY_Competition_Final_PreEdgeCases.mp4` | 30,403,944 | `4d7aaaf4633bd37fa58d2639f5c5a19442a89274c67e1b2d627c8d8a952fd4a7` |
| `SYMBIOTIC_CITY_Competition_Final_PreEdgeCases.srt` | 9,005 | `b15b28367f12f91a3e7b1acfdd08e98c52db12dcb8bd6f0f445e0afd17499563` |

## Specs

- 6:55 (415.4 s) · 1920×1080 · 30 fps · H.264 CRF19 · yuv420p · AAC 192k · faststart
- −16.2 LUFS integrated · −1.5 dBFS true peak · 0 decode errors · 0 black frames
- 22 scenes: problem/solution framing → 20-screen walkthrough → closing
- Narration: offline Piper TTS (en_US-lessac-medium); English SRT regenerated from the final mix

## Honesty notes

- **AI scenes show the platform's labelled deterministic engine.** The recording
  sandbox has no `GROQ_API_KEY`, and its egress blocks both api.groq.com and
  authenticated recording of the live deployment — so no scene displays or
  claims an `LLM (Groq)` label. Per-request API evidence (endpoint, HTTP status,
  provider value, truncation flag) is in `SYMBIOTIC_CITY_Competition_AI_Evidence.md`
  on the main branch. To produce a genuine Groq cut: run the same pipeline with
  `GROQ_API_KEY` in the authorized env mechanism — the recorder auto-captures the
  provider label and model id.
- **A02-infeasible and A07-failure-recovery demos are NOT included** (user records
  them later). Insert points 4:29 and 5:35 with matching narration, caption,
  transition and audio guidance: `SYMBIOTIC_CITY_EdgeCase_Insertion_Guide.md`.
- Aurora Vale is a synthetic demonstration city; all footage is the real
  application against a freshly seeded local demo database. No paid APIs, no music.
