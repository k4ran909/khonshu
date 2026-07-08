const fs = require('fs');
const path = require('path');

const baseMediaConnectionPath = path.join(__dirname, 'node_modules', '@gabrielmaialva33', 'discord-video-stream', 'dist', 'src', 'client', 'voice', 'base_media_connection.js');
const baseMediaPacketizerPath = path.join(__dirname, 'node_modules', '@gabrielmaialva33', 'discord-video-stream', 'dist', 'src', 'client', 'packet', 'base_media_packetizer.js');
const videoPacketizerAnnexBPath = path.join(__dirname, 'node_modules', '@gabrielmaialva33', 'discord-video-stream', 'dist', 'src', 'client', 'packet', 'video_packetizer_annex_b.js');
const newApiPath = path.join(__dirname, 'node_modules', '@gabrielmaialva33', 'discord-video-stream', 'dist', 'src', 'media', 'new_api.js');

// Booting with broken DAVE patches is worse than not booting at all — video
// silently fails or, worse, streams unencrypted. Turn every "could not find
// target pattern" into a hard exit so npm-install-followed-by-boot notices the
// mismatch immediately instead of running for weeks with silent breakage.
function fatalPatchError(msg) {
    console.error(msg);
    console.error('[PATCH] Refusing to boot with a broken DAVE E2EE patch. Verify the discord-video-stream version matches what patch-stream.js expects.');
    process.exit(1);
}

console.log('[PATCH] Starting DAVE E2EE patcher for all connections...');

