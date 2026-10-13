# Review of the settings and listen change, 2026-10-13

Adversarial review of the uncommitted diff. Typecheck and all 70 tests pass. The settings field
offsets match CHIRP's uv5r.py struct. `writeSettings` follows the measured rule: both
halves, then the 0x0E40 commit.

## Defects

1. `.claude/skills/baofeng/SKILL.md` says a silent radio reads about -49 dBFS. `listen`
   high-passes at 50 Hz, so the floor reads about -66. Put the measured number in the
   skill; the README already has it.
2. `--seconds` in the help text and README options table describes `key` only. `listen`
   takes whole seconds from 1 to 600; document that range.
3. `listen` reports success after ffmpeg errors or timeouts if any RMS data arrived.
   Reject failed or incomplete captures. Test the subprocess path, including partial
   output before failure. Report exact-zero audio explicitly instead of unexplained
   JSON nulls; zeros alone do not prove microphone permission was denied.
4. The `status` summary in `main.ts`, the README verb comment and the skill description
   omit the new fields squelch, voice, beep and abr.
5. `summarize` trims trailing RMS frames but keeps their peaks. An excluded third frame
   can give a two-second capture a 0 dBFS peak. Trim both to the same interval and test it.
6. `docs/rx-audio-investigation.md` still presents superseded 32/64-byte repair writes
   as instructions. Mark them historical and point to the verified procedure. Its claim
   that hardware was cleared also conflicts with the unresolved receive-path findings.

## Cut

7. Consolidate empty-capture handling in `audio.ts`, retaining a useful error and test.
8. `ffmpegArgs` takes a `rate` parameter no caller passes. `HIGHPASS_HZ` is exported and
   nothing imports it. `-loglevel info` sets ffmpeg's default.
9. Keep the same-session verification rejection: it is the only mismatch-error test.
   Remove only assertions that test the fake itself. Extend `applySettings` coverage
   from bytes 1..0x0D to every unpatched byte.
10. Trim repeated staging rules and incident history from README. Clarify that 64-byte
    reads avoid aliasing but still return the reload snapshot. Describe the selected
    audio device, with `AIOC Audio` as the default.
11. The settings help text lists the names by hand and omits the numeric ranges. Generate
    it from `SETTINGS_FIELDS`.

## Judgment calls

12. `ADDR.settingsBlock` is 0x0E40 and `SETTINGS_BASE` is 0x0E20; both are described as
    the settings block. Rename the first.
13. Test the settle, new-session, verify sequence used by both write verbs. The test must
    exercise the wait and handshake; manually calling `dropSession()` bypasses the risk.
    Extract a shared helper only if needed.
14. Keep the real restore-path test. Controlled timers can remove its 20 s of sleeps
    without replacing it with write-order assertions.
15. The fake ignores other writes throughout 0x0E00..0x0E7F, beyond the measured ignored
    fields. State that assumption; do not invent replacement hardware behaviour.
16. Rename "repairs a zeroed block": it restores eight exposed fields, not dtmfst,
    pttlt or LED bytes. The bench notes report full settings-byte restoration, but RX
    audio remains unresolved.

## Minor

- `readSettingsBlock` and `SettingField` are exported and used only in their own files.
- `SETTINGS_BASE & ~0x3f` hides the literal 0x0E00.
- Keep `Number.isInteger`: failed regex matches become NaN, which passes `n > max`.
  Removing the guard would let invalid input become a zero byte.
- `imageSettingsBlock` adds another bare `8 +` image header offset.

## Plan

Fix capture failures and measurement windows first, then test the session transition.
Correct the docs, preserve mismatch coverage, and finish with the small cleanups.
