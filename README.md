# SYMBIOTIC CITY — Competition Video Assets

Binary deliverables for the Hack the Vibe 2026 / World Problem Solver track video.
This orphan branch exists so the binaries stay **out of the main repository history**.

## Files

| File | Size (bytes) | SHA-256 |
|---|---|---|
| `SYMBIOTIC_CITY_Competition_Polished.mp4` | 28,269,240 | `7338fd9c5fc1403c0b9a9e7dfda0f42933159f71141b3d8ab03f4f3d349c7b6b` |
| `SYMBIOTIC_CITY_Competition_Polished.srt` | 8,130 | `ec4b7d7a3f611db5e77dd2af52c7f3703e07e77e09e6a9964aa1270d67e5855f` |

## Video specs

- 1920×1080 · 30 fps · H.264 (CRF 19) · yuv420p · AAC 192k 44.1 kHz stereo · MP4 faststart
- Duration 6:17 (377.1 s) · integrated loudness −16.3 LUFS · true peak −1.5 dBFS
- 22 scenes: opening problem framing → full platform walkthrough → closing
- Voiceover: offline Piper TTS (`en_US-lessac-medium`), regenerated SRT included
- Captions: `SYMBIOTIC_CITY_Competition_Polished.srt` matches the final narration cue-for-cue

## Honesty notes

- Aurora Vale is a **synthetic** demonstration city; all footage is the real application
  running against a freshly seeded local demo database (no production data).
- The video shows the successful CP-SAT optimization (A02) and recovery-workflow (A07)
  paths **only**. The A02-infeasible and A07-failure-recovery demonstrations are planned
  as later insertions (exact timecodes in `SYMBIOTIC_CITY_Future_Clip_Insertion_Guide.md`
  on the main branch) and are **not** fabricated in this cut.
- No copyrighted music; narration only. No paid APIs were used.

## Documentation (main branch, `artifacts/video/`)

- `SYMBIOTIC_CITY_Competition_Video_QA.md` — full timestamped QA report
- `SYMBIOTIC_CITY_Competition_Voiceover.md` — narration script with timecodes
- `SYMBIOTIC_CITY_Future_Clip_Insertion_Guide.md` — A02/A07 insertion points
- `SYMBIOTIC_CITY_Recording_Manifest.json` — scene/VO event schedule