// ─── 1. Patch base_media_connection.js ───
if (fs.existsSync(baseMediaConnectionPath)) {
    let content = fs.readFileSync(baseMediaConnectionPath, 'utf8');

    // 1.1 Add ESM import at top
    if (!content.includes("from '@discordjs/voice'")) {
        content = content.replace("import WebSocket from 'ws';", "import WebSocket from 'ws';\nimport { DAVESession } from '@discordjs/voice';");
    }

    // 1.2 Add session initialization in constructor
    if (!content.includes('this._daveSession = null;')) {
        content = content.replace(
            'this.ready = callback;',
            'this.ready = callback;\n        this._daveSession = null;\n        this._connectedClients = new Set();'
        );
    }

    // 1.3 Replace identify() — ALL connections send max_dave_protocol_version
    const cleanIdentify = `    identify() {
        if (!this.serverId)
            throw new Error('Server ID is null or empty');
        if (!this.session_id)
            throw new Error('Session ID is null or empty');
        if (!this.token)
            throw new Error('Token is null or empty');
        this.sendOpcode(VoiceOpCodes.IDENTIFY, {
            server_id: this.serverId,
            user_id: this.botId,
            session_id: this.session_id,
            token: this.token,
            video: true,
            streams: STREAMS_SIMULCAST,
        });
    }`;

    const patchedIdentify = `    identify() {
        if (!this.serverId)
            throw new Error('Server ID is null or empty');
        if (!this.session_id)
            throw new Error('Session ID is null or empty');
        if (!this.token)
            throw new Error('Token is null or empty');
        this.sendOpcode(VoiceOpCodes.IDENTIFY, {
            server_id: this.serverId,
            user_id: this.botId,
            session_id: this.session_id,
            token: this.token,
            video: true,
            streams: STREAMS_SIMULCAST,
            max_dave_protocol_version: 1,
        });
    }`;

    if (content.includes(cleanIdentify)) {
        content = content.replace(cleanIdentify, patchedIdentify);
    }

    // 1.4 Replace SELECT_PROTOCOL_ACK handler — ALL connections init DAVE
    const cleanSelectProtocolAck = `            else if (op === VoiceOpCodes.SELECT_PROTOCOL_ACK) {
                // session description
                this.handleProtocolAck(d);
            }`;

    const patchedSelectProtocolAck = `            else if (op === VoiceOpCodes.SELECT_PROTOCOL_ACK) {
                // session description
                this.handleProtocolAck(d);
                if (d.dave_protocol_version && d.dave_protocol_version > 0) {
                    console.log('[DAVE] Initializing E2EE for', this.constructor.name, 'channelId:', this.channelId);
                    this._daveSession = new DAVESession(d.dave_protocol_version, this.botId, this.channelId, {});
                    this._daveSession.on('keyPackage', (keyPackage) => {
                        const msg = Buffer.concat([new Uint8Array([26]), keyPackage]);
                        this.ws?.send(msg);
                    });
                    this._daveSession.on('invalidateTransition', (transitionId) => {
                        this.sendOpcode(31, { transition_id: transitionId });
                    });
                    try {
                        this._daveSession.reinit();
                    } catch (e) {
                        console.error('[DAVE REINIT ERROR]', this.constructor.name, e);
                    }
                }
            }
            else if (op === 11) { // ClientsConnect
                if (d.user_ids) {
                    for (const id of d.user_ids) this._connectedClients.add(id);
                }
            }
            else if (op === 13) { // ClientDisconnect
                if (d.user_id) this._connectedClients.delete(d.user_id);
            }
            else if (op === 21) { // DavePrepareTransition
                if (this._daveSession) {
                    const sendReady = this._daveSession.prepareTransition(d);
                    if (sendReady) {
                        this.sendOpcode(23, { transition_id: d.transition_id });
                    }
                }
            }
            else if (op === 22) { // DaveExecuteTransition
                if (this._daveSession) {
                    this._daveSession.executeTransition(d.transition_id);
                }
            }
            else if (op === 24) { // DavePrepareEpoch
                if (this._daveSession) {
                    this._daveSession.prepareEpoch(d);
                }
            }`;

    if (content.includes(cleanSelectProtocolAck)) {
        content = content.replace(cleanSelectProtocolAck, patchedSelectProtocolAck);
    }

    // 1.5 Intercept binary WebSocket messages — ALL connections handle MLS
    const cleanBinaryHandler = `        this.ws?.on('message', (data, isBinary) => {
            if (isBinary)
                return;
            const { op, d, seq } = JSON.parse(data.toString());`;

    const patchedBinaryHandler = `        this.ws?.on('message', (data, isBinary) => {
            if (isBinary) {
                const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
                const seq = buffer.readUInt16BE(0);
                const op = buffer.readUInt8(2);
                const payload = buffer.subarray(3);
                
                if (this._daveSession && this._daveSession.session) {
                    if (op === 25) { // DaveMlsExternalSender
                        this._daveSession.setExternalSender(payload);
                    } else if (op === 27) { // DaveMlsProposals
                        try {
                            const payloadOut = this._daveSession.processProposals(payload, this._connectedClients);
                            if (payloadOut) {
                                const msg = Buffer.concat([new Uint8Array([28]), payloadOut]);
                                this.ws?.send(msg);
                            }
                        } catch (e) {
                            console.warn('[DAVE MLS PROPOSALS WARN]', this.constructor.name, 'recovering from:', e.message || e);
                            try { this._daveSession.recoverFromInvalidTransition(this._daveSession.lastTransitionId || 0); } catch (_) {}
                        }
                    } else if (op === 29) { // DaveMlsAnnounceCommitTransition
                        const { transitionId, success } = this._daveSession.processCommit(payload);
                        if (success) {
                            if (transitionId !== 0) {
                                this.sendOpcode(23, { transition_id: transitionId });
                            }
                        }
                    } else if (op === 30) { // DaveMlsWelcome
                        const { transitionId, success } = this._daveSession.processWelcome(payload);
                        if (success) {
                            if (transitionId !== 0) {
                                this.sendOpcode(23, { transition_id: transitionId });
                            }
                        }
                    }
                }
                return;
            }
            const { op, d, seq } = JSON.parse(data.toString());`;

    if (content.includes(cleanBinaryHandler)) {
        content = content.replace(cleanBinaryHandler, patchedBinaryHandler);
    }

    fs.writeFileSync(baseMediaConnectionPath, content, 'utf8');
    console.log('[PATCH] base_media_connection.js patched successfully!');
} else {
    fatalPatchError('[PATCH] Error: base_media_connection.js not found!');
}

