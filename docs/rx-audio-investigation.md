# RX audio investigation, 2026-10-12

The bench UV-5R (firmware HN5RV011) delivers no receive audio through the AIOC. This note
records what was measured, the cause, and the work needed to repair the radio and harden
the CLI. Measurement cleared the capture tooling, macOS microphone permission, CoreAudio
volume and mute, and the AIOC firmware registers. The AIOC receive path remains open; see
the Open section.

## Symptom

`ffmpeg -f avfoundation -i ":AIOC Audio"` captures a flat line at about -49 dBFS. Played
through the MacBook speakers it gives under a second of noise at start, then silence.

## What was measured and cleared

| Layer | Test | Result |
|---|---|---|
| Capture tooling | ffmpeg avfoundation and a native AVAudioEngine capture selected by CoreAudio UID `...:2` | Identical samples. Tooling is fine. |
| macOS permission | Sample values | Non-zero. A TCC denial or host mute gives exact zeros. |
| CoreAudio | Input volume and mute on both elements of the AIOC input device | Volume 1.0, mute 0. |
| AIOC stream | Raw int16 samples over 1 s | 13 adjacent 12-bit codes, -16 to -208 in int16, about 7 LSB below mid-scale, zero zero-crossings. This is the ADC bias with no AC on the speaker line. |
| AIOC firmware | HID feature-report register reads | Magic `AIOC` (firmware 1.3+), `AUDIO_RX` 0x72 = 0 (1x gain), PTT1 source 0x404 (DTR and not RTS), PTT idle, record rate 48000, record volume 0xFFFF both channels. Factory defaults. |
| AIOC hardware revision | v1.2 schematic note | The speaker net reaches both PB2 (1x path) and the OPAMP1 input, so 1x gain reads the real input on every board revision. |
| Serial port | `lsof` on the AIOC tty and cu devices | Nothing holds the port. The transport sets DTR low and RTS low on open. |
| Clone mode exit | Raw `S` read with no magic at 1 s, 4 s and 8 s after a session | Reply at 1 s, no reply at 4 s and 8 s. The radio leaves clone mode as `protocol.ts` assumes. Audio stayed flat across the whole window. |
| Radio service squelch thresholds | Aux bytes 0x1F60 and 0x1F80 in the dump | Plausible ramps, unchanged from the fixture. |

Three research agents covered the AIOC firmware, UV-5R behaviour and macOS USB audio.
Their findings that matter here:

- Nothing in AIOC firmware gates the RX ADC for serial, CDC, DTR, RTS or PTT state.
- On the BFB297 firmware family, which HN5RV011 derives from, VOICE set to OFF cuts receive
  audio until the setting is restored and the radio is power cycled. On N5R-20 and N5R-30
  firmware, BEEP set to OFF mutes audio. Sources are in the memory note
  `uv5r-settings-block-quirk` and the Miklor FAQ sections 2.10 and the buytwowayradios
  "stops receiving after CHIRP upload" post.
- Some UV-5R units detect the plug by a DC load and keep the internal speaker live
  (AIOC issue 106). Check this if the fix below restores settings and audio stays absent.

## Cause

Compare the committed fixture, dumped before any write, with a dump taken today.

| Address | Fixture | Today |
|---|---|---|
| 0x0E20 | `03 00 00 03 00 00 05 00 01 03 00 00 00 00 01 00` | `00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00` |
| 0x0E30 | `03 00 00 00 05 02 02 00 00 00 00 00 00 03 01 02` | `00 00 00 00 00 02 00 00 00 00 00 00 00 00 00 00` |
| 0x0E40 | `00 00 00 01 05 00 01 00 01 00 9f 00 00 01 80 00` | `00 00 00 01 05 00 01 00 01 00 1f 00 01 00 80 00` |

Decoded with CHIRP's `uv5r.py` settings struct at 0x0E20:

| Byte | Field | Fixture | Today |
|---|---|---|---|
| 0x0E20 | squelch | 3 | 0 |
| 0x0E23 | save | 3 | 0 |
| 0x0E26 | abr (backlight) | 5 | 0 |
| 0x0E28 | beep | 1 | 0 |
| 0x0E29 | timeout | 3 | 0 |
| 0x0E2E | voice | 1 (English) | 0 (off) |
| 0x0E30 | dtmfst | 3 | 0 |
| 0x0E34 | pttlt | 5 | 0 |
| 0x0E35 | mdfa | 2 (name) | 2 (name) |
| 0x0E36 | mdfb | 2 | 0 |
| 0x0E3D..3F | wtled, rxled, txled | 3, 1, 2 | 0, 0, 0 |

