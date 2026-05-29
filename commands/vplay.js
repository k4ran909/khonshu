const strings = require("../strings.json");
const utils = require("../utils");
const YouTube = require("youtube-sr").default;
const { spawn } = require("child_process");

// Set ffmpeg-static path globally for fluent-ffmpeg
try {
    const ffmpeg = require("fluent-ffmpeg");
    const isAlpine = require("fs").existsSync("/etc/alpine-release");
    if (isAlpine || process.platform === "linux") {
        process.env.FFMPEG_PATH = "ffmpeg";
        ffmpeg.setFfmpegPath("ffmpeg");
        utils.log("[VPLAY] Alpine Linux or Linux environment detected. Using native system 'ffmpeg' binary.");
    } else {
        const ffmpegPath = require("ffmpeg-static");
        if (ffmpegPath) {
            process.env.FFMPEG_PATH = ffmpegPath;
            ffmpeg.setFfmpegPath(ffmpegPath);
            utils.log(`[VPLAY] Globally set fluent-ffmpeg path and FFMPEG_PATH env to: ${ffmpegPath}`);
        }
    }
} catch (e) {
    console.error("[VPLAY] Error setting ffmpeg path:", e);
}

// YouTube URL pattern
const YT_URL_REGEX = /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be|music\.youtube\.com)\/.+$/;

/** 
 * @description Streams YouTube video as a Discord screenshare (Go Live)
 * @param {Discord.Client} client the client that runs the commands
 * @param {Discord.Message} message the command's message
 * @param {Array<String>} args search words or link
 */