// ─── 2. Patch base_media_packetizer.js ───
if (fs.existsSync(baseMediaPacketizerPath)) {
    let content = fs.readFileSync(baseMediaPacketizerPath, 'utf8');

    const targetPatched = `    encryptData(plaintext, additionalData) {
        const encryptor = this._mediaUdp.mediaConnection.transportEncryptor;
        if (!encryptor)
            throw new Error('Transport encryptor not defined. Did you forget to select protocol?');
            
        // Check if DAVE E2EE is active and ready
        const dave = this._mediaUdp.mediaConnection._daveSession;
        if (dave && dave.protocolVersion > 0) {
            try {
                if (false) { // DEBUG disabled: per-packet console.log blocks the event loop
                    console.log('[DAVE DEBUG]', this._mediaUdp.mediaConnection.constructor.name, 'SSRC:', this._ssrc, 'Session Ready:', !!(dave.session && dave.session.ready));
                }
                let mediaType = 0; // AUDIO
                let codec = 1; // OPUS
                
                if (this._payloadType === 120) {
                    mediaType = 0;
                    codec = 1;
                } else if (this._payloadType === 105) {
                    mediaType = 1;
                    codec = 2;
                } else if (this._payloadType === 107) {
                    mediaType = 1;
                    codec = 3;
                } else if (this._payloadType === 101) {
                    mediaType = 1;
                    codec = 4;
                } else if (this._payloadType === 103) {
                    mediaType = 1;
                    codec = 5;
                } else if (this._payloadType === 109) {
                    mediaType = 1;
                    codec = 6;
                }
                
                if (dave.session && dave.session.ready) {
                    plaintext = dave.session.encrypt(mediaType, codec, plaintext);
                }
            } catch (err) {
                console.error('[DAVE ENCRYPT ERROR]', err);
            }
        }
            
        return encryptor.encrypt(plaintext, additionalData);
    }`;

    const targetClean = `    encryptData(plaintext, additionalData) {
        const encryptor = this._mediaUdp.mediaConnection.transportEncryptor;
        if (!encryptor)
            throw new Error('Transport encryptor not defined. Did you forget to select protocol?');
        return encryptor.encrypt(plaintext, additionalData);
    }`;

    const newPatched = `    encryptData(plaintext, additionalData) {
        const encryptor = this._mediaUdp.mediaConnection.transportEncryptor;
        if (!encryptor)
            throw new Error('Transport encryptor not defined. Did you forget to select protocol?');
            
        // Check if DAVE E2EE is active and ready (only for audio since video is encrypted before packetization)
        if (this._payloadType === 120) {
            const dave = this._mediaUdp.mediaConnection._daveSession;
            if (dave && dave.protocolVersion > 0) {
                try {
                    if (dave.session && dave.session.ready) {
                        plaintext = dave.session.encrypt(0, 1, plaintext); // MediaType.AUDIO, Codec.OPUS
                    }
                } catch (err) {
                    console.error('[DAVE AUDIO ENCRYPT ERROR]', err);
                }
            }
        }
            
        return encryptor.encrypt(plaintext, additionalData);
    }`;

    if (content.includes(targetPatched)) {
        content = content.replace(targetPatched, newPatched);
        fs.writeFileSync(baseMediaPacketizerPath, content, 'utf8');
        console.log('[PATCH] base_media_packetizer.js updated to only encrypt audio packets successfully!');
    } else if (content.includes(targetClean)) {
        content = content.replace(targetClean, newPatched);
        fs.writeFileSync(baseMediaPacketizerPath, content, 'utf8');
        console.log('[PATCH] base_media_packetizer.js patched for audio-only encryption successfully!');
    } else if (content.includes('// Check if DAVE E2EE is active and ready (only for audio since video is encrypted before packetization)')) {
        console.log('[PATCH] base_media_packetizer.js is already patched for audio-only encryption.');
    } else {
        fatalPatchError('[PATCH] Error: Could not find target pattern in base_media_packetizer.js!');
    }
}

