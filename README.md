# MV7+ Control

A browser dashboard for every setting on a Shure MV7+ over USB: gain and mode,
mute, tone, filters, compressor, limiter, voice isolation, popper stopper,
monitor levels, reverb, the LED panel and device naming. Runs on Windows with
no install, no admin rights and no daemon.

Open `index.html` in Chrome or Edge, click **Connect microphone**, pick the
MV7+ in the browser dialog. Everything is written straight to the microphone
over WebHID, and the page reads the real values back on connect and on
**Refresh**.

## Requirements

- Windows 10 or 11 with Chrome or Edge (WebHID; Firefox and Safari do not have it).
- Shure MV7+ connected by USB-C. The XLR output is not reachable this way.
- MOTIV Mix closed while the dashboard holds the device. Two hosts writing the
  same settings will fight; close the Shure app if buttons stop responding.
- Optional live meter: any microphone the browser can capture, ideally the MV7+
  itself.

## Run it

Two ways, both local to the PC:

1. **Double-click `index.html`.** It runs from `file://`, which Chrome treats as
   a secure context, so WebHID works.
2. **Double-click `Start Dashboard.cmd`** if the direct file does not work. It
   serves this folder on `http://localhost:8788` with a loopback-only
   PowerShell server and opens the browser. Close the console window to stop it.

`?demo=1` on the URL starts a simulated device with the same protocol, for
trying the interface without hardware.

### Single-file build

`node build-single.mjs` writes `dist/MV7Plus-Control.html`: the same dashboard
with the core script inlined, so one file is enough to copy to another machine.
`dist/mv7plus-dashboard.zip` holds the split version plus the Windows launcher.

### Hosted copy

https://jacoblbagent.github.io/mv7plus-dashboard/ serves the same two files over
HTTPS. WebHID only needs a secure context, so the hosted page controls whatever
MV7+ is plugged into the machine running the browser; nothing is sent to the
server, which only delivers static files.

## Controls

| Card | What it sets | Device value |
|---|---|---|
| Input | Mute | `[01 04]` 0/1, same mute as the touch pad |
| Input | Gain 0–36 dB, 0.5 dB steps | `[01 02]` u16 big-endian, hundredths of a dB |
| Input | Manual / Auto Level | `[01 85]` 0/1. Auto overrides manual gain |
| Input | Gain lock | `[01 F3]` 0/1. Locks the gain control |
| Processing | Tone, −100% Dark to +100% Bright, 10% steps | `[02 04]` i16 big-endian, percent |
| Processing | High-pass filter Off / 75 Hz / 150 Hz | `[01 06]` 0/1/2 |
| Processing | Compressor Off / Light / Medium / Heavy | `[01 5C]` 0–3 |
| Processing | Limiter | `[01 51]` 0/1 |
| Processing | Voice Isolation (denoiser) | `[01 58]` 0/1 |
| Processing | Popper Stopper | `[03 81]` 0/1 |
| Monitoring | Mic level 0–100% | `[01 86]` prefix 0x00 |
| Monitoring | Playback level 0–100% | `[01 86]` prefix 0x03 |
| Monitoring | Mute button enabled | lock `[0C 00 60]` 1 = active |
| Reverb | Output, monitoring, type Plate/Hall/Studio, intensity | `[03 82]`, `[03 85]`, `[03 83]`, `[03 84]` |
| LED | Behavior Live/Pulsing/Solid | lock `[0C 00 A4]` 0/1/2 |
| LED | Brightness Low/Med/High/Max | lock `[0C 00 42]` 3–6 |
| LED | Live theme and three zone colors | lock `[0C 00 96]`, `[0C 00 98/99/A0]` RGB |
| LED | Solid and pulsing theme and color | lock `[0C 00 A5/A2]`, `[0C 00 A6/A3]` |
| Device | Name (31 ASCII characters), firmware, serial, factory reset | lock `[00 00 12]`, `[00 00 09]`, `[00 00 02]`, `[00 00 22]` |

Custom LED colors only appear while the matching theme is set to Custom. The
pulsing theme is written but not read back: its read address collides with the
configuration-lock feature on this firmware.

Presets store a snapshot of the DSP, monitoring and LED settings in this
browser's local storage, with JSON export and import. Applying a preset leaves
mute alone, turns Auto Level and gain lock off around the gain write, then
restores them.

## What it does not do

- Firmware updates. Use MOTIV Mix or the MOTIV mobile app; pushing firmware
  from an unofficial tool can brick the microphone.
- Sample rate and bit depth. Those are USB audio class settings owned by
  Windows, not part of this control protocol.
- Recording, routing or virtual devices.

## How it works

The MV7+ exposes a vendor HID interface (VID `0x14ED`, PID `0x1019`, usage page
`0xFF09`, report ID 1, 64-byte reports). Commands are binary packets with a
CRC-16/ANSI checksum; every SET must be followed immediately by a CONFIRM
packet, and the device answers a CONFIRM with an ack plus an echo. There is no
bulk state read, so the page issues one GET per setting.

```
[01] [len] [11 22] [seq] [hdr] [08] [dlen] [70] [dlen] [cmd×3] [prefix] [feat×2] [value…] [crc16]
```

`hdr` is `0x03` for GETs and `0x00` for every MV7+ SET. `mv7-core.js` holds the
framing, CRC, transaction queue and readback table; `index.html` is the UI and
the WebHID transport.

## Tests

```
node --test test/core.test.js
```

`test/go-vectors.txt` holds twelve frames generated by a Go implementation of
the same protocol (the community `mv7-linux-support` project), so the test
proves this port emits byte-identical packets, not just self-consistent ones.
The remaining tests drive a simulated device through every setting.

## Credits

Protocol knowledge comes from public reverse-engineering work on this hardware:

- `awlx/mv7-linux-support` — MV7+ feature addresses, value encodings, LED page.
- `Humblemonk/shurectl` — packet framing, CRC, CONFIRM/ack behaviour, quirks.
- `schlarpc/shure-mv7-firmware-re` — MV7 vendor console documentation.

No code from those projects is included; this is an independent JavaScript
implementation of the documented wire format. Shure and MV7+ are trademarks of
Shure Incorporated. This project is unofficial and not supported by Shure.