module.exports.run = async (client, message, args) => {
    if (!args[0]) return message.channel.send("❌ Please provide a song name or a YouTube link to stream!");

    let useCamera = true; // Default to Virtual Camera mode!
    const screenshareFlags = ["--screenshare", "--go-live", "--live", "-s"];
    const cameraFlags = ["--camera", "--cam", "-c"];

    // Check if the user explicitly requested screenshare
    const hasScreenshareFlag = args.some(arg => screenshareFlags.includes(arg.toLowerCase()));
    const hasCameraFlag = args.some(arg => cameraFlags.includes(arg.toLowerCase()));

    if (hasScreenshareFlag) {
        useCamera = false;
    } else if (hasCameraFlag) {
        useCamera = true;
    }

    // Filter out all flags from args
    const allFlags = [...screenshareFlags, ...cameraFlags];
    const filteredArgs = args.filter(arg => !allFlags.includes(arg.toLowerCase()));

    if (filteredArgs.length === 0) return message.channel.send("❌ Please provide a song name or a YouTube link to stream!");
    const query = filteredArgs.join(" ");
    let youtubeUrl = query;

    // Find voice channel - either from guild context or by searching all guilds (for DMs)
    let voiceChannel;
    if (message._isDM) {
        voiceChannel = global.ownerVoiceChannel;
        if (!voiceChannel) {
            return message.channel.send("❌ You need to be in a voice channel first. Join one and try again.");
        }
    } else {
        voiceChannel = message.member.voice.channel;
        if (!voiceChannel) return message.channel.send(strings.notInVocal);
    }

    try {
        await message.channel.send(`🔍 Searching and preparing the video stream (${useCamera ? "Virtual Camera" : "Screenshare"})...`);
    } catch (e) {}

    let directUrl = "";
    let title = "";

    const isLocalCam = ["obs", "camera", "cam"].includes(query.toLowerCase());

    if (isLocalCam) {
        directUrl = "video=OBS Virtual Camera";
        title = "OBS Virtual Camera Feed";
        utils.log(`[VPLAY] Using DirectShow device: "${directUrl}"`);
    } else {
        const HTTP_URL_REGEX = /^https?:\/\/.+$/;
        const isDirectVideo = HTTP_URL_REGEX.test(query) && !YT_URL_REGEX.test(query);

        if (isDirectVideo) {
            directUrl = query;
            title = "Direct Video Stream";
            utils.log(`[VPLAY] Using direct video URL: "${directUrl}"`);
        } else {
            // Resolve YouTube URL if a search query was provided
            if (!YT_URL_REGEX.test(query)) {
                utils.log(`[VPLAY] Searching YouTube for: "${query}"`);
                try {
                    const results = await YouTube.search(query, { limit: 1 });
                    if (!results || results.length === 0) {
                        return message.channel.send("❌ No matches found for your query.");
                    }
                    youtubeUrl = `https://www.youtube.com/watch?v=${results[0].id}`;
                } catch (e) {
                    console.error("[VPLAY] YouTube search error:", e);
                    return message.channel.send("❌ Error searching YouTube.");
                }
            }

            // Resolve video metadata
            title = "Unknown Video";
            try {
                const video = await YouTube.getVideo(youtubeUrl);
                if (video) {
                    title = video.title;
                } else {
                    const results = await YouTube.search(youtubeUrl, { limit: 1 });
                    if (results && results.length > 0) title = results[0].title;
                }
            } catch (e) {
                title = "YouTube Video Stream";
            }

            utils.log(`[VPLAY] Resolved video: "${title}" at ${youtubeUrl}`);

            // Resolve direct stream URL using yt-dlp
            try {
                directUrl = await getDirectVideoUrl(youtubeUrl);
                if (!directUrl) throw new Error("No URL returned from yt-dlp");
            } catch (err) {
                console.error("[VPLAY] Error extracting direct video stream URL:", err);
                return message.channel.send("❌ Failed to extract direct video stream URL from YouTube. Ensure yt-dlp is updated.");
            }
        }
    }

    // Clean up any existing voice session to prevent conflict (audio or video)
    const existingQueue = queue.get("queue");
    if (existingQueue) {
        utils.log("[VPLAY] Stopping existing active queue to start video stream.");
        // Clear auto-disconnect timer
        if (existingQueue.disconnectTimer) {
            clearTimeout(existingQueue.disconnectTimer);
        }
        // Kill standard audio ffmpeg processes
        if (existingQueue.ffmpegProcess) {
            try {
                existingQueue.ffmpegProcess.kill();
                if (existingQueue.ffmpegProcess.ytdlpProcess) {
                    existingQueue.ffmpegProcess.ytdlpProcess.kill();
                }
            } catch (e) {}
        }
        // Stop standard player
        if (existingQueue.player) {
            try { existingQueue.player.stop(true); } catch (e) {}
        }
        // Kill existing video stream
        if (existingQueue.isVideo) {
            if (existingQueue.streamPlay && existingQueue.streamPlay.command) {
                try { existingQueue.streamPlay.command.kill(); } catch (e) {}
            }
            if (existingQueue.streamer) {
                try { existingQueue.streamer.leaveVoice(); } catch (e) {}
            }
        }
        // Destroy existing connection
        if (existingQueue.connection) {
            try { existingQueue.connection.destroy(); } catch (e) {}
        }
        queue.delete("queue");
    }

    // Dynamic ESM imports
    let Streamer, NewApi;
    try {
        const djsStream = await import("@gabrielmaialva33/discord-video-stream");
        Streamer = djsStream.Streamer;
        NewApi = djsStream.NewApi;
    } catch (err) {
        console.error("[VPLAY] ESM Import failed:", err);
        return message.channel.send("❌ Failed to load the video streaming module.");
    }

    const { prepareStream, playStream } = NewApi;

    // Create a new video-based queue construct
    const streamer = new Streamer(client);
    const queueConstruct = {
        textchannel: message.channel,
        voiceChannel: voiceChannel,
        connection: null,
        player: null,
        songs: [{ title: title, url: youtubeUrl, requestedby: message.author.username }],
        volume: 1,
        playing: true,
        isVideo: true,
        streamer: streamer,
        streamPlay: null,
        disconnectTimer: null
    };
    queue.set("queue", queueConstruct);

    try {
        utils.log(`[VPLAY] Connecting streamer to voice channel: ${voiceChannel.name} (${voiceChannel.id})`);
        
        // 2-second delay to ensure previous voice gateway state changes are fully processed
        await new Promise(resolve => setTimeout(resolve, 2000));

        // Register raw listener to inspect gateway packets
        const rawListener = (packet) => {
            if (packet.t === 'VOICE_STATE_UPDATE' || packet.t === 'VOICE_SERVER_UPDATE') {
                utils.log(`[VPLAY RAW DEBUG] Gateway received ${packet.t}: ${JSON.stringify(packet.d)}`);
            }
        };
        client.on('raw', rawListener);

        // Connect to voice
        await streamer.joinVoice(voiceChannel.guild.id, voiceChannel.id);
        
        client.off('raw', rawListener);
        
        // Transcode and prepare the combined stream via ffmpeg
        utils.log(`[VPLAY] Preparing video transcode stream from URL: ${directUrl.substring(0, 200)}...`);
        const { command, output, promise } = prepareStream(directUrl, {
            videoCodec: "H264",
            width: useCamera ? 640 : 1280,   // 360p for webcam square, 720p for screenshare!
            height: useCamera ? 360 : 720,
            bitrateVideo: useCamera ? 600 : 2000, // lower bitrate for webcam
            bitrateVideoMax: useCamera ? 1000 : 3000,
            bitrateAudio: 128,
            includeAudio: true,
            h26xPreset: "ultrafast",        // Use ultrafast for minimum CPU overhead!
            minimizeLatency: true,
            customFfmpegFlags: ["-loglevel", "warning"]
        });

        command.on("stderr", (line) => {
            utils.log(`[VPLAY FFMPEG STDERR] ${line}`);
        });

        // Store play objects in queue construct
        queueConstruct.streamPlay = {
            command: command,
            promise: promise
        };

        command.on("error", (err) => {
            if (err.message && (err.message.includes("SIGKILL") || err.message.includes("kill"))) return;
            utils.log(`[VPLAY FFMPEG ERROR] ${err.message}`);
            try { message.channel.send(`❌ Video transcode error: ${err.message}`); } catch (e) {}
        });

        promise.then(() => {
            utils.log("[VPLAY] Video stream playback finished.");
            const currentQueue = queue.get("queue");
            if (currentQueue && currentQueue.isVideo) {
                try { streamer.leaveVoice(); } catch (e) {}
                queue.delete("queue");
                try { message.channel.send("📺 Video streaming has finished."); } catch (e) {}
            }
        }).catch((err) => {
            utils.log(`[VPLAY PROMISE ERROR] ${err.message}`);
        });

        // Start playing Go Live or Camera stream to Discord
        await playStream(output, streamer, {
            type: useCamera ? "camera" : "go-live",
            streamPreview: false
        });

        await message.channel.send(`${useCamera ? "📷 Started streaming video as a Virtual Camera" : "📺 Started screensharing video"}: **${title}**`);
        utils.log(`[VPLAY] Successfully started streaming "${title}" via ${useCamera ? "camera" : "go-live"}`);

    } catch (err) {
        console.error("[VPLAY] Error during connection or streaming:", err);
        try { streamer.leaveVoice(); } catch (e) {}
        queue.delete("queue");
        return message.channel.send("❌ Failed to initiate video stream.");
    }
};

