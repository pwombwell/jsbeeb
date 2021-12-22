"use strict";
import * as utils from './utils.js';

export function SoundChip(onBuffer) {
    this._onBuffer = onBuffer;
    // 4MHz input signal. Internal divide-by-8
    var soundchipFreq = 4000000.0 / 8;
    const sampleRate = soundchipFreq;
    this.sampleRate = sampleRate;
    this.bufferSize = 1024;
    // Square wave changes every time a counter hits zero. Thus a full wave
    // needs to be 2x counter zeros.
    var waveDecrementPerSecond = soundchipFreq / 2;
    // Each sample in the buffer represents (1/sampleRate) time, so each time
    // we generate a sample, we need to decrement the counters by this amount:
    var sampleDecrement = waveDecrementPerSecond / sampleRate;
    // How many samples are generated per CPU cycle.
    var samplesPerCycle = sampleRate / 2000000;
    var minCyclesWELow = 14; // Somewhat empirically derived; Repton 2 has only 14 cycles between WE low and WE high (@0x2caa)

    var register = [0, 0, 0, 0];
    this.registers = register; // for debug
    var counter = [0, 0, 0, 0];
    var outputBit = [false, false, false, false];
    var volume = [0, 0, 0, 0];
    this.volume = volume;  // for debug
    var generators = [null, null, null, null, null];

    var volumeTable = [];
    var f = 1.0;
    var i;
    for (i = 0; i < 16; ++i) {
        volumeTable[i] = f / generators.length;  // Bakes in the per channel volume
        f *= Math.pow(10, -0.1);
    }
    volumeTable[15] = 0;

    var sineTableSize = 8192;
    var sineTable = [];
    for (i = 0; i < sineTableSize; ++i) {
        sineTable[i] = Math.sin(2 * Math.PI * i / sineTableSize) / generators.length;
    }
    var sineStep = 0;
    var sineOn = false;
    var sineTime = 0;

    function sineChannel(channel, out, offset, length) {
        if (!sineOn) {
            return;
        }
        for (var i = 0; i < length; ++i) {
            out[i + offset] += sineTable[sineTime & (sineTableSize - 1)];
            sineTime += sineStep;
        }
        while (sineTime > sineTableSize) sineTime -= sineTableSize;
    }

    this.toneGenerator = {
        mute: () => {
            this.flush();
            sineOn = false;
        },
        tone: (freq) => {
            this.flush();
            sineOn = true;
            sineStep = (freq / sampleRate) * sineTableSize;
        }
    };

    function toneChannel(channel, out, offset, length) {
        var i;
        var reg = register[channel], vol = volume[channel];
        if (reg === 0) reg = 1024;
        for (i = 0; i < length; ++i) {
            counter[channel] -= sampleDecrement;
            if (counter[channel] < 0) {
                counter[channel] += reg;
                outputBit[channel] = !outputBit[channel];
            }
            out[i + offset] += (outputBit[channel] * vol);
        }
    }

    var lfsr = 0;

    function shiftLfsrWhiteNoise() {
        var bit = (lfsr & 1) ^ ((lfsr & (1 << 1)) >>> 1);
        lfsr = (lfsr >>> 1) | (bit << 14);
    }

    function shiftLfsrPeriodicNoise() {
        lfsr >>= 1;
        if (lfsr === 0) lfsr = 1 << 14;
    }

    var shiftLfsr = shiftLfsrWhiteNoise;

    function noisePoked() {
        shiftLfsr = register[3] & 4 ? shiftLfsrWhiteNoise : shiftLfsrPeriodicNoise;
        lfsr = 1 << 14;
    }

    function addFor(channel) {
        channel = channel | 0;
        switch (register[channel] & 3) {
            case 0:
                return 0x10;
            case 1:
                return 0x20;
            case 2:
                return 0x40;
            case 3:
                return register[channel - 1];
        }
    }

    function noiseChannel(channel, out, offset, length) {
        var add = addFor(channel), vol = volume[channel];
        for (var i = 0; i < length; ++i) {
            counter[channel] -= sampleDecrement;
            if (counter[channel] < 0) {
                counter[channel] += add;
                outputBit[channel] = !outputBit[channel];
                if (outputBit[channel]) shiftLfsr();
            }
            out[i + offset] += ((lfsr & 1) * vol);
        }
    }

    this.debugPokeAll = (c0, v0, c1, v1, c2, v2, c3, v3) => {
        this.flush();
        this.registers[0] = c0 & 0xffffff;
        this.registers[1] = c1 & 0xffffff;
        this.registers[2] = c2 & 0xffffff;
        this.registers[3] = c3 & 0xffffff;
        volume[0] = volumeTable[v0];
        volume[1] = volumeTable[v1];
        volume[2] = volumeTable[v2];
        volume[3] = volumeTable[v3];
        noisePoked();
    }

    var enabled = true;

    function generate(out, offset, length) {
        offset = offset | 0;
        length = length | 0;
        var i;
        for (i = 0; i < length; ++i) {
            out[i + offset] = 0.0;
        }
        if (!enabled) return;
        for (i = 0; i < generators.length; ++i) {
            generators[i](i, out, offset, length);
        }
    }

    var scheduler = {epoch: 0};
    var lastRunEpoch = 0;

    this.flush = () => {
        var cyclesPending = scheduler.epoch - lastRunEpoch;
        if (cyclesPending > 0) {
            this.advance(cyclesPending);
        }
        lastRunEpoch = scheduler.epoch;
    }

    var activeTask = null;
    this.setScheduler = function (scheduler_) {
        scheduler = scheduler_;
        lastRunEpoch = scheduler.epoch;
        activeTask = scheduler.newTask(function () {
            if (this.active) {
                this.poke(this.slowDataBus);
            }
        }.bind(this));
    };

    var residual = 0;
    var position = 0;
    var maxBufferSize = this.bufferSize;
    var buffer = new Float32Array(maxBufferSize);

    this.advance = (cycles) => {
        const numToGenerate = cycles * samplesPerCycle + residual;
        let rounded = numToGenerate | 0;
        residual = numToGenerate - rounded;
        while (rounded > 0) {
            const leftInBuffer = maxBufferSize - position;
            const numSamplesToGenerate = Math.min(rounded, leftInBuffer);
            generate(buffer, position, numSamplesToGenerate);
            position += numSamplesToGenerate;
            rounded -= numSamplesToGenerate;

            if (position === maxBufferSize) {
                this._onBuffer(buffer);
                buffer = new Float32Array(maxBufferSize);
                position = 0;
            }
        }
    }

    var latchedRegister = 0;

    this.poke = (value) => {
        this.flush();

        var command;
        var channel;
        if (value & 0x80) {
            latchedRegister = (value & 0x70);
            command = (value & 0xF0);
        } else {
            command = latchedRegister;
        }
        channel = ((command >> 5) & 0x03);

        if (command & 0x10) {
            // Volume setting
            var newVolume = value & 0x0f;
            volume[channel] = volumeTable[newVolume];
        } else if (channel === 3) {
            // For noise channel we always update the bottom bits.
            register[channel] = value & 0x0f;
            noisePoked();
        } else if (command & 0x80) {
            // Low period bits.
            register[channel] = (register[channel] & ~0x0f) | (value & 0x0f);
        } else {
            // High period bits.
            register[channel] = (register[channel] & 0x0f) | ((value & 0x3f) << 4);
        }
    }

    for (i = 0; i < 3; ++i) {
        generators[i] = toneChannel;
    }
    generators[3] = noiseChannel;
    generators[4] = sineChannel;

    this.active = false;
    this.slowDataBus = 0;
    this.updateSlowDataBus = function (slowDataBus, active) {
        this.slowDataBus = slowDataBus;
        this.active = active;
        // TODO: this probably isn't modeled correctly. Currently the
        // sound chip "notices" a new data bus value some fixed number of
        // cycles after WE (write enable) is triggered.
        // In reality, the sound chip likely pulls data off the bus at a
        // fixed point in its cycle, iff WE is active.
        if (active) {
            activeTask.ensureScheduled(true, minCyclesWELow);
        }
    };
    this.reset = (hard) => {
        if (!hard) return;
        for (var i = 0; i < 4; ++i) {
            counter[i] = 0;
            register[i] = 0;
            volume[i] = 0; // ideally this would be volumeTable[0] to get the "boo" of "boo...beep".  But startup issues make the "boo" all clicky.
        }
        noisePoked();
        this.advance(100000);
        this.setScheduler(scheduler);
    };
    // TODO mute/unmute probably should be handled in audiohandler.js
    this.enable = function (e) {
        enabled = e;
    };
    this.mute = function () {
        enabled = false;
    };
    this.unmute = function () {
        enabled = true;
    };
}

export function FakeSoundChip() {
    this.reset = this.enable = this.mute = this.unmute = this.updateSlowDataBus = this.setScheduler = this.flush = utils.noop;
    this.toneGenerator = this;
}