The live 0x0E30 block is a zero-filled buffer with only `mdfa` set. The deleted
`CODE_REVIEW.md` in the first commit lists `ADDR.tdr`, `ADDR.mdfa`, `ADDR.mdfb`,
`ADDR.vfoa` and `ADDR.vfob` as addresses with no production callers, so an earlier version
of the CLI wrote display mode and related settings and that code was removed. The README
says the radio acks and ignores those writes. The radio applied them. Voice OFF and beep
OFF followed, and on this firmware that mutes receive audio.

The 0x0E40 changes are the work mode byte flipping to channel mode and the display A/B
flag clearing. Those match knob and key use and need no repair.

## Protocol quirks found on this firmware

- A 16-byte read at 0x0E10, 0x0E20, 0x0E30 or 0x0E40 returns the 0x0E40 record. A 64-byte
  read at 0x0E00 returns the true layout. `dumpImage` uses 64-byte reads, so dumps are
  correct. `readStatus` reads 0x0E40 with 16 bytes and gets the right record by luck.
- A 16-byte write at 0x0E20 or 0x0E30 is acked and ignored. Verified by writing the fixture
  bytes, reading back in the same session and again in a fresh session.
- `restoreImage` writes 0x0E00 to 0x1800 in 16-byte blocks. In the settings region those
  writes do nothing, so `restore` cannot repair this damage.
- The write size that zeroed the region is unknown. The early code is gone from history.
  A 32-byte write at 0x0E20 and a 64-byte write at 0x0E00 are the candidates. Neither was
  run; both were blocked by the permission classifier in the session that found this.

## Repair steps

This is the morning plan. "Result, 2026-10-12 afternoon" records what was done, and its
measured rule supersedes the 32-byte and 64-byte write attempts.

Run these on the bench with the human present. Steps 1 to 3 write radio EEPROM and need
explicit permission.

1. Dump first: `node src/main.ts dump --out before-repair.img`.
2. Write the fixture's settings bytes back. Try a 32-byte write at 0x0E20 first. If the
   64-byte readback at 0x0E00 still shows zeros, try a 64-byte write at 0x0E00 using the
   fixture's bytes 0x0E00 to 0x0E3F. Set byte 0x0E20 (squelch) to 0 for the test.
3. Close the session, wait 6 s, capture 5 s from the AIOC and print per-second RMS:

   ```sh
   ffmpeg -hide_banner -loglevel info -f avfoundation -i ":AIOC Audio" -t 5 \
     -af "asetnsamples=48000,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level" \
     -f null - 2>&1 | grep -o "RMS_level=.*"
   ```

   Open-squelch static reads well above -30 dBFS. Flat -49 dBFS means the write did not
   take or the mute has another cause; power cycle the radio and capture again before
   concluding.
4. Write squelch back to 3 with the same block write, then dump and diff against the
   fixture. Only 0x0010, 0x07E0, 0x07F0, 0x1010, 0x17E0, 0x17F0 (channel tunes and names)
   and the 0x0E40 knob bytes should differ.
5. If audio is still absent after the settings read back correctly, have the human set
   menu 14 VOICE to ENG and menu 8 BEEP to ON from the keypad and power cycle. If the
   internal speaker still plays with the AIOC inserted, see AIOC issue 106.

Reference script for step 2, run from the repo root with `node`:

```ts
import { readFileSync } from 'node:fs';
import { SerialTransport, resolveTarget } from './src/transport.ts';
import { Session, hex } from './src/protocol.ts';
const fixture = readFileSync('fixtures/uv5r-hn5rv011-2026-10-12.img');
const size = Number(process.argv[2] ?? 32);          // 32 at 0x0E20, or 64 at 0x0E00
const addr = size === 64 ? 0x0e00 : 0x0e20;
const b = Uint8Array.from(fixture.subarray(8 + addr, 8 + addr + size));
if (process.argv.includes('--sql0')) b[0x0e20 - addr] = 0;
const t = await SerialTransport.open(await resolveTarget(undefined));
const s = new Session(t);
await s.start();
await s.writeBlock(addr, b);
const back = await s.readBlock(0x0e00, 0x40);
for (let i = 0; i < 4; i++) console.log(`0x0E${(i * 16).toString(16).padStart(2, '0')}`, hex(back.subarray(i * 16, i * 16 + 16)));
await t.close();
```

`Session.writeBlock` accepts any length; the radio's reply decides whether it took.

## CLI changes

This is the morning plan. "Result, 2026-10-12 afternoon" records what was done, and its
measured rule supersedes the 32-byte and 64-byte write attempts.

1. `restoreImage`: write the 0x0E00 to 0x0E7F region with the block size the repair proves
   the radio honours, and read back with a 64-byte read to verify. Fail with
   `DeviceStateError` when the readback differs.
2. `readStatus`: read 0x0E00 with 64 bytes and index into it, so the result does not depend
   on the aliasing. Report `voice`, `beep`, `squelch` and `abr` in the status payload. A
   zero `voice` or `beep` on this firmware explains silent RX and belongs in the output.