const https = require("https");
const http = require("http");

function extractVideoId(url) {
    const patterns = [
        /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/v\/)([a-zA-Z0-9_-]{11})/,
        /[?&]v=([a-zA-Z0-9_-]{11})/,
        /^\/watch\?v=([a-zA-Z0-9_-]{11})/,
        /^([a-zA-Z0-9_-]{11})$/
    ];
    for (const p of patterns) {
        const m = url.match(p);
        if (m) return m[1];
    }
    return null;
}

function fetchJSON(urlStr, timeoutMs = 10000) {
    return new Promise((resolve) => {
        try {
            const parsed = new URL(urlStr);
            const transport = parsed.protocol === "http:" ? http : https;
            const req = transport.get({
                hostname: parsed.hostname,
                port: parsed.port || undefined,
                path: parsed.pathname + parsed.search,
                headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
                timeout: timeoutMs
            }, (res) => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    fetchJSON(res.headers.location, timeoutMs).then(resolve);
                    return;
                }
                if (res.statusCode !== 200) { resolve(null); res.resume(); return; }
                let body = "";
                res.on("data", chunk => body += chunk);
                res.on("end", () => {
                    try { resolve(JSON.parse(body)); } catch (e) { resolve(null); }
                });
            });
            req.on("error", () => resolve(null));
            req.on("timeout", () => { req.destroy(); resolve(null); });
        } catch (e) { resolve(null); }
    });
}

