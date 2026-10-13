---
name: baofeng
description: Operate the Baofeng UV-5R on the bench through the `baofeng` CLI and the AIOC cable, with JSON output. Use when the user mentions the Baofeng, the UV-5R, the AIOC, tuning or keying the radio, a memory channel, CTCSS or DCS tones, repeater offsets, PTT, backing up the radio, menu settings, voice or beep, squelch, listening to receive audio, or audio levels.
---

# baofeng

`tune` writes a frequency into the memory channel the radio is parked on. The radio applies
it about 3 s after the command ends.

Run commands from the repo root. `baofeng` below means `node src/main.ts`.

## Operating rules

- Never open, `cat`, `screen` or `stty` the serial port.
- Run one verb at a time.
- Start every task with `baofeng status`.
- Exit 3 means no device. Exit 5 means the radio did not answer. Ask the human to check
  the radio is on and the cable is seated.
- Ask the human once per session to read the channel number off the radio display. Call it N.
- Pass `--channel N` to every `tune`.
- Trust the display for the active channel. `status` channelA and channelB come from
  EEPROM and may differ from it.
- Run verbs back to back. The CLI retries the handshake once.
- Output is JSON when piped. `--json` is optional.
- `key` transmits on whatever the radio is tuned to. Key only when the human asked and the
  frequency is one they may transmit on.

## Verbs

```sh
baofeng status
baofeng tune 154.680 --channel 5
baofeng tune 146.820 --channel 5 --offset -0.6 --tone 82.5 --name "BIG SKY"
baofeng tune 462.5625 --channel 5 --narrow --low-power
baofeng read 5
baofeng erase 127
baofeng key --seconds 2
baofeng dump --out radio.img
baofeng restore radio.img --force
baofeng settings
baofeng settings voice eng beep on
baofeng listen --seconds 5
```

`status` reports `squelch`, `voice`, `beep` and `abr`. `voice off` or `beep off` mutes receive
audio on this firmware: set them back with `settings`, then ask the human to power cycle
the radio. `listen` reports dBFS from the AIOC. The bare AIOC floor at 1x gain reads about
-66; open-squelch static reads well above -30. Seconds of digital zero come back as `null`
in `rmsDbfs` and count in `zeroSeconds`. Denied microphone permission for the terminal is
one cause.

Frequencies in MHz, 136-174 or 400-520. Tones: `82.5`, `D023`, `D023I`, `none`.
`scenarios/big-sky-2026-10.json` holds the Big Sky channel list and sweep windows.
