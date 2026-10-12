# Code review

Date: 2026-10-12

Scope: entire repo; the directory is outside git, so there was no diff to scope against.

Method: source inspection, fixture replay through `FakeRadio`, targeted in-memory and mocked CLI reproductions, inspection of the installed serialport implementation, and comparison with upstream [CHIRP `uv5r.py`](https://github.com/kk7ds/chirp/blob/master/chirp/drivers/uv5r.py) retrieved on the review date. The upstream link tracks `master`.

Findings 1 through 4 are confirmed bugs, ordered by severity. Findings 5 and 6 are qualified. Finding 7 is cleanup. Findings 8 and 9 are claims from an earlier review that the code does not support; each restates the original proposal so the rejection can be checked. Finding 10 lists gaps the earlier review missed.

## Confirmed bugs

### 1. Boolean flags accept any `=value`

Location: `src/args.ts:20`, and boolean flag consumers in `src/main.ts`.

The `--flag=value` branch stores the string without consulting the boolean flag set. Callers test truthiness, so `--force=no`, `--force=false`, `--narrow=false` and `--json=false` all enable the flag. An empty value (`--force=`) stays falsy.

Effect: `restore img --force=no` passes the bulk-write confirmation and proceeds once the file, device and image checks pass. `tune ... --narrow=false` requests narrow bandwidth.

Fix: reject `=value` for boolean flags, or accept only `true` and `false`. `parseArgs` cannot throw today and runs outside the `main(...).then(...)` error handler. A throw there creates an unhandled rejection path. Move the call inside the handler in the same change.

### 2. TX-inhibited channels are reported as simplex

Location: `src/codec.ts:192`.

`decodeChannel` substitutes `rxHz` whenever the TX frequency decodes to `undefined`. CHIRP's `_is_txinh` recognizes four `0xFF` TX bytes as TX inhibited and `get_memory` reports duplex `"off"`.

Effect: a receive-only record appears in `read` and `status` with `txMhz` equal to `rxMhz`. A constructed record with valid RX BCD and four `0xFF` TX bytes reproduced this. The CLI never writes this state itself, so it affects radios programmed by CHIRP. The radio still refuses to key on such a channel.

Fix: represent TX inhibition explicitly, for example `txMhz: null`, and update the types and text formatting. Distinguish the all-`0xFF` sentinel from other malformed BCD values, which the same fallback also hides.

### 3. Asynchronous serial failures are not propagated

Location: `src/transport.ts:47`, `src/transport.ts:66`, `src/transport.ts:71`.

The port's `error` listener does nothing, `write()` supplies no callback, and `read()` polls the receive buffer until its deadline. Injecting an asynchronous write error into a mock port produced an empty read after timeout instead of a `TransportError`.

Effect: transport failures surface as protocol timeouts or device-state errors (exit 4 or 5) instead of transport errors (exit 3). Port opening and PTT changes already handle errors through callbacks.

Fix: keep a transport failure state, propagate write failures, and reject pending and later reads once the transport fails. Handle unexpected `close` as well as `error`: the installed serialport stream reports a disconnect through `close(error)`. Distinguish deliberate closure from failure.

### 4. Missing device exits with the usage code

Location: `src/main.ts:70`.

When neither `--target` nor `BAOFENG_TARGET` supplies a path and discovery finds no AIOC, `resolveTarget` throws `UsageError`. A mocked CLI run with an empty port list exited 2 and emitted `kind: "usage"`.

Effect: the README assigns "no device" to transport, exit 3, and `SerialTransport.open` already throws `TransportError` for a missing path. Scripts cannot classify a missing device consistently.

Fix: throw `TransportError` when discovery finds nothing.

## Qualified concerns

### 5. Ctrl-C during `key` reports nothing and handles one signal

Location: `src/main.ts:165`.

The SIGINT handler releases PTT, closes the transport, then exits with `EXIT.unexpected` (1) and no application result. A mocked CLI run confirmed that sequence. Only SIGINT is handled; SIGTERM and SIGHUP fall through to the default exit.

Effect: a consumer receives no structured cancellation or release outcome. If release fails, the handler still exits without reporting that failure. Whether closing the tty on an unhandled signal drops DTR depends on the HUPCL setting of the port; on macOS it usually does.

Fix: share one shutdown path across SIGINT, SIGTERM and SIGHUP that attempts release and reports its outcome. Define the cancellation exit code; 130 is conventional for SIGINT. Measure DTR on an unhandled signal before relying on it.

### 6. CTCSS input accepts nonstandard values

Location: `src/codec.ts:51`.

`parseTone` accepts finite numbers from 60 through 260 Hz and rounds to tenths, with no standard-tone table. `82.6` is accepted and `0x52` parses as 82 Hz through `Number`.

The earlier claim that such values fail on the radio and leave a repeater closed is unproven. CHIRP encodes CTCSS as frequency times ten, so the firmware stores any tenth. The menu list does not show what the firmware generates or what a repeater tolerates.

Fix: decide whether the CLI promises standard tones only and which numeric syntax it supports. Add table validation if that is the contract. Measure before claiming RF failure.

## Cleanup

### 7. Duplicated firmware address and unused symbols

Location: `src/protocol.ts:76`, `src/codec.ts`.

`Session.start` uses literal addresses, including `0x1ec0` despite `ADDR.firmwareBlock`. `ADDR.tdr`, `ADDR.mdfa`, `ADDR.mdfb`, `ADDR.vfoa`, `ADDR.vfob` and `decodeVfoFrequency` have no production callers. The decoder has tests.

Use the shared firmware constant. Remove the unused symbols and the decoder's tests together.

## Rejected claims

### 8. Channel A/B addresses already carry the offset adjustment

Location: `src/codec.ts:18`.

Original proposal: change `mrcha`/`mrchb` from `0x0E76/0x0E77` to `0x0E6E/0x0E6F`, on the theory that the code forgot to subtract the eight-byte image ident, and that this explains the bench display mismatch.

CHIRP's `MEM_FORMAT` places `wmchannel` at image offset `0x0E7E`. The image begins with the eight-byte ident, so the radio addresses are `0x0E76` and `0x0E77`, as in the current code. The proposal subtracts eight twice. `0x0E6E/0x0E6F` also sit before `ADDR.channelBlock` (`0x0E70`), giving negative indexes in `readStatus` and fallback values of zero. The display mismatch has a different cause; see the README's note on EEPROM selectors.

### 9. A `0xFF` channel selector decodes as channel 127 under the CHIRP layout

Location: `src/radio.ts:57`.

Original proposal: treat a raw `0xFF` selector byte as unset, report `channelA`/`channelB` as `null`, and note that the fixture returns a 155.700 record for the active channel.

CHIRP defines each selector as one unused bit and a seven-bit channel number, values 0 through 127. Masking `0xFF` to 127 matches that layout. The fixture holds `0xFF` at both selector addresses, and replaying its main memory through `FakeRadio` gives:

```json
{"channelA":127,"channelB":127,"channel":127,"empty":true}
```

Slot 127 starts with `0xFF`, so `decodeChannel` returns `undefined`. Its raw record is `ff005715000057150000000000000044`. The 155.700 claim is false.

`status` still derives `channel` and the record fields from a selector the README says to distrust. On the fixture it reads a slot the README calls corrupted. Decide what `status` should report when the selector and display disagree.

## Gaps in the earlier review

### 10. Unclassified errors and lax number parsing

- `restore` reads the image file with `readFileSync` before any error class applies. A missing file exits 1 as `unexpected`. `dump` has the same gap on write.
- `read ""` and `read " "` coerce to channel 0 through `Number` at `src/main.ts:147`. Hex such as `0x5` is accepted wherever a number flag is parsed.
- None of the confirmed bugs has a test. Add the reproductions from this review as cases in `test/`.

## Validation

- All 23 existing tests passed (`npm test`).
- Typechecking passed (`npm run typecheck`).
- Targeted checks reproduced boolean parsing, TX-inhibited decoding, swallowed serial errors, missing-device classification, SIGINT behaviour and fixture status output. The checks were run ad hoc.
- Checks used mocks and fixture data. RF behaviour, DTR on signal exit and physical disconnect were not exercised on hardware.