let _vCachedPiped = null;
let _vCachedInvidious = null;
let _vCacheTime = 0;
const V_CACHE_TTL = 3600000;

async function getActivePipedInstances() {
    if (_vCachedPiped && Date.now() - _vCacheTime < V_CACHE_TTL) return _vCachedPiped;
    const fallbacks = [
        "https://pipedapi.kavin.rocks",
        "https://api.piped.private.coffee",
        "https://pipedapi.lvk.li",
        "https://pipedapi.tokyo.privacy.coffee",
        "https://pipedapi.us.privacy.coffee",
        "https://pipedapi.ch.privacy.coffee",
        "https://piped-api.garudalinux.org",
        "https://api.piped.projectsegfau.lt",
        "https://piped-api.lunar.icu"
    ];
    try {
        console.log("[VPLAY FALLBACK] Fetching active Piped instances from registry...");
        const instances = await fetchJSON("https://piped-instances.kavin.rocks/", 8000);
        if (instances && Array.isArray(instances) && instances.length > 0) {
            const parsed = instances
                .filter(i => i.api_url && i.uptime_24h > 90)
                .sort((a, b) => (b.uptime_24h || 0) - (a.uptime_24h || 0))
                .map(i => i.api_url);
            _vCachedPiped = parsed.length >= 3 ? parsed : [...new Set([...parsed, ...fallbacks])];
            _vCacheTime = Date.now();
            console.log(`[VPLAY FALLBACK] Found ${_vCachedPiped.length} active Piped instances`);
            return _vCachedPiped;
        }
    } catch (e) {
        console.log(`[VPLAY FALLBACK] Failed to fetch Piped registry: ${e.message}`);
    }
    _vCachedPiped = fallbacks;
    _vCacheTime = Date.now();
    return _vCachedPiped;
}

async function getActiveInvidiousInstances() {
    if (_vCachedInvidious && Date.now() - _vCacheTime < V_CACHE_TTL) return _vCachedInvidious;
    const fallbacks = [
        "https://inv.thepixora.com",
        "https://yewtu.be",
        "https://invidious.projectsegfau.lt",
        "https://invidious.flokinet.to",
        "https://invidious.privacydev.net",
        "https://iv.melmac.space",
        "https://invidious.lunar.icu",
        "https://inv.tux.im"
    ];
    try {
        console.log("[VPLAY FALLBACK] Fetching active Invidious instances from registry...");
        const instances = await fetchJSON("https://api.invidious.io/instances.json?sort_by=type,health", 8000);
        if (instances && Array.isArray(instances) && instances.length > 0) {
            const parsed = instances
                .filter(([name, info]) => info && info.type === "https" && info.api !== false
                    && info.monitor && info.monitor.down === false)
                .sort(([, a], [, b]) => ((b.monitor?.uptime || 0) - (a.monitor?.uptime || 0)))
                .map(([name, info]) => info.uri)
                .slice(0, 8);
            if (parsed.length > 0) {
                _vCachedInvidious = parsed.length >= 3 ? parsed : [...new Set([...parsed, ...fallbacks])];
                console.log(`[VPLAY FALLBACK] Found ${_vCachedInvidious.length} active Invidious instances (API enabled)`);
                return _vCachedInvidious;
            }
        }
    } catch (e) {
        console.log(`[VPLAY FALLBACK] Failed to fetch Invidious registry: ${e.message}`);
    }
    _vCachedInvidious = fallbacks;
    return _vCachedInvidious;
}

