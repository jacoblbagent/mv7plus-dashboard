// MV7+ control core: packet framing, CRC, transactions and state readback.
//
// Protocol facts are taken from the community reverse-engineering work on the
// MV7+ (VID 0x14ED, PID 0x1019): 64-byte HID reports on report ID 1, a
// CRC-16/ANSI-protected binary packet, and a CONFIRM packet after every SET.
// This file is a browser/Node-neutral module; the transport is injected.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MV7Core = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const PACKET_SIZE = 64;
  const REPORT_ID = 0x01;

  // Command classes: GET/SET for the normal feature space, and GET/SET for the
  // "lock" class that carries the LED page, the mute-button switch and the
  // identity strings.
  const CMD_GET_FEAT = [0x01, 0x02, 0x02];
  const CMD_SET_FEAT = [0x02, 0x02, 0x02];
  const CMD_GET_LOCK = [0x01, 0x02, 0x01];
  const CMD_SET_LOCK = [0x02, 0x02, 0x01];
  const CMD_CONFIRM = [0x01, 0x00, 0x00];

  const RES_GET_FEAT = [0x03, 0x02, 0x02];
  const RES_SET_FEAT = [0x04, 0x02, 0x02];
  const RES_GET_LOCK = [0x03, 0x02, 0x01];
  const RES_SET_LOCK = [0x04, 0x02, 0x01];
  const RES_CONFIRM_ACK = [0x09, 0x00, 0x00];

  // Two-byte feature addresses (see the protocol notes in the README).
  const FEAT = {
    GAIN: [0x01, 0x02],
    MUTE: [0x01, 0x04],
    HPF: [0x01, 0x06],
    LIMITER: [0x01, 0x51],
    DENOISER: [0x01, 0x58],
    COMPRESSOR: [0x01, 0x5C],
    GAIN_LOCK: [0x01, 0xF3],
    AUTO_LEVEL: [0x01, 0x85],
    MIX: [0x01, 0x86], // Mic Level (prefix 0x00) and Playback Level (prefix 0x03)
    POPPER: [0x03, 0x81],
    TONE: [0x02, 0x04],
    REVERB_OUTPUT: [0x03, 0x82],
    REVERB_TYPE: [0x03, 0x83],
    REVERB_INTENSITY: [0x03, 0x84],
    REVERB_MONITOR: [0x03, 0x85],
    DEVICE_NAME: [0x00, 0x12],
    FIRMWARE: [0x00, 0x09],
    SERIAL: [0x00, 0x02],
  };

  // Lock-class addresses are three bytes: [page, 0x00, sub-address].
  const LED = {
    PAGE: 0x0C,
    BRIGHTNESS: 0x42,
    MUTE_BUTTON: 0x60,
    LIVE_THEME: 0x96,
    LIVE_EDGE: 0x98,
    LIVE_MIDDLE: 0x99,
    LIVE_INTERIOR: 0xA0,
    SOLID_COLOR: 0xA2,
    PULSING_COLOR: 0xA3,
    BEHAVIOR: 0xA4,
    SOLID_THEME: 0xA5,
    PULSING_THEME: 0xA6,
    FACTORY_RESET: 0x22,
  };

  // CRC-16/ANSI: polynomial 0x8005 reflected (0xA001), init 0, reflected in
  // and out. Check value: crc16ANSI("123456789") === 0xBB3D.
  function crc16ANSI(bytes) {
    let crc = 0x0000;
    for (let i = 0; i < bytes.length; i++) {
      let byte = bytes[i];
      for (let bit = 0; bit < 8; bit++) {
        const mix = (crc ^ byte) & 1;
        crc >>= 1;
        if (mix) crc ^= 0xA001;
        byte >>= 1;
      }
    }
    return crc & 0xFFFF;
  }

  // Frame a request into a 64-byte report. `headerConst` is 0x03 for GETs and
  // 0x00 for every MV7+ SET. Byte 0 is the HID report ID, which WebHID strips
  // (the transport adds it back on send).
  function buildPacket(seq, command, payload, headerConst) {
    const dataLen = 3 + payload.length + 2;
    const inner = [
      0x11, 0x22,
      seq & 0xFF,
      headerConst,
      0x08,
      dataLen,
      0x70,
      dataLen,
      ...command,
      ...payload,
    ];
    const totalLen = inner.length + 2;
    const crc = crc16ANSI(inner);

    const packet = new Uint8Array(PACKET_SIZE);
    packet[0] = REPORT_ID;
    packet[1] = totalLen;
    packet.set(inner, 2);
    packet[totalLen] = (crc >> 8) & 0xFF;
    packet[totalLen + 1] = crc & 0xFF;
    return packet;
  }

  const getPacket = (seq, prefix, feat) =>
    buildPacket(seq, CMD_GET_FEAT, [prefix, feat[0], feat[1]], 0x03);

  const getLockPacket = (seq, page, sub) =>
    buildPacket(seq, CMD_GET_LOCK, [page, 0x00, sub], 0x03);

  const setPacket = (seq, prefix, feat, value) =>
    buildPacket(seq, CMD_SET_FEAT, [prefix, feat[0], feat[1], ...value], 0x00);

  const setLockPacket = (seq, page, sub, value) =>
    buildPacket(seq, CMD_SET_LOCK, [page, 0x00, sub, ...value], 0x00);

  const confirmPacket = (seq) => buildPacket(seq, CMD_CONFIRM, [], 0x03);

  // Parse one inbound 64-byte report (report ID included in byte 0).
  // Returns null for acknowledgements and packets that fail the CRC.
  function parsePacket(packet) {
    if (!packet || packet.length < 18) return null;
    const contentsEnd = packet[1];
    if (contentsEnd + 2 > packet.length) return null;
    if (packet[2] !== 0x11 || packet[3] !== 0x22) return null;
    const expected = (packet[contentsEnd] << 8) | packet[contentsEnd + 1];
    if (crc16ANSI(packet.subarray(2, contentsEnd)) !== expected) return null;

    const command = [packet[10], packet[11], packet[12]];
    const isData =
      sameBytes(command, RES_GET_FEAT) ||
      sameBytes(command, RES_SET_FEAT) ||
      sameBytes(command, RES_GET_LOCK) ||
      sameBytes(command, RES_SET_LOCK);
    if (!isData) return null;

    return {
      command,
      seq: packet[4],
      prefix: packet[13],
      feat: [packet[14], packet[15]],
      value: packet.slice(16, contentsEnd),
    };
  }

  function sameBytes(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // Decode helpers ---------------------------------------------------------
  const u16 = (v) => ((v[0] << 8) | v[1]) & 0xFFFF;
  const i16 = (v) => {
    const raw = u16(v);
    return raw >= 0x8000 ? raw - 0x10000 : raw;
  };
  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

  function decodeLPString(value) {
    if (!value || value.length < 3) return '';
    const declared = u16(value);
    if (declared !== value.length) return '';
    return String.fromCharCode.apply(null, Array.from(value.subarray(2)));
  }

  function encodeLPString(text) {
    const ascii = asciiOnly(text);
    const length = 2 + ascii.length;
    return [(length >> 8) & 0xFF, length & 0xFF, ...ascii];
  }

  // Device names are printable ASCII; the firmware truncates at 31 bytes.
  function asciiOnly(text) {
    const bytes = [];
    for (const ch of String(text)) {
      const code = ch.charCodeAt(0);
      if (code >= 0x20 && code <= 0x7E) bytes.push(code);
    }
    return bytes.slice(0, 31);
  }

  // Every control the dashboard reads, in display order. `lock` selects the
  // lock command class, `prefix` 0x03 selects Playback Level.
  const READBACK = [
    ['gain', { feat: FEAT.GAIN, apply: (s, v) => { s.gain = u16(v) / 100; } }],
    ['gainLocked', { feat: FEAT.GAIN_LOCK, apply: (s, v) => { s.gainLocked = v[0] !== 0; } }],
    ['muted', { feat: FEAT.MUTE, apply: (s, v) => { s.muted = v[0] !== 0; } }],
    ['autoLevel', { feat: FEAT.AUTO_LEVEL, apply: (s, v) => { s.autoLevel = v[0] !== 0; } }],
    ['hpf', { feat: FEAT.HPF, apply: (s, v) => { s.hpf = v[0]; } }],
    ['limiter', { feat: FEAT.LIMITER, apply: (s, v) => { s.limiter = v[0] !== 0; } }],
    ['compressor', { feat: FEAT.COMPRESSOR, apply: (s, v) => { s.compressor = v[0]; } }],
    ['denoiser', { feat: FEAT.DENOISER, apply: (s, v) => { s.denoiser = v[0] !== 0; } }],
    ['popper', { feat: FEAT.POPPER, apply: (s, v) => { s.popper = v[0] !== 0; } }],
    ['tone', { feat: FEAT.TONE, apply: (s, v) => { s.tone = i16(v); } }],
    ['micMix', { feat: FEAT.MIX, apply: (s, v) => { s.micMix = clamp(v[0], 0, 100); } }],
    ['playbackMix', { feat: FEAT.MIX, prefix: 0x03, apply: (s, v) => { s.playbackMix = clamp(v[0], 0, 100); } }],
    ['muteButton', { lockPage: LED.PAGE, sub: LED.MUTE_BUTTON, apply: (s, v) => { s.muteButton = v[0] !== 0; } }],
    ['reverbOutput', { feat: FEAT.REVERB_OUTPUT, apply: (s, v) => { s.reverbOutput = v[0] !== 0; } }],
    ['reverbType', { feat: FEAT.REVERB_TYPE, apply: (s, v) => { s.reverbType = v[0]; } }],
    ['reverbIntensity', { feat: FEAT.REVERB_INTENSITY, apply: (s, v) => { s.reverbIntensity = clamp(v[0], 0, 100); } }],
    ['reverbMonitor', { feat: FEAT.REVERB_MONITOR, apply: (s, v) => { s.reverbMonitor = v[0] !== 0; } }],
    ['ledBehavior', { lockPage: LED.PAGE, sub: LED.BEHAVIOR, apply: (s, v) => { s.ledBehavior = v[0]; } }],
    ['ledBrightness', { lockPage: LED.PAGE, sub: LED.BRIGHTNESS, apply: (s, v) => { s.ledBrightness = v[0]; } }],
    ['ledLiveTheme', { lockPage: LED.PAGE, sub: LED.LIVE_THEME, apply: (s, v) => { s.ledLiveTheme = v[0]; } }],
    ['ledLiveEdge', { lockPage: LED.PAGE, sub: LED.LIVE_EDGE, apply: (s, v) => { s.ledLiveEdge = [v[1], v[2], v[3]]; } }],
    ['ledLiveMiddle', { lockPage: LED.PAGE, sub: LED.LIVE_MIDDLE, apply: (s, v) => { s.ledLiveMiddle = [v[1], v[2], v[3]]; } }],
    ['ledLiveInterior', { lockPage: LED.PAGE, sub: LED.LIVE_INTERIOR, apply: (s, v) => { s.ledLiveInterior = [v[1], v[2], v[3]]; } }],
    ['ledSolidColor', { lockPage: LED.PAGE, sub: LED.SOLID_COLOR, apply: (s, v) => { s.ledSolidColor = [v[1], v[2], v[3]]; } }],
    ['ledPulsingColor', { lockPage: LED.PAGE, sub: LED.PULSING_COLOR, apply: (s, v) => { s.ledPulsingColor = [v[1], v[2], v[3]]; } }],
    ['ledSolidTheme', { lockPage: LED.PAGE, sub: LED.SOLID_THEME, apply: (s, v) => { s.ledSolidTheme = v[0]; } }],
    ['deviceName', { lockPage: 0x00, sub: FEAT.DEVICE_NAME[1], apply: (s, v) => { s.deviceName = decodeLPString(v) || s.deviceName; } }],
    ['firmware', { lockPage: 0x00, sub: FEAT.FIRMWARE[1], apply: (s, v) => { s.firmware = decodeLPString(v) || s.firmware; } }],
    ['serial', { lockPage: 0x00, sub: FEAT.SERIAL[1], apply: (s, v) => { s.serial = decodeLPString(v) || s.serial; } }],
  ];

  function defaultState() {
    return {
      gain: 0,
      gainLocked: false,
      muted: false,
      autoLevel: false,
      hpf: 0,
      limiter: false,
      compressor: 0,
      denoiser: false,
      popper: true,
      tone: 0,
      micMix: 0,
      playbackMix: 50,
      muteButton: true,
      reverbOutput: false,
      reverbType: 0,
      reverbIntensity: 50,
      reverbMonitor: false,
      ledBehavior: 0,
      ledBrightness: 5,
      ledLiveTheme: 0,
      ledLiveEdge: [255, 255, 255],
      ledLiveMiddle: [31, 31, 31],
      ledLiveInterior: [0, 0, 0],
      ledSolidColor: [178, 255, 51],
      ledPulsingColor: [16, 63, 251],
      ledSolidTheme: 0,
      ledPulsingTheme: 0,
      deviceName: 'MV7+',
      firmware: '',
      serial: '',
    };
  }

  // Client -----------------------------------------------------------------
  //
  // transport: { write(packet: Uint8Array): Promise<void>,
  //              onReport(handler): void }
  // `packet` is the full 64-byte frame; the transport is responsible for the
  // HID report ID. All I/O is serialized, because the device has one command
  // channel and an out-of-order GET would read another setting's reply.
  class Client {
    constructor(transport, options) {
      const opts = options || {};
      this.transport = transport;
      this.seq = 0;
      this.rx = [];
      this.waiter = null;
      this.log = opts.log || function () {};
      this.ackWaitMs = opts.ackWaitMs || 30;
      this.readTimeoutMs = opts.readTimeoutMs || 250;
      this.queue = Promise.resolve();
      this.connected = false;
      transport.onReport((report) => this._onReport(report));
    }

    _onReport(report) {
      const packet = new Uint8Array(PACKET_SIZE);
      packet[0] = report.reportId;
      packet.set(report.data.subarray(0, PACKET_SIZE - 1), 1);
      this.log('rx', packet);

      if (this.waiter && this.waiter.predicate(packet)) {
        const waiter = this.waiter;
        this.waiter = null;
        clearTimeout(waiter.timer);
        waiter.resolve(packet);
        return;
      }
      this.rx.push(packet);
      if (this.rx.length > 64) this.rx.shift();
    }

    _nextSeq() {
      const seq = this.seq;
      this.seq = (this.seq + 1) & 0xFF;
      return seq;
    }

    // Serialize a transaction so concurrent UI writes cannot interleave.
    _enqueue(job) {
      const run = this.queue.then(job, job);
      this.queue = run.then(() => undefined, () => undefined);
      return run;
    }

    async _write(packet) {
      this.log('tx', packet);
      await this.transport.write(packet);
    }

    _readMatch(predicate, timeoutMs) {
      for (let i = 0; i < this.rx.length; i++) {
        if (predicate(this.rx[i])) {
          const packet = this.rx[i];
          this.rx.splice(i, 1);
          return Promise.resolve(packet);
        }
      }
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          this.waiter = null;
          resolve(null);
        }, timeoutMs);
        this.waiter = { predicate, resolve, timer };
      });
    }

    // GET one feature. Returns {prefix, feat, value} or null when the device
    // does not answer (unsupported feature on this firmware).
    get(prefix, feat, options) {
      const opts = options || {};
      return this._enqueue(async () => {
        this.rx.length = 0; // drop anything stale before asking
        const seq = this._nextSeq();
        const packet = opts.lock
          ? getLockPacket(seq, prefix, opts.sub)
          : getPacket(seq, prefix, feat);
        const wantCommand = opts.lock ? RES_GET_LOCK : RES_GET_FEAT;
        const wantPrefix = opts.lock ? prefix : prefix;
        await this._write(packet);
        const reply = await this._readMatch((candidate) => {
          const parsed = parsePacket(candidate);
          if (!parsed) return false;
          if (!sameBytes(parsed.command, wantCommand)) return false;
          if (parsed.prefix !== wantPrefix) return false;
          return parsed.feat[0] === feat[0] && parsed.feat[1] === feat[1];
        }, this.readTimeoutMs);
        return reply ? parsePacket(reply) : null;
      });
    }

    // SET one feature. Writes the SET packet, then the mandatory CONFIRM, then
    // swallows the unsolicited ack/echo so the next GET starts clean.
    set(prefix, feat, value, options) {
      const opts = options || {};
      return this._enqueue(async () => {
        const seq = this._nextSeq();
        const packet = opts.lock
          ? setLockPacket(seq, prefix, opts.sub, value)
          : setPacket(seq, prefix, feat, value);
        await this._write(packet);
        if (opts.confirm !== false) await this._write(confirmPacket(this._nextSeq()));
        // The MV7+ answers a CONFIRM with an ack and, when the value changed,
        // an echo. Both are unsolicited; wait briefly and discard.
        await sleep(this.ackWaitMs);
        this.rx.length = 0;
        return true;
      });
    }

    // Read every setting. Missing answers are skipped, not fatal.
    async readState(onProgress) {
      const state = defaultState();
      let answered = 0;
      for (let i = 0; i < READBACK.length; i++) {
        const [key, spec] = READBACK[i];
        const reply = spec.lockPage !== undefined
          ? await this.get(spec.lockPage, [0x00, spec.sub], { lock: true, sub: spec.sub })
          : await this.get(spec.prefix || 0x00, spec.feat);
        if (reply && reply.value.length) {
          spec.apply(state, reply.value);
          answered++;
        } else {
          this.log('info', key + ': no reply');
        }
        if (onProgress) onProgress((i + 1) / READBACK.length, key);
      }
      if (!answered) throw new Error('The microphone answered no read requests.');
      state.answered = answered;
      return state;
    }

    // Convenience wrappers used by the UI --------------------------------
    setGain(db) {
      const hundredths = Math.round(clamp(db, 0, 36) * 100);
      return this.set(0x00, FEAT.GAIN, [(hundredths >> 8) & 0xFF, hundredths & 0xFF]);
    }
    setGainLocked(locked) {
      return this.set(0x00, FEAT.GAIN_LOCK, [locked ? 1 : 0]);
    }
    setMuted(muted) {
      return this.set(0x00, FEAT.MUTE, [muted ? 1 : 0]);
    }
    setAutoLevel(auto) {
      return this.set(0x00, FEAT.AUTO_LEVEL, [auto ? 1 : 0]);
    }
    setHPF(hpf) {
      return this.set(0x00, FEAT.HPF, [clamp(hpf, 0, 2)]);
    }
    setLimiter(on) {
      return this.set(0x00, FEAT.LIMITER, [on ? 1 : 0]);
    }
    setCompressor(preset) {
      return this.set(0x00, FEAT.COMPRESSOR, [clamp(preset, 0, 3)]);
    }
    setDenoiser(on) {
      return this.set(0x00, FEAT.DENOISER, [on ? 1 : 0]);
    }
    setPopper(on) {
      return this.set(0x00, FEAT.POPPER, [on ? 1 : 0]);
    }
    setTone(percent) {
      const value = clamp(Math.round(percent / 10) * 10, -100, 100);
      const raw = value < 0 ? value + 0x10000 : value;
      return this.set(0x00, FEAT.TONE, [(raw >> 8) & 0xFF, raw & 0xFF]);
    }
    setMicMix(percent) {
      return this.set(0x00, FEAT.MIX, [clamp(percent, 0, 100)]);
    }
    setPlaybackMix(percent) {
      return this.set(0x03, FEAT.MIX, [clamp(percent, 0, 100)]);
    }
    setMuteButton(active) {
      return this.set(LED.PAGE, [0x00, LED.MUTE_BUTTON], [active ? 1 : 0], {
        lock: true,
        sub: LED.MUTE_BUTTON,
      });
    }
    setReverbOutput(on) {
      return this.set(0x00, FEAT.REVERB_OUTPUT, [on ? 1 : 0]);
    }
    setReverbMonitor(on) {
      return this.set(0x00, FEAT.REVERB_MONITOR, [on ? 1 : 0]);
    }
    setReverbType(type) {
      return this.set(0x00, FEAT.REVERB_TYPE, [clamp(type, 0, 2)]);
    }
    setReverbIntensity(percent) {
      return this.set(0x00, FEAT.REVERB_INTENSITY, [clamp(percent, 0, 100)]);
    }
    setLEDBehavior(behavior) {
      return this.set(LED.PAGE, [0x00, LED.BEHAVIOR], [clamp(behavior, 0, 2)], {
        lock: true,
        sub: LED.BEHAVIOR,
      });
    }
    setLEDBrightness(level) {
      return this.set(LED.PAGE, [0x00, LED.BRIGHTNESS], [clamp(level, 3, 6)], {
        lock: true,
        sub: LED.BRIGHTNESS,
      });
    }
    setLEDTheme(kind, theme) {
      const sub = {
        live: LED.LIVE_THEME,
        solid: LED.SOLID_THEME,
        pulsing: LED.PULSING_THEME,
      }[kind];
      return this.set(LED.PAGE, [0x00, sub], [theme], { lock: true, sub });
    }
    setLEDColor(kind, rgb) {
      const sub = {
        liveEdge: LED.LIVE_EDGE,
        liveMiddle: LED.LIVE_MIDDLE,
        liveInterior: LED.LIVE_INTERIOR,
        solid: LED.SOLID_COLOR,
        pulsing: LED.PULSING_COLOR,
      }[kind];
      return this.set(LED.PAGE, [0x00, sub], [0x00, rgb[0], rgb[1], rgb[2]], {
        lock: true,
        sub,
      });
    }
    renameDevice(name) {
      const value = encodeLPString(name);
      return this.set(0x00, FEAT.DEVICE_NAME, value, { lock: true, sub: FEAT.DEVICE_NAME[1] });
    }
    // The device resets and re-enumerates immediately; there is no CONFIRM.
    factoryReset() {
      return this._enqueue(async () => {
        const seq = this._nextSeq();
        await this._write(buildPacket(seq, CMD_SET_LOCK, [0x00, 0x00, LED.FACTORY_RESET, 0x01], 0x00));
        return true;
      });
    }
  }

  // Demo transport ---------------------------------------------------------
  //
  // A stand-in device that speaks the same packet format from memory. It makes
  // the dashboard usable (and testable) without hardware: same parsing, same
  // SET/CONFIRM acks, same readback.
  class DemoTransport {
    constructor(initial) {
      this.handler = null;
      this.state = initial || defaultState();
      this.values = new Map();
      this._seed();
    }

    _seed() {
      const s = this.state;
      this._set(0x00, FEAT.GAIN, [Math.round(s.gain * 100) >> 8, Math.round(s.gain * 100) & 0xFF]);
      this._set(0x00, FEAT.MUTE, [s.muted ? 1 : 0]);
      this._set(0x00, FEAT.AUTO_LEVEL, [s.autoLevel ? 1 : 0]);
      this._set(0x00, FEAT.GAIN_LOCK, [s.gainLocked ? 1 : 0]);
      this._set(0x00, FEAT.HPF, [s.hpf]);
      this._set(0x00, FEAT.LIMITER, [s.limiter ? 1 : 0]);
      this._set(0x00, FEAT.COMPRESSOR, [s.compressor]);
      this._set(0x00, FEAT.DENOISER, [s.denoiser ? 1 : 0]);
      this._set(0x00, FEAT.POPPER, [s.popper ? 1 : 0]);
      const tone = s.tone < 0 ? s.tone + 0x10000 : s.tone;
      this._set(0x00, FEAT.TONE, [(tone >> 8) & 0xFF, tone & 0xFF]);
      this._set(0x00, FEAT.MIX, [s.micMix]);
      this._set(0x00, FEAT.REVERB_OUTPUT, [s.reverbOutput ? 1 : 0]);
      this._set(0x00, FEAT.REVERB_TYPE, [s.reverbType]);
      this._set(0x00, FEAT.REVERB_INTENSITY, [s.reverbIntensity]);
      this._set(0x00, FEAT.REVERB_MONITOR, [s.reverbMonitor ? 1 : 0]);
      this._set(0x03, FEAT.MIX, [s.playbackMix]);
      this._set(LED.PAGE, [0x00, LED.BEHAVIOR], [s.ledBehavior]);
      this._set(LED.PAGE, [0x00, LED.BRIGHTNESS], [s.ledBrightness]);
      this._set(LED.PAGE, [0x00, LED.MUTE_BUTTON], [s.muteButton ? 1 : 0]);
      this._set(LED.PAGE, [0x00, LED.LIVE_THEME], [s.ledLiveTheme]);
      this._set(LED.PAGE, [0x00, LED.LIVE_EDGE], [0x00, ...s.ledLiveEdge]);
      this._set(LED.PAGE, [0x00, LED.LIVE_MIDDLE], [0x00, ...s.ledLiveMiddle]);
      this._set(LED.PAGE, [0x00, LED.LIVE_INTERIOR], [0x00, ...s.ledLiveInterior]);
      this._set(LED.PAGE, [0x00, LED.SOLID_THEME], [s.ledSolidTheme]);
      this._set(LED.PAGE, [0x00, LED.SOLID_COLOR], [0x00, ...s.ledSolidColor]);
      this._set(LED.PAGE, [0x00, LED.PULSING_THEME], [s.ledPulsingTheme]);
      this._set(LED.PAGE, [0x00, LED.PULSING_COLOR], [0x00, ...s.ledPulsingColor]);
      this._set(0x00, [0x00, 0x12], encodeLPString(s.deviceName));
      this._set(0x00, [0x00, 0x09], encodeLPString(s.firmware || '1.6.0.1'));
      this._set(0x00, [0x00, 0x02], encodeLPString(s.serial || 'DEMO0000001'));
    }

    _key(prefix, feat) {
      return prefix + ':' + feat[0] + ':' + feat[1];
    }

    _set(prefix, feat, value) {
      this.values.set(this._key(prefix, feat), value.slice());
    }

    _get(prefix, feat) {
      return this.values.get(this._key(prefix, feat)) || null;
    }

    onReport(handler) {
      this.handler = handler;
    }

    _emit(packet) {
      if (!this.handler) return;
      this.handler({
        reportId: packet[0],
        data: packet.subarray(1),
      });
    }

    _reply(command, prefix, feat, value) {
      const packet = buildPacket(0, command, [prefix, feat[0], feat[1], ...value], 0x03);
      this._emit(packet);
    }

    async write(packet) {
      const command = [packet[10], packet[11], packet[12]];
      if (sameBytes(command, CMD_CONFIRM)) {
        // Acknowledge every CONFIRM, as the hardware does.
        this._reply(RES_CONFIRM_ACK, 0x00, [0x00, 0x00], []);
        return;
      }
      if (sameBytes(command, CMD_GET_FEAT)) {
        const prefix = packet[13];
        const feat = [packet[14], packet[15]];
        const value = this._get(prefix, feat);
        if (value) this._reply(RES_GET_FEAT, prefix, feat, value);
        return;
      }
      if (sameBytes(command, CMD_GET_LOCK)) {
        const page = packet[13];
        const feat = [packet[14], packet[15]];
        const value = this._get(page, feat);
        if (value) this._reply(RES_GET_LOCK, page, feat, value);
        return;
      }
      if (sameBytes(command, CMD_SET_FEAT)) {
        const prefix = packet[13];
        const feat = [packet[14], packet[15]];
        // Data length sits at byte 9; the value starts after cmd/prefix/feat.
        const value = Array.from(packet.subarray(16, 16 + (packet[9] - 8)));
        this._set(prefix, feat, value);
        this._reply(RES_SET_FEAT, prefix, feat, value);
        return;
      }
      if (sameBytes(command, CMD_SET_LOCK)) {
        const page = packet[13];
        const feat = [packet[14], packet[15]];
        const value = Array.from(packet.subarray(16, 16 + (packet[9] - 8)));
        if (page === 0x00 && feat[1] === LED.FACTORY_RESET) return;
        this._set(page, feat, value);
        this._reply(RES_SET_LOCK, page, feat, value);
        return;
      }
    }
  }

  return {
    PACKET_SIZE,
    REPORT_ID,
    FEAT,
    LED,
    READBACK,
    crc16ANSI,
    buildPacket,
    getPacket,
    getLockPacket,
    setPacket,
    setLockPacket,
    confirmPacket,
    parsePacket,
    decodeLPString,
    encodeLPString,
    defaultState,
    Client,
    DemoTransport,
    sameBytes,
    sleep,
  };
});