3. README: replace the sentence that says the radio acks and ignores settings writes.
   State that the radio applied an early display-mode write and that 16-byte writes in
   0x0E10 to 0x0E3F are acked and ignored while 64-byte reads show the true contents.
4. Add a `settings` verb that reads the 64-byte block, decodes it with the CHIRP layout,
   and writes a named field with the proven block size. Scope it to `squelch`, `voice`,
   `beep`, `abr`, `save`, `timeout`, `mdfa`, `mdfb`.
5. Optional: a `listen --seconds N` verb that shells out to ffmpeg and reports mean and peak
   dBFS in JSON, so the receiver check in the README becomes automatic. Device name
   `AIOC Audio`, 48 kHz mono.
6. Add a test with `FakeRadio` that aliases 16-byte reads in 0x0E10 to 0x0E4F to the
   0x0E40 record and ignores 16-byte writes there, so the fixes above are exercised.

## Monitor command

```sh
ffmpeg -hide_banner -loglevel warning -f avfoundation -i ":AIOC Audio" \
  -f audiotoolbox -audio_device_index 3 -
```

Index 3 is MacBook Pro Speakers on this machine. List devices with
`ffmpeg -f lavfi -i anullsrc -t 0.1 -f audiotoolbox -list_devices true -`.

## Result, 2026-10-12 afternoon

The settings block is back to the fixture values. Writes of 16, 32 and 64 bytes on their
own were acked and dropped. A full `restore` of today's image with the fixture bytes
patched in at 0x0E20 took, and a sequence of single writes isolated the rule:

- Writes at 0x0E20 and 0x0E30 land in a 32-byte staging buffer that starts zero-filled
  each session.
- A 16-byte write at 0x0E40 commits the buffer to EEPROM.
- 0x0E20 followed by 0x0E40 committed squelch and zeroed 0x0E30. 0x0E20 followed by 0x0E30
  committed nothing. 0x0E20 followed by 0x0000 committed nothing. 0x0E00 and 0x0E10
  before 0x0E20 committed nothing.

That is how the early display-mode write wiped the block: it wrote the 0x0E30 half, then
the work-mode byte at 0x0E4C, and the radio committed zeros over 0x0E20 with it.

The CLI now has `settings` (read, or write both halves plus the 0x0E40 record and verify
in a fresh session), `restore` verifies the block the same way, `status` reads the page
with 64-byte reads and reports squelch, voice, beep and abr, `listen --seconds N` wraps
the ffmpeg capture, and `FakeRadio` models the alias and the staged commit.

Audio after the repair, without a power cycle: -49 dBFS flat, peak -47. Next step is step 5
above: power cycle the radio, then `baofeng listen --seconds 5`.

## Open, 2026-10-12 evening

After the power cycle and with squelch at 0, the radio plays static from its own speaker
with the AIOC unplugged and mutes it when the AIOC's 3.5 mm plug is seated. The AIOC
capture stays at -49 dBFS with a peak of -47.14 in every run, including with a fingertip
on the unplugged 3.5 mm tip. The AIOC board and solder joints look good under inspection.
Squelch is back at 3.

The samples sit at ADC mid-scale with 13 codes of noise: a clean bias node with no AC on
it. Candidates still untested: the firmware sampling a pin other than the speaker line
(board revision detection), the receive gain or input mux registers, and the AIOC's
RX path before the bias node. Next test: change the AIOC receive gain over HID and watch
whether the noise floor moves.

### Gain sweep, 2026-10-12 evening

The AIOC's RX gain register (HID 0x72, bits 16-19) selects the ADC path: 1x samples PB2
on ADC2 through the static divider, 2x to 16x sample OPAMP1's PGA output from PA5 on ADC1.
`listen` now high-passes at 50 Hz so the bias cannot read as signal. With squelch 0 and the
radio plugged in, AC level by gain: 1x -66, 2x -61, 4x -56, 16x -44 dBFS. That is the ADC
noise floor scaling with gain plus about half a millivolt from the radio at 16x. Static at the jack would clip the 2x range.

The AIOC schematic's K-connector note: 2.5 mm plug tip = SPK+ from the radio, ring =
TxData from the radio, sleeve = GND; 3.5 mm plug tip = +V/PTT2, ring = MIC+, sleeve =
PTT1/RxData. Receive audio enters on the 2.5 mm tip, then C14 (4.7 uF coupling), R5
(5.1 k series) into the node PB2 and PA5 share, with R16 (5.1 k) to ground and C11. Two
finger-hum tests at 16x were run on the 3.5 mm tip by mistake and show nothing about the
receive path. The test to run is a fingertip on the 2.5 mm tip at 16x.

The gain register was written volatile each time and left at 1x; nothing was stored.