function parseCookieFile() {
    try {
        const fs = require('fs');
        const path = require('path');
        const cookiePath = path.join(process.cwd(), 'cookies.txt');
        if (!fs.existsSync(cookiePath)) return null;
        const content = fs.readFileSync(cookiePath, 'utf8');
        const cookies = content.split('\n')
            .filter(line => !line.startsWith('#') && line.trim().length > 0)
            .map(line => {
                const parts = line.split('\t');
                if (parts.length >= 7) {
                    return `${parts[5].trim()}=${parts[6].trim()}`;
                }
                return null;
            })
            .filter(Boolean);
        return cookies.length > 0 ? cookies.join('; ') : null;
    } catch (e) {
        console.log(`[COOKIES] Failed to parse cookies.txt: ${e.message}`);
        return null;
    }
}

function raceInstances(urls, fetchAndParseFn) {
    return new Promise((resolve) => {
        let resolved = false;
        let pending = urls.length;
        if (pending === 0) return resolve(null);

        urls.forEach(url => {
            fetchAndParseFn(url).then(res => {
                if (resolved) return;
                if (res) {
                    resolved = true;
                    resolve(res);
                } else {
                    pending--;
                    if (pending === 0) resolve(null);
                }
            }).catch(() => {
                if (resolved) return;
                pending--;
                if (pending === 0) resolve(null);
            });
        });
    });
}

async function fetchCobaltVideo(videoUrl) {
    const videoId = extractVideoId(videoUrl);
    if (!videoId) return null;

    // Try to discover working Cobalt instances dynamically
    let cobaltEndpoints = [];
    try {
        console.log("[VPLAY COBALT] Fetching active instances...");
        const instances = await fetchJSON("https://cobalt-api.ayo.tf/api/status", 5000);
        if (instances && Array.isArray(instances)) {
            cobaltEndpoints = instances
                .filter(i => i.api_online && i.api_url)
                .map(i => i.api_url);
        }
    } catch (e) {}
    
    if (cobaltEndpoints.length < 2) {
        try {
            const instances2 = await fetchJSON("https://cobalt.directory/api/instances.json", 5000);
            if (instances2 && Array.isArray(instances2)) {
                const extra = instances2
                    .filter(i => i.protocol === "https" && i.api && i.score > 50)
                    .map(i => i.api);
                cobaltEndpoints = [...new Set([...cobaltEndpoints, ...extra])];
            }
        } catch (e) {}
    }

    if (cobaltEndpoints.length === 0) {
        cobaltEndpoints = [
            "https://api.cobalt.tools",
            "https://cobalt-api.kwiatekmiki.com",
            "https://cobalt.canine.tools",
            "https://cobalt-api.hyper.lol"
        ];
    }
    
    console.log(`[VPLAY COBALT] Trying ${cobaltEndpoints.length} Cobalt endpoints...`);

    for (const endpoint of cobaltEndpoints.slice(0, 5)) {
        try {
            console.log(`[VPLAY COBALT] Trying ${endpoint} for video: ${videoId}`);
            const result = await new Promise((resolve) => {
                const postData = JSON.stringify({
                    url: `https://www.youtube.com/watch?v=${videoId}`,
                    vQuality: "360",
                    vCodec: "h264",
                    filenamePattern: "basic"
                });

                const parsed = new URL(endpoint);
                const req = https.request({
                    hostname: parsed.hostname,
                    port: parsed.port || 443,
                    path: "/",
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "Accept": "application/json",
                        "Content-Length": Buffer.byteLength(postData),
                        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
                    },
                    timeout: 12000
                }, (res) => {
                    let body = "";
                    res.on("data", chunk => body += chunk);
                    res.on("end", () => {
                        try {
                            const data = JSON.parse(body);
                            resolve(data);
                        } catch (e) { resolve(null); }
                    });
                });
                req.on("error", () => resolve(null));
                req.on("timeout", () => { req.destroy(); resolve(null); });
                req.write(postData);
                req.end();
            });

            if (result && result.url) {
                console.log(`[VPLAY COBALT] SUCCESS from ${endpoint}!`);
                return result.url;
            }

            if (result && result.status === "error") {
                console.log(`[VPLAY COBALT] ${endpoint} error: ${result.error?.code || result.text || 'unknown'}`);
            }
        } catch (e) {
            console.log(`[VPLAY COBALT] ${endpoint} failed: ${e.message}`);
        }
    }

    console.log("[VPLAY COBALT] All endpoints exhausted");
    return null;
}