// ─── 3. Patch video_packetizer_annex_b.js ───
if (fs.existsSync(videoPacketizerAnnexBPath)) {
    let content = fs.readFileSync(videoPacketizerAnnexBPath, 'utf8');

    const newPatched = `    async sendFrame(frame, frametime) {
        super.sendFrame(frame, frametime);
        // Note: \`extensions\` is imported at the top of this file from '../../utils.js'
        // (\`export const extensions = [{ id: 5, len: 2, val: 0 }]\`). We reference it
        // directly below — do NOT shadow it with a local declaration; an empty array
        // would strip the RTP header marker Discord relies on for frame boundaries.

        const dave = this.mediaUdp.mediaConnection._daveSession;
        let codec = 4; // H264
        if (this._payloadType === 103) { // H265
            codec = 5;
        }
        
        if (false) { // DEBUG disabled: per-frame console.log blocks the event loop and stalls video
            console.log('[DAVE VIDEO STATE]',
                'SSRC:', this._ssrc,
                'Dave exists:', !!dave,
                'Dave protocol:', dave?.protocolVersion,
                'Session exists:', !!dave?.session,
                'Session ready:', !!dave?.session?.ready
            );
        }
        
        if (dave && dave.protocolVersion > 0 && dave.session && dave.session.ready) {
            try {
                frame = dave.session.encrypt(1, codec, frame);
            } catch (err) {
                console.error('[DAVE VIDEO ENCRYPT ERROR]', err);
            }
        }
        
        const nalus = splitNalu(frame);
        let packetsSent = 0;
        let bytesSent = 0;
        let index = 0;
        for (const nalu of nalus) {
            const isLastNal = index === nalus.length - 1;
            if (nalu.length <= this.mtu) {
                // Send as Single NAL Unit Packet.
                const packetHeader = Buffer.concat([
                    this.makeRtpHeader(isLastNal),
                    this.createExtensionHeader(extensions),
                ]);
                const [ciphertext, nonceBuffer] = await this.encryptData(Buffer.concat([this.createExtensionPayload(extensions), nalu]), packetHeader);
                const packet = Buffer.concat([packetHeader, ciphertext, nonceBuffer.subarray(0, 4)]);
                this.mediaUdp.sendPacket(packet);
                packetsSent++;
                bytesSent += packet.length;
            }
            else {
                const [naluHeader, naluData] = this._nalFunctions.splitHeader(nalu);
                const data = this.partitionDataMTUSizedChunks(naluData);
                const encryptedPackets = [];
                // Send as Fragmentation Unit A (FU-A):
                for (let i = 0; i < data.length; i++) {
                    const isFirstPacket = i === 0;
                    const isFinalPacket = i === data.length - 1;
                    const markerBit = isLastNal && isFinalPacket;
                    const packetHeader = Buffer.concat([
                        this.makeRtpHeader(markerBit),
                        this.createExtensionHeader(extensions),
                    ]);
                    const packetData = Buffer.concat([
                        this.createExtensionPayload(extensions),
                        this.makeFragmentationUnitHeader(isFirstPacket, isFinalPacket, naluHeader),
                        data[i],
                    ]);
                    encryptedPackets.push(this.encryptData(packetData, packetHeader).then(([ciphertext, nonceBuffer]) => Buffer.concat([packetHeader, ciphertext, nonceBuffer.subarray(0, 4)])));
                }
                for (const packet of await Promise.all(encryptedPackets)) {
                    this.mediaUdp.sendPacket(packet);
                    packetsSent++;
                    bytesSent += packet.length;
                }
            }
            index++;
        }
        await this.onFrameSent(packetsSent, bytesSent, frametime);
    }`;

    // Regex to match sendFrame method in video_packetizer_annex_b.js
    const sendFrameRegex = /async sendFrame\([\s\S]*?await this\.onFrameSent[\s\S]*?\n\s*?\}/;

    if (sendFrameRegex.test(content)) {
        // Idempotency: check for a marker in the current-good body. If a previous
        // (incorrectly self-fixed) install landed with `const extensions = [];`
        // shadowing the module-level import, force a re-patch.
        const currentMarker = "Note: `extensions` is imported at the top of this file";
        const shadowedBrokenMarker = /^\s*const extensions = \[\];\s*$/m;
        const alreadyGood = content.includes(currentMarker) && !shadowedBrokenMarker.test(content);
        if (alreadyGood) {
            console.log('[PATCH] video_packetizer_annex_b.js is already patched with frame-level E2EE.');
        } else {
            if (shadowedBrokenMarker.test(content)) {
                console.log('[PATCH] Detected shadowed-extensions patch. Re-patching to use the module-level import.');
            }
            content = content.replace(sendFrameRegex, newPatched);
            fs.writeFileSync(videoPacketizerAnnexBPath, content, 'utf8');
            console.log('[PATCH] video_packetizer_annex_b.js patched successfully with frame-level E2EE!');
        }
    } else {
        fatalPatchError('[PATCH] Error: Could not find sendFrame method in video_packetizer_annex_b.js!');
    }
} else {
    fatalPatchError('[PATCH] Error: video_packetizer_annex_b.js not found!');
}

// ─── 4. Patch new_api.js ───
if (fs.existsSync(newApiPath)) {
    let content = fs.readFileSync(newApiPath, 'utf8');
    const cleanCommand = "const command = ffmpeg(input).addOption('-loglevel', '0');";
    
    const oldPatchedCommand = `let command;
    if (typeof input === 'string' && input.startsWith('video=')) {
        command = ffmpeg().inputOption('-f', 'dshow').inputOption('-rtbufsize', '100M').input(input).addOption('-loglevel', '0');
    } else {
        command = ffmpeg(input).addOption('-loglevel', '0');
    }`;

    const newPatchedCommand = `let command;
    if (typeof input === 'string' && input.startsWith('video=')) {
        command = ffmpeg().input(input).inputOption('-f', 'dshow').inputOption('-rtbufsize', '100M').addOption('-loglevel', '0');
    } else {
        command = ffmpeg(input).addOption('-loglevel', '0');
    }`;

    if (content.includes(cleanCommand)) {
        content = content.replace(cleanCommand, newPatchedCommand);
        fs.writeFileSync(newApiPath, content, 'utf8');
        console.log('[PATCH] new_api.js patched successfully for DirectShow video capture!');
    } else if (content.includes(oldPatchedCommand)) {
        content = content.replace(oldPatchedCommand, newPatchedCommand);
        fs.writeFileSync(newApiPath, content, 'utf8');
        console.log('[PATCH] new_api.js updated successfully with correct fluent-ffmpeg input ordering!');
    } else if (content.includes('ffmpeg().input(input).inputOption')) {
        console.log('[PATCH] new_api.js is already patched with correct DirectShow capture.');
    } else {
        fatalPatchError('[PATCH] Error: Could not find target pattern in new_api.js!');
    }
} else {
    fatalPatchError('[PATCH] Error: new_api.js not found!');
}

console.log('[PATCH] All patches applied successfully!');