async function fetchFallbackVideo(videoUrl) {
    const videoId = extractVideoId(videoUrl);
    if (!videoId) return null;
    console.log(`[VPLAY FALLBACK] Extracted video ID: ${videoId}`);

    const cookieString = parseCookieFile();
    if (cookieString) {
        console.log(`[VPLAY INNERTUBE] Using cookies for authentication (${cookieString.length} chars)`);
    } else {
        console.log(`[VPLAY INNERTUBE] No cookies available - may be blocked on datacenter IPs`);
    }

    // Try youtubei.js with multiple client types including smart TV
    const clientTypes = ['TV_EMBEDDED', 'TV', 'WEB', 'ANDROID', 'IOS', 'YTMUSIC', 'WEB_EMBEDDED'];
    let yt;
    try {
        const { Innertube } = await import('youtubei.js');
        const createOpts = { retrieve_player: true, generate_session_locally: true };
        if (cookieString) {
            createOpts.cookie = cookieString;
        }
        yt = await Innertube.create(createOpts);
    } catch (err) {
        console.log(`[VPLAY INNERTUBE] Failed to create Innertube instance: ${err.message}`);
    }

    if (yt) {
        for (const clientType of clientTypes) {
            try {
                console.log(`[VPLAY INNERTUBE] Trying youtubei.js (${clientType} client) for video: ${videoId}`);
                const info = await yt.getInfo(videoId, clientType);

                if (!info || !info.streaming_data) {
                    console.log(`[VPLAY INNERTUBE] No streaming data from ${clientType}`);
                    continue;
                }

                const getFormatUrl = (format) => {
                    if (format.url) return format.url;
                    try {
                        if (typeof format.decipher === 'function') {
                            return format.decipher(yt.session.player);
                        }
                    } catch (e) { /* skip */ }
                    return null;
                };

                // Try combined formats first (video+audio in one stream)
                const combined = info.streaming_data.formats || [];
                const mp4Combined = combined
                    .filter(f => f.mime_type && f.mime_type.includes('video/mp4'))
                    .sort((a, b) => Math.abs((a.height || 0) - 360) - Math.abs((b.height || 0) - 360));
                for (const fmt of mp4Combined) {
                    const url = getFormatUrl(fmt);
                    if (url) {
                        console.log(`[VPLAY INNERTUBE] SUCCESS via ${clientType}! Combined: ${fmt.quality_label || fmt.height + 'p'}`);
                        return url;
                    }
                }

                // Try adaptive video formats
                const adaptive = info.streaming_data.adaptive_formats || [];
                const videoFormats = adaptive
                    .filter(f => f.mime_type && f.mime_type.includes('video/mp4'))
                    .sort((a, b) => Math.abs((a.height || 0) - 360) - Math.abs((b.height || 0) - 360));
                for (const fmt of videoFormats) {
                    const url = getFormatUrl(fmt);
                    if (url) {
                        console.log(`[VPLAY INNERTUBE] SUCCESS via ${clientType}! Adaptive: ${fmt.quality_label || fmt.height + 'p'}`);
                        return url;
                    }
                }

                console.log(`[VPLAY INNERTUBE] ${clientType}: formats found but URLs inaccessible`);
            } catch (e) {
                console.log(`[VPLAY INNERTUBE] ${clientType} failed: ${e.message}`);
            }
        }
    }

    console.log('[VPLAY FALLBACK] InnerTube exhausted, trying Cobalt video resolver...');
    const cobaltUrl = await fetchCobaltVideo(videoUrl);
    if (cobaltUrl) return cobaltUrl;

    console.log('[VPLAY FALLBACK] Cobalt exhausted, trying Piped/Invidious fallbacks...');

    // Try Piped instances concurrently
    const pipedInstances = await getActivePipedInstances();
    const pipedUrls = pipedInstances.slice(0, 6);
    console.log(`[VPLAY FALLBACK] Racing ${pipedUrls.length} Piped instances concurrently...`);
    const pipedResult = await raceInstances(pipedUrls, async (instance) => {
        try {
            const data = await fetchJSON(`${instance}/streams/${videoId}`, 4000);
            if (data && data.videoStreams && data.videoStreams.length > 0) {
                const mp4Streams = data.videoStreams
                    .filter(s => s.url && ((s.mimeType && s.mimeType.includes("video/mp4")) || s.format === "MPEG_4" || s.format === "MP4"))
                    .sort((a, b) => Math.abs((a.height || 0) - 360) - Math.abs((b.height || 0) - 360));
                if (mp4Streams.length > 0) {
                    let streamUrl = mp4Streams[0].url;
                    let finalUrl = streamUrl;
                    if (streamUrl.includes("googlevideo.com") || streamUrl.includes("youtube.com")) {
                        finalUrl = `${instance}/proxy?host=${new URL(streamUrl).hostname}&path=${encodeURIComponent(new URL(streamUrl).pathname + new URL(streamUrl).search)}`;
                    }
                    console.log(`[VPLAY FALLBACK] Piped checking stream: ${finalUrl}`);
                    const ok = await verifyStreamUrl(finalUrl, 2000);
                    if (ok) {
                        console.log(`[VPLAY FALLBACK] Piped SUCCESS from ${instance}! Video: ${mp4Streams[0].quality} (proxied)`);
                        return finalUrl;
                    } else {
                        console.log(`[VPLAY FALLBACK] Piped stream check failed for: ${instance}`);
                    }
                }
                const anyStream = data.videoStreams.filter(s => s.url)[0];
                if (anyStream) {
                    let finalUrl = anyStream.url;
                    if (finalUrl.includes("googlevideo.com") || finalUrl.includes("youtube.com")) {
                        finalUrl = `${instance}/proxy?host=${new URL(finalUrl).hostname}&path=${encodeURIComponent(new URL(finalUrl).pathname + new URL(finalUrl).search)}`;
                    }
                    console.log(`[VPLAY FALLBACK] Piped checking stream: ${finalUrl}`);
                    const ok = await verifyStreamUrl(finalUrl, 2000);
                    if (ok) {
                        console.log(`[VPLAY FALLBACK] Piped SUCCESS from ${instance}! Video: ${anyStream.quality}`);
                        return finalUrl;
                    } else {
                        console.log(`[VPLAY FALLBACK] Piped stream check failed for: ${instance}`);
                    }
                }
            }
        } catch (e) {}
        return null;
    });

    if (pipedResult) return pipedResult;

    // Try Invidious instances concurrently
    const invidiousInstances = await getActiveInvidiousInstances();
    const invidiousUrls = invidiousInstances.slice(0, 6);
    console.log(`[VPLAY FALLBACK] Racing ${invidiousUrls.length} Invidious instances concurrently...`);
    const invidiousResult = await raceInstances(invidiousUrls, async (instance) => {
        try {
            const data = await fetchJSON(`${instance}/api/v1/videos/${videoId}`, 4000);
            if (data && data.formatStreams && data.formatStreams.length > 0) {
                const mp4Streams = data.formatStreams
                    .filter(f => f.url && f.type && f.type.includes("video/mp4"))
                    .sort((a, b) => Math.abs(parseInt(a.qualityLabel || "0") - 360) - Math.abs(parseInt(b.qualityLabel || "0") - 360));
                if (mp4Streams.length > 0) {
                    const itag = mp4Streams[0].itag;
                    if (itag) {
                        const proxyUrl = `${instance}/latest_version?id=${videoId}&itag=${itag}&local=true`;
                        console.log(`[VPLAY FALLBACK] Invidious checking stream: ${proxyUrl}`);
                        const ok = await verifyStreamUrl(proxyUrl, 2000);
                        if (ok) {
                            console.log(`[VPLAY FALLBACK] Invidious SUCCESS from ${instance}! Video: ${mp4Streams[0].qualityLabel} (via /latest_version)`);
                            return proxyUrl;
                        } else {
                            console.log(`[VPLAY FALLBACK] Invidious stream check failed for: ${instance}`);
                        }
                    }
                }
            }
        } catch (e) {}
        return null;
    });

    if (invidiousResult) return invidiousResult;

    console.log("[VPLAY FALLBACK] All instances and fallback APIs exhausted. No video source found.");
    return null;
}


/**
 * @description Extracts the direct video + audio stream URL using yt-dlp
 * @param {String} url YouTube Watch URL
 * @returns {Promise<String>} Combined direct URL
 */
function getDirectVideoUrl(url) {
    return new Promise((resolve, reject) => {
        const fs = require("fs");
        const path = require("path");
        const ytdlpArgs = [
            "--no-playlist",
            "-f", "best[ext=mp4]/best",
            "--get-url",
            "--quiet",
            "--no-warnings",
            "--no-check-certificates",
            "--extractor-args", "youtube:player_client=web,mweb,android"
        ];

        const cookiesPath = path.join(process.cwd(), "cookies.txt");
        if (fs.existsSync(cookiesPath)) {
            ytdlpArgs.push("--cookies", cookiesPath);
            console.log(`[VPLAY] Using cookies file for yt-dlp at: ${cookiesPath}`);
        }

        ytdlpArgs.push(url);

        const ytdlp = spawn("yt-dlp", ytdlpArgs, { stdio: ["ignore", "pipe", "pipe"] });

        let streamUrl = "";
        let errData = "";

        ytdlp.stdout.on("data", (data) => {
            streamUrl += data.toString().trim();
        });

        ytdlp.stderr.on("data", (data) => {
            errData += data.toString().trim();
        });

        ytdlp.on("close", async (code) => {
            if (code !== 0 || !streamUrl) {
                console.log(`[VPLAY] yt-dlp failed (code ${code}). Attempting Piped/Invidious API fallback...`);
                try {
                    const fallbackUrl = await fetchFallbackVideo(url);
                    if (fallbackUrl) {
                        console.log(`[VPLAY] API fallback successful! Got direct video URL.`);
                        resolve(fallbackUrl);
                    } else {
                        reject(new Error(`yt-dlp and all API fallbacks failed. Error: ${errData}`));
                    }
                } catch (err) {
                    reject(new Error(`yt-dlp failed and API fallback errored: ${err.message}`));
                }
            } else {
                resolve(streamUrl);
            }
        });
    });
}

module.exports.names = {
    list: ["vplay", "vp"]
};
