const AsciiTable = require("ascii-table/ascii-table");
const YouTube = require("youtube-sr").default;
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, VoiceConnectionStatus, entersState, StreamType } = require("@discordjs/voice");
const { spawn } = require("child_process");
const path = require("path");

// ═══════════════════════════════════════════
// DSP Audio Filter Definitions (ffmpeg -af)
// ═══════════════════════════════════════════
const FILTER_MAP = {
    bassboost:  "bass=g=15:f=110:w=0.3",
    nightcore:  "aresample=48000,asetrate=48000*1.25",
    vaporwave:  "aresample=48000,asetrate=48000*0.8",
    "8d":       "apulsator=hz=0.09"
};

// Auto-disconnect timeout (5 minutes = 300000 ms)
const AUTO_DISCONNECT_MS = 300000;

// Try to find ffmpeg from ffmpeg-static, fallback to system ffmpeg
let ffmpegPath;
try {
    ffmpegPath = require("ffmpeg-static");
} catch (e) {
    ffmpegPath = "ffmpeg";
}

const https = require("https");
const http = require("http");

/**
 * @description Extract video ID from various YouTube URL formats
 */
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

/**
 * @description Fetch JSON from an HTTP/HTTPS URL with timeout and redirect following
 */
async function fetchJSON(urlStr, timeoutMs = 10000) {
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        const res = await fetch(urlStr, {
            signal: controller.signal,
            headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" }
        });
        clearTimeout(timeout);
        if (!res.ok) return null;
        return await res.json();
    } catch (e) {
        return null;
    }
}

/**
 * @description Safely edit a Discord message to swap `oldTitle` → `newTitle`.
 *              - No-op on empty `msg.content` (embed-only messages) — the OLD code
 *                sent an empty content string that blanked the message.
 *              - No-op if `oldTitle` doesn't appear in the content (nothing to swap).
 *              - Suppresses all mentions in the edit so a YouTube title of `@everyone`,
 *                `@here`, or a user mention can't create a real ping.
 */
function safeEditTitle(msg, oldTitle, newTitle) {
    if (!msg || typeof msg.edit !== "function") return;
    const content = typeof msg.content === "string" ? msg.content : "";
    if (!content || !oldTitle || !content.includes(oldTitle)) return;
    const newContent = content.split(oldTitle).join(newTitle || "");
    try {
        msg.edit({ content: newContent, allowedMentions: { parse: [] } }).catch(() => {});
    } catch (_) {}
}

// ─── Dynamic Instance Discovery ───
let _cachedPipedInstances = null;
let _cachedInvidiousInstances = null;
let _instanceCacheTime = 0;
const INSTANCE_CACHE_TTL = 3600000; // 1 hour

async function getActivePipedInstances() {
    if (_cachedPipedInstances && Date.now() - _instanceCacheTime < INSTANCE_CACHE_TTL) {
        return _cachedPipedInstances;
    }
    const fallbacks = [
        "https://pipedapi.kavin.rocks",
        "https://pipedapi.lvk.li",
        "https://pipedapi.tokyo.privacy.coffee",
        "https://pipedapi.us.privacy.coffee",
        "https://pipedapi.ch.privacy.coffee",
        "https://piped-api.garudalinux.org",
        "https://api.piped.projectsegfau.lt",
        "https://piped-api.lunar.icu"
    ];
    try {
        console.log("[FALLBACK] Fetching active Piped instances from registry...");
        const instances = await fetchJSON("https://piped-instances.kavin.rocks/", 8000);
        if (instances && Array.isArray(instances) && instances.length > 0) {
            const parsed = instances
                .filter(i => i.api_url && i.uptime_24h > 90)
                .sort((a, b) => (b.uptime_24h || 0) - (a.uptime_24h || 0))
                .map(i => i.api_url);
            
            _cachedPipedInstances = parsed.length >= 3 ? parsed : [...new Set([...parsed, ...fallbacks])];
            _instanceCacheTime = Date.now();
            console.log(`[FALLBACK] Found ${_cachedPipedInstances.length} active Piped instances`);
            return _cachedPipedInstances;
        }
    } catch (e) {
        console.log(`[FALLBACK] Failed to fetch Piped registry: ${e.message}`);
    }
    _cachedPipedInstances = fallbacks;
    _instanceCacheTime = Date.now();
    return _cachedPipedInstances;
}

async function getActiveInvidiousInstances() {
    if (_cachedInvidiousInstances && Date.now() - _instanceCacheTime < INSTANCE_CACHE_TTL) {
        return _cachedInvidiousInstances;
    }
    const fallbacks = [
        "https://yewtu.be",
        "https://invidious.projectsegfau.lt",
        "https://invidious.flokinet.to",
        "https://invidious.privacydev.net",
        "https://iv.melmac.space",
        "https://invidious.lunar.icu",
        "https://inv.tux.im"
    ];
    try {
        console.log("[FALLBACK] Fetching active Invidious instances from registry...");
        const instances = await fetchJSON("https://api.invidious.io/instances.json?sort_by=type,health", 8000);
        if (instances && Array.isArray(instances) && instances.length > 0) {
            const parsed = instances
                .filter(([name, info]) => info && info.type === "https" && info.api !== false
                    && info.monitor && info.monitor.down === false && (info.monitor.uptime_24h || info.monitor.uptime || 0) > 80)
                .sort(([, a], [, b]) => ((b.monitor?.uptime || 0) - (a.monitor?.uptime || 0)))
                .map(([name, info]) => info.uri)
                .slice(0, 8);
            if (parsed.length > 0) {
                _cachedInvidiousInstances = parsed.length >= 3 ? parsed : [...new Set([...parsed, ...fallbacks])];
                _instanceCacheTime = Date.now();
                console.log(`[FALLBACK] Found ${_cachedInvidiousInstances.length} active Invidious instances (API enabled)`);
                return _cachedInvidiousInstances;
            }
        }
    } catch (e) {
        console.log(`[FALLBACK] Failed to fetch Invidious registry: ${e.message}`);
    }
    _cachedInvidiousInstances = fallbacks;
    _instanceCacheTime = Date.now();
    return _cachedInvidiousInstances;
}

/**
 * @description Parse Netscape cookies.txt file into a Cookie header string
 */
function parseCookieFile() {
    try {
        const fs = require('fs');
        const path = require('path');
        const cookiePath = path.join(__dirname, 'cookies.txt');
        if (!fs.existsSync(cookiePath)) return null;
        const content = fs.readFileSync(cookiePath, 'utf8');
        const cookies = content.split('\n')
            // Netscape cookies.txt exported by browsers marks HttpOnly cookies with a
            // "#HttpOnly_" prefix — the OLD filter dropped these along with real comment
            // lines, so auth cookies were silently thrown away and yt-dlp fell back to
            // anonymous requests on age-gated / members-only videos.
            .filter(line => !/^\s*#(?!HttpOnly_)/.test(line) && line.trim().length > 0)
            .map(line => line.replace(/^#HttpOnly_/, ''))
            .map(line => {
                const parts = line.split('\t');
                if (parts.length >= 7) {
                    // Strip ALL characters outside valid HTTP header range (printable ASCII + HTAB)
                    const name = parts[5].replace(/[^\x09\x20-\x7E]/g, '');
                    const value = parts[6].replace(/[^\x09\x20-\x7E]/g, '');
                    if (name.length === 0) return null;
                    return `${name}=${value}`;
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

/**
 * @description Extract audio URL using youtubei.js (YouTube InnerTube API)
 * Handles both direct and ciphered URLs, tries multiple client types
 * Uses visitor data generation and getBasicInfo fallback for better reliability
 */
async function fetchYouTubeJSAudio(videoUrl) {
    const videoId = extractVideoId(videoUrl);
    if (!videoId) return null;

    const cookieString = parseCookieFile();
    if (cookieString) {
        console.log(`[INNERTUBE] Using cookies for authentication (${cookieString.length} chars)`);
    } else {
        console.log(`[INNERTUBE] No cookies available - may be blocked on datacenter IPs`);
    }

    const clientTypes = ['TV_EMBEDDED', 'TV', 'WEB', 'ANDROID', 'IOS', 'YTMUSIC', 'WEB_EMBEDDED'];
    let ytAuth, ytGuest;
    try {
        const { Innertube } = await import('youtubei.js');
        const createOpts = { retrieve_player: true, generate_session_locally: true };
        
        try {
            ytGuest = await Innertube.create(createOpts);
            console.log('[INNERTUBE] Guest instance initialized successfully');
        } catch (e) {
            console.log(`[INNERTUBE] Guest instance creation failed: ${e.message}`);
        }

        if (cookieString) {
            try {
                const authOpts = { ...createOpts, cookie: cookieString };
                ytAuth = await Innertube.create(authOpts);
                console.log('[INNERTUBE] Auth instance initialized with cookies');
            } catch (e) {
                console.log(`[INNERTUBE] Auth instance creation failed: ${e.message}`);
            }
        }
    } catch (err) {
        console.log(`[INNERTUBE] Failed to load InnerTube library: ${err.message}`);
        return null;
    }

    // Helper to get URL from a format (handles both direct and ciphered)
    const getFormatUrl = async (format, ytInstance) => {
        if (format.url) return format.url;
        try {
            if (typeof format.decipher === 'function') {
                return await format.decipher(ytInstance.session.player);
            }
        } catch (e) {
            console.log(`[INNERTUBE] Decipher failed for format: ${e.message}`);
        }
        return null;
    };

    // Helper to extract audio URL from streaming data
    const extractFromStreamingData = async (streamingData, ytInstance, label) => {
        if (!streamingData) return null;
        const adaptive = streamingData.adaptive_formats || [];
        const combined = streamingData.formats || [];
        console.log(`[INNERTUBE] ${label}: adaptive=${adaptive.length}, combined=${combined.length}`);

        // Try adaptive audio formats first — decipher concurrently instead of serially.
        // The old code awaited each format one at a time; with 10 ciphered formats that
        // meant 10 sequential roundtrips (~10s+) even though the first success wins.
        const audioFormats = adaptive
            .filter(f => f.mime_type && (f.mime_type.includes('audio/webm') || f.mime_type.includes('audio/mp4')))
            .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));

        const raceForFirstUrl = async (formats, kind) => {
            if (formats.length === 0) return null;
            const settled = await Promise.all(formats.map(async (fmt) => {
                try {
                    const url = await getFormatUrl(fmt, ytInstance);
                    return url ? { url, fmt } : null;
                } catch (_) { return null; }
            }));
            for (const s of settled) {
                if (s && s.url) {
                    console.log(`[INNERTUBE] SUCCESS! Got ${kind} via ${label}: ${s.fmt.mime_type} (${s.fmt.bitrate}bps)`);
                    return s.url;
                }
            }
            return null;
        };

        const audioUrl = await raceForFirstUrl(audioFormats, "audio");
        if (audioUrl) return audioUrl;
        const combinedUrl = await raceForFirstUrl(combined, "combined format");
        if (combinedUrl) return combinedUrl;
        return null;
    };

    // Try getInfo and getBasicInfo across clients with both Auth and Guest instances
    const tryClient = async (clientType, useBasic = false) => {
        if (ytAuth) {
            try {
                const label = `${clientType}/${useBasic ? 'getBasicInfo' : 'getInfo'} + AUTH`;
                console.log(`[INNERTUBE] Trying ${label} for: ${videoId}`);
                const info = useBasic 
                    ? await ytAuth.getBasicInfo(videoId, clientType)
                    : await ytAuth.getInfo(videoId, clientType);
                if (info && info.streaming_data) {
                    const result = await extractFromStreamingData(info.streaming_data, ytAuth, label);
                    if (result) return result;
                }
            } catch (e) {
                console.log(`[INNERTUBE] ${clientType} AUTH failed: ${e.message}`);
            }
        }
        if (ytGuest) {
            try {
                const label = `${clientType}/${useBasic ? 'getBasicInfo' : 'getInfo'} + GUEST`;
                console.log(`[INNERTUBE] Trying ${label} for: ${videoId}`);
                const info = useBasic 
                    ? await ytGuest.getBasicInfo(videoId, clientType)
                    : await ytGuest.getInfo(videoId, clientType);
                if (info && info.streaming_data) {
                    const result = await extractFromStreamingData(info.streaming_data, ytGuest, label);
                    if (result) return result;
                }
            } catch (e) {
                console.log(`[INNERTUBE] ${clientType} GUEST failed: ${e.message}`);
            }
        }
        return null;
    };

    // Phase 1: Try getInfo with each client type
    for (const clientType of clientTypes) {
        const url = await tryClient(clientType, false);
        if (url) return url;
    }

    // Phase 2: Try getBasicInfo fallback
    for (const clientType of ['TV_EMBEDDED', 'WEB_EMBEDDED', 'ANDROID', 'IOS']) {
        const url = await tryClient(clientType, true);
        if (url) return url;
    }

    console.log('[INNERTUBE] All client types exhausted');
    return null;
}

/**
 * @description Extract audio URL using Cobalt API (cobalt.tools)
 * Free service that reliably extracts YouTube audio even from datacenter IPs
 */
async function fetchCobaltAudio(videoUrl) {
    const videoId = extractVideoId(videoUrl);
    if (!videoId) return null;

    // Try to discover working Cobalt instances dynamically
    let cobaltEndpoints = [];
    try {
        console.log("[COBALT] Fetching active instances...");
        const instances = await fetchJSON("https://cobalt-api.ayo.tf/api/status", 5000);
        if (instances && Array.isArray(instances)) {
            cobaltEndpoints = instances
                .filter(i => i.api_online && i.api_url)
                .map(i => i.api_url);
        }
    } catch (e) {}
    
    // Also try cobalt.directory
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

    // Hardcoded fallbacks if dynamic discovery fails
    if (cobaltEndpoints.length === 0) {
        cobaltEndpoints = [
            "https://api.cobalt.tools",
            "https://cobalt-api.kwiatekmiki.com",
            "https://cobalt.canine.tools",
            "https://cobalt-api.hyper.lol"
        ];
    }
    
    console.log(`[COBALT] Trying ${cobaltEndpoints.length} Cobalt endpoints...`);

    for (const endpoint of cobaltEndpoints.slice(0, 5)) {
        try {
            console.log(`[COBALT] Trying ${endpoint} for: ${videoId}`);
            const result = await new Promise((resolve) => {
                const postData = JSON.stringify({
                    url: `https://www.youtube.com/watch?v=${videoId}`,
                    downloadMode: "audio",
                    audioFormat: "opus",
                    filenameStyle: "basic"
                });

                const parsed = new URL(endpoint);
                // Use the endpoint's actual path (with query string), not "/".
                // Some Cobalt deployments live behind a prefix like "/api/", which the
                // old hardcoded "/" silently 404'd on.
                const requestPath = (parsed.pathname && parsed.pathname !== "/" ? parsed.pathname : "/") + (parsed.search || "");
                let done = false;
                const safeResolve = (v) => { if (!done) { done = true; resolve(v); } };
                const req = https.request({
                    hostname: parsed.hostname,
                    port: parsed.port || 443,
                    path: requestPath,
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
                            safeResolve(data);
                        } catch (e) { safeResolve(null); }
                    });
                    // Guard mid-body response errors — previously uncaught → uncaughtException.
                    res.on("error", () => safeResolve(null));
                });
                req.on("error", () => safeResolve(null));
                // req.destroy() emits "error" which triggers safeResolve — no double-resolve.
                req.on("timeout", () => { req.destroy(); safeResolve(null); });
                req.write(postData);
                req.end();
            });

            if (result && result.url) {
                console.log(`[COBALT] SUCCESS from ${endpoint}!`);

                // Dynamically resolve 'Unknown Track' title if available.
                // Match on _discordMsg presence too so we don't clobber a duplicate
                // queue entry that shares the same videoId. Sanitize via
                // allowedMentions.parse: [] so a title like "@everyone" can't ping.
                try {
                    const q = global.queue && global.queue.get("queue");
                    if (q && q.songs && result.filename) {
                        const matchSong = q.songs.find(s => s.title === "Unknown Track" && s.url && extractVideoId(s.url) === videoId && s._discordMsg);
                        if (matchSong) {
                            const cleanTitle = result.filename.replace(/\.[^/.]+$/, "").replace(/_/g, " ");
                            if (cleanTitle && cleanTitle !== videoId) {
                                const oldTitle = matchSong.title;
                                matchSong.title = cleanTitle;
                                console.log(`[COBALT] Dynamically resolved title: "${cleanTitle}"`);
                                safeEditTitle(matchSong._discordMsg, oldTitle, cleanTitle);
                            }
                        }
                    }
                } catch (err) {}

                return result.url;
            }

            if (result && result.status === "error") {
                console.log(`[COBALT] ${endpoint} error: ${result.error?.code || result.text || 'unknown'}`);
            }
        } catch (e) {
            console.log(`[COBALT] ${endpoint} failed: ${e.message}`);
        }
    }

    console.log("[COBALT] All endpoints exhausted");
    return null;
}


/**
 * @description Concurrently race multiple instances with a timeout, returning the first valid result
 */
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


/**
 * @description Fallback audio stream URL extractor using dynamic Piped + Invidious instances
 */
async function fetchFallbackAudio(videoUrl) {
    const videoId = extractVideoId(videoUrl);
    if (!videoId) {
        console.log("[FALLBACK] Could not extract video ID from URL:", videoUrl);
        return null;
    }
    console.log(`[FALLBACK] Extracted video ID: ${videoId}`);
    console.log('[FALLBACK] Fetching Piped/Invidious streams...');

    // Try Piped instances concurrently
    const pipedInstances = await getActivePipedInstances();
    const pipedUrls = pipedInstances.slice(0, 6);
    
    console.log(`[FALLBACK] Racing ${pipedUrls.length} Piped instances concurrently...`);
    const pipedResult = await raceInstances(pipedUrls, async (instance) => {
        try {
            const data = await fetchJSON(`${instance}/streams/${videoId}`, 4000);
            if (data && data.audioStreams && data.audioStreams.length > 0) {
                const sorted = data.audioStreams
                    .filter(s => s.url && s.mimeType && s.mimeType.includes("audio"))
                    .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
                if (sorted.length > 0) {
                    console.log(`[FALLBACK] Piped SUCCESS from ${instance}!`);
                    
                    // Dynamically resolve 'Unknown Track' to the real title
                    try {
                        const q = global.queue && global.queue.get("queue");
                        if (q && q.songs && data.title) {
                            const matchSong = q.songs.find(s => s.title === "Unknown Track" && s.url && extractVideoId(s.url) === videoId && s._discordMsg);
                            if (matchSong) {
                                const oldTitle = matchSong.title;
                                matchSong.title = data.title;
                                matchSong.duration = data.duration || matchSong.duration;
                                console.log(`[FALLBACK] Dynamically resolved title: "${data.title}"`);
                                safeEditTitle(matchSong._discordMsg, oldTitle, data.title);
                            }
                        }
                    } catch (err) {}

                    return sorted[0].url;
                }
            }
        } catch (e) {}
        return null;
    });

    if (pipedResult) return pipedResult;

    // Try Invidious instances concurrently
    const invidiousInstances = await getActiveInvidiousInstances();
    const invidiousUrls = invidiousInstances.slice(0, 6);

    console.log(`[FALLBACK] Racing ${invidiousUrls.length} Invidious instances concurrently...`);
    const invidiousResult = await raceInstances(invidiousUrls, async (instance) => {
        try {
            const data = await fetchJSON(`${instance}/api/v1/videos/${videoId}`, 4000);
            if (data && data.adaptiveFormats && data.adaptiveFormats.length > 0) {
                const audioFormats = data.adaptiveFormats
                    .filter(f => f.type && f.type.startsWith("audio/") && f.url)
                    .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
                if (audioFormats.length > 0) {
                    console.log(`[FALLBACK] Invidious SUCCESS from ${instance}!`);
                    
                    // Dynamically resolve 'Unknown Track' to the real title
                    try {
                        const q = global.queue && global.queue.get("queue");
                        if (q && q.songs && data.title) {
                            const matchSong = q.songs.find(s => s.title === "Unknown Track" && s.url && extractVideoId(s.url) === videoId && s._discordMsg);
                            if (matchSong) {
                                const oldTitle = matchSong.title;
                                matchSong.title = data.title;
                                matchSong.duration = data.lengthSeconds || matchSong.duration;
                                console.log(`[FALLBACK] Dynamically resolved title: "${data.title}"`);
                                safeEditTitle(matchSong._discordMsg, oldTitle, data.title);
                            }
                        }
                    } catch (err) {}

                    // Proxy the Google Video URL through the Invidious instance to bypass the VPS IP block (403 Forbidden)
                    try {
                        const directUrl = audioFormats[0].url;
                        const parsedUrl = new URL(directUrl);
                        const parsedInstance = new URL(instance);
                        parsedUrl.host = parsedInstance.host;
                        parsedUrl.protocol = parsedInstance.protocol;
                        
                        // Force Invidious to proxy the video stream
                        if (!parsedUrl.searchParams.has("local")) {
                            parsedUrl.searchParams.set("local", "true");
                        }
                        
                        const proxiedUrl = parsedUrl.toString();
                        return proxiedUrl;
                    } catch (err) {
                        return audioFormats[0].url;
                    }
                }
            }
        } catch (e) {}
        return null;
    });

    if (invidiousResult) return invidiousResult;

    console.log("[FALLBACK] All instances exhausted. No audio source found.");
    return null;
}


module.exports = {

    /**
     * @description Sends logs to console and adds the date/time
     * @param content The content to log
     */
    isFloat: function(n) {
        return ((typeof n==='number')&&(n%1!==0));
    },
    /**
     * @description Validates that a string is a plausible Discord snowflake (17-20 digits).
     * @param {String} id
     */
    isSnowflake: function (id) {
        return typeof id === "string" && /^\d{17,20}$/.test(id);
    },
    /**
     * @description Persist the current global.config.allowed array to allowed.json
     * at the project root (anchored to __dirname, not process.cwd(), so it works
     * no matter where the process was launched from). Returns true on success.
     * @param {Array<String>} [list] Optional list to write; defaults to global.config.allowed.
     */
    saveAllowed: function (list) {
        try {
            const fs = require("fs");
            const arr = Array.isArray(list) ? list : (global.config && global.config.allowed) || [];
            const payload = JSON.stringify({ allowed: arr }, null, 2) + "\n";
            fs.writeFileSync(path.join(__dirname, "allowed.json"), payload, "utf8");
            return true;
        } catch (e) {
            this.log(`[SUDO] Failed to persist allowed.json: ${e && e.message ? e.message : e}`);
            return false;
        }
    },
    log: function(content) {
        // NOTE: previously this function assigned every local (`date_ob`, `date`,
        // `month`, `year`, `dmy`, `hms`) without `let`/`const`, leaking them to the
        // module scope and breaking under `"use strict"`. It also printed
        // getMonth() (0-indexed) directly, so January logged as "00". Both fixed.
        const now = new Date();
        const date = String(now.getDate()).padStart(2, "0");
        const month = String(now.getMonth() + 1).padStart(2, "0");
        const year = String(now.getFullYear());
        const dmy = `${date}/${month}/${year}`;
        const hms = now.toLocaleTimeString();
        console.log(`[ ${dmy} | ${hms} ] ${content}`);
    },
    /**
     * @description Checks if the provided string is an url 
     * @param {String} url 
     */
    isURL: function (url) {
        if(!url) return false;
        var pattern = new RegExp('^(https?:\\/\\/)?'+
            '((([a-z\\d]([a-z\\d-]*[a-z\\d])*)\\.)+[a-z]{2,}|'+
            '((\\d{1,3}\\.){3}\\d{1,3}))|' +
            'localhost' +
            '(\\:\\d+)?(\\/[-a-z\\d%_.~+]*)*'+
            '(\\?[;&a-z\\d%_.~+=-]*)?'+
            '(\\#[-a-z\\d_]*)?$', 'i');
        return pattern.test(url);
    },
    /**
     * @description Create an ascii-table shown in the console on startup with the loaded events & commands
     * @param {Object} loaded 
     */
    showTable: function(loaded){
        var table = new AsciiTable('Loading content...');
        table.setHeading("Commands","Events");
        for(let i=0; i<=Math.max(loaded.commands.length, loaded.events.length)-1; i++){
            table.addRow(loaded.commands[i], loaded.events[i]);
        };
        return table.render();
    },
    getUrl: async function (words){
        // Rewritten from an `async new Promise(...)` executor with no empty-array
        // guard and no `.catch()`. On zero results the old code hit
        // `result[0].id` which threw inside the async executor and swallowed the
        // rejection — the outer `await` never resolved and every `/play <search>`
        // that returned no results hung the entire bot until restart.
        const stringOfWords = Array.isArray(words) ? words.join(" ") : String(words || "");
        if (!stringOfWords.trim()) return null;
        try {
            const results = await YouTube.search(stringOfWords, { limit: 1 });
            if (!results || results.length === 0 || !results[0].id) return null;
            return "https://www.youtube.com/watch?v=" + results[0].id;
        } catch (e) {
            this.log(`[GETURL] Search failed for "${stringOfWords}": ${e && e.message ? e.message : e}`);
            return null;
        }
    },

    /**
     * @description Creates an audio stream from a YouTube URL using yt-dlp + ffmpeg
     * @param {String} url YouTube URL
     * @returns {import('child_process').ChildProcess} ffmpeg process with audio on stdout
     */
    /**
     * @description Builds the combined ffmpeg audio filter string from active filter names
     * @param {Array<String>} filters Array of active filter names
     * @returns {String|null} The combined filter string, or null if no filters
     */
    buildFilterString: function(filters) {
        if (!filters || filters.length === 0) return null;
        const parts = filters.map(f => FILTER_MAP[f]).filter(Boolean);
        return parts.length > 0 ? parts.join(",") : null;
    },
    getAudioStream: async function(url, filters, callback) {
        const utils = require("./utils");
        utils.log(`[AUDIO] Getting audio stream for: ${url}`);
        const activeFilters = filters || [];
        const ffmpegPath = process.env.FFMPEG_PATH || "ffmpeg";

        // Helper: spawn ffmpeg with a direct URL
        const startFfmpeg = (streamUrl) => {
            const ffmpegArgs = [
                "-reconnect", "1",
                "-reconnect_streamed", "1",
                "-reconnect_delay_max", "5",
                "-probesize", "200000",
                "-analyzeduration", "200000",
                "-i", streamUrl,
                "-loglevel", "warning",
                "-ar", "48000",
                "-ac", "2"
            ];
            const filterStr = utils.buildFilterString(activeFilters);
            if (filterStr) {
                ffmpegArgs.push("-af", filterStr);
                utils.log(`[AUDIO] Applying filters: ${filterStr}`);
            }
            ffmpegArgs.push("-f", "opus", "pipe:1");

            const ffmpeg = spawn(ffmpegPath, ffmpegArgs, { stdio: ["ignore", "pipe", "pipe"] });
            // Log stdout errors instead of silently swallowing them — the OLD `() => {}`
            // handler hid EPIPE / read errors that made "no audio" indistinguishable
            // from "player idle" downstream.
            ffmpeg.stdout.on("error", (err) => {
                if (err && err.code !== "EPIPE") utils.log(`[FFMPEG STDOUT] ${err.message}`);
            });
            ffmpeg.stderr.on("data", (data) => {
                const msg = data.toString().trim();
                // Suppress harmless messages that occur when player is stopped mid-stream
                if (msg && !/(Connection reset by peer|Broken pipe|Error muxing a packet|Error submitting a packet|EPIPE)/i.test(msg)) {
                    utils.log(`[FFMPEG STDERR] ${msg}`);
                }
            });
            ffmpeg.on("error", (err) => utils.log(`[FFMPEG ERROR] ${err.message}`));
            ffmpeg.ytdlpProcess = null;
            return ffmpeg;
        };

        // === METHOD 1: Piped/Invidious (Fastest & Proxied for VPS) ===
        try {
            const fallbackUrl = await fetchFallbackAudio(url);
            if (fallbackUrl) {
                utils.log(`[AUDIO] Proxied fallback success! Starting ffmpeg...`);
                callback(startFfmpeg(fallbackUrl));
                return;
            }
        } catch (e) {
            utils.log(`[AUDIO] Fallback error: ${e.message}`);
        }

        // === METHOD 2: Cobalt API (reliable for datacenter IPs) ===
        utils.log(`[AUDIO] Proxied fallbacks failed, trying Cobalt...`);
        try {
            const cobaltUrl = await fetchCobaltAudio(url);
            if (cobaltUrl) {
                utils.log(`[AUDIO] Cobalt success! Starting ffmpeg...`);
                callback(startFfmpeg(cobaltUrl));
                return;
            }
        } catch (e) {
            utils.log(`[AUDIO] Cobalt error: ${e.message}`);
        }

        // === METHOD 3: InnerTube with cookies ===
        utils.log(`[AUDIO] Cobalt failed, trying InnerTube...`);
        try {
            const audioUrl = await fetchYouTubeJSAudio(url);
            if (audioUrl) {
                utils.log(`[AUDIO] InnerTube success! Starting ffmpeg...`);
                callback(startFfmpeg(audioUrl));
                return;
            }
        } catch (e) {
            utils.log(`[AUDIO] InnerTube error: ${e.message}`);
        }

        // === METHOD 4: yt-dlp with cookies ===
        utils.log(`[AUDIO] InnerTube failed, trying yt-dlp...`);
        const fs = require("fs");
        const path = require("path");
        const cookiesPath = path.join(__dirname, "cookies.txt");

        const ytdlpArgs = [
            "--no-playlist",
            "--format", "bestaudio/best",
            "--get-url",
            "--no-warnings",
            "--no-check-certificates",
            "--extractor-args", "youtube:player_client=web_embedded,tv_embedded,mweb"
        ];
        // Route through WARP proxy if available
        if (process.env.HTTP_PROXY) {
            ytdlpArgs.push("--proxy", process.env.HTTP_PROXY);
        }
        if (fs.existsSync(cookiesPath)) {
            ytdlpArgs.push("--cookies", cookiesPath);
        }
        ytdlpArgs.push(url);

        let ytdlp;
        try {
            ytdlp = spawn("yt-dlp", ytdlpArgs, { stdio: ["ignore", "pipe", "pipe"] });
        } catch (spawnErr) {
            utils.log(`[YT-DLP] spawn threw synchronously: ${spawnErr.message}`);
            callback(null);
            return;
        }
        let ytdlpOutput = "";
        let done = false;
        const safeCallback = (v) => { if (!done) { done = true; callback(v); } };

        // Guard: if yt-dlp is not installed, Node emits an async "error" (ENOENT).
        // Without this handler the whole process crashes on uncaughtException.
        ytdlp.on("error", (err) => {
            utils.log(`[YT-DLP] spawn error: ${err && err.message ? err.message : err} (is yt-dlp installed?)`);
            safeCallback(null);
        });

        // Hard timeout — the old code had no upper bound, so a hung yt-dlp
        // would freeze the whole play() flow forever.
        const ytdlpTimeout = setTimeout(() => {
            utils.log(`[YT-DLP] Timed out after 30s — killing.`);
            try { ytdlp.kill(process.platform === "win32" ? undefined : "SIGKILL"); } catch (_) {}
            safeCallback(null);
        }, 30000);

        ytdlp.stdout.on("data", (data) => { ytdlpOutput += data.toString(); });
        ytdlp.stderr.on("data", (data) => {
            const msg = data.toString().trim();
            if (msg.includes("ERROR")) utils.log(`[YT-DLP] ${msg}`);
        });

        ytdlp.on("close", async (code) => {
            clearTimeout(ytdlpTimeout);
            if (code === 0 && ytdlpOutput) {
                // Handle CRLF (Windows) and skip yt-dlp warning lines so we grab the URL,
                // not a "WARNING:" line that happened to be printed first.
                const urlLine = ytdlpOutput
                    .split(/\r?\n/)
                    .map(l => l.trim())
                    .find(l => l && /^https?:\/\//i.test(l));
                if (urlLine) {
                    utils.log(`[AUDIO] yt-dlp success! Starting ffmpeg...`);
                    safeCallback(startFfmpeg(urlLine));
                    return;
                }
            }
            utils.log(`[AUDIO] ALL methods failed. No audio source available.`);
            safeCallback(null);
        });
    },




    /**
     * @description Plays the next song in the queue using Lavalink (primary) or @discordjs/voice (fallback)
     * @param {Object} song The song object to play
     */
    play: async function(song) {

        const utils = require("./utils");
        const serverQueue = global.queue.get("queue");

        if(!song){
            utils.log("No songs left in queue");
            if (serverQueue && serverQueue.connection) {
                try {
                    serverQueue.connection.destroy();
                } catch (e) {}
            }
            // Leave Lavalink voice too
            if (serverQueue && serverQueue.guildId) {
                try {
                    const lavalink = require("./lavalink");
                    lavalink.leaveChannel(serverQueue.guildId);
                } catch (e) {}
            }
            global.queue.delete("queue");
            return;
        }

        utils.log(`Started playing the music : ${song.title}`);

        if (serverQueue) {
            // === TRY LAVALINK FIRST ===
            try {
                const lavalink = require("./lavalink");
                const shoukaku = lavalink.getShoukaku();

                if (shoukaku && shoukaku.players) {
                    utils.log(`[LAVALINK] Trying Lavalink playback for: ${song.title}`);

                    // Search/load the track via Lavalink
                    const track = await lavalink.searchTrack(song.url);

                    if (track) {
                        // Backfill the real title/duration from Lavalink. When the $play
                        // pre-fetch was skipped for speed, song.title is still a placeholder
                        // ("Unknown Track"); replace it and edit the already-sent
                        // "started playing" / "added to queue" message in place.
                        try {
                            if (track.info && track.info.title && song.title !== track.info.title) {
                                const oldTitle = song.title;
                                song.title = track.info.title;
                                if (typeof track.info.length === "number" && track.info.length > 0) {
                                    song.duration = Math.floor(track.info.length / 1000);
                                }
                                if (song._discordMsg && oldTitle) {
                                    safeEditTitle(song._discordMsg, oldTitle, track.info.title);
                                }
                            }
                        } catch (_) {}

                        // Join voice channel via Lavalink/Shoukaku
                        const guildId = (serverQueue.voiceChannel && serverQueue.voiceChannel.guild && serverQueue.voiceChannel.guild.id) || serverQueue.guildId;
                        const channelId = (serverQueue.voiceChannel && serverQueue.voiceChannel.id) || serverQueue.channelId;

                        if (guildId && channelId) {
                            // Store guild ID for cleanup
                            serverQueue.guildId = guildId;

                            // Get or create player
                            let player = lavalink.getPlayer(guildId);
                            if (!player) {
                                // Destroy old @discordjs/voice connection if exists
                                if (serverQueue.connection) {
                                    try { serverQueue.connection.destroy(); } catch(e) {}
                                    serverQueue.connection = null;
                                }
                                player = await lavalink.joinChannel(guildId, channelId, 0);
                            }

                            if (player) {
                                // Clear auto-disconnect timer
                                if (serverQueue.disconnectTimer) {
                                    clearTimeout(serverQueue.disconnectTimer);
                                    serverQueue.disconnectTimer = null;
                                }

                                // Set up event handlers ONCE per player object.
                                // Previously the guard lived on the serverQueue, so if the queue was
                                // torn down and later recreated (e.g. song ends → new queue), the same
                                // Shoukaku player would get another set of handlers → duplicate `end`
                                // events + double-shift of the queue.
                                if (!player._khonshuHandlersBound) {
                                    player._khonshuHandlersBound = true;

                                    player.on("end", (data) => {
                                        if (data.reason === "replaced") return;

                                        utils.log(`[LAVALINK] Track finished`);
                                        const q = global.queue.get("queue");
                                        if (!q) return;

                                        if (q.restarting) {
                                            q.restarting = false;
                                            utils.play(q.songs[0]);
                                            return;
                                        }

                                        if (q.songs[0]) {
                                            utils.log(`Finished playing the music : ${q.songs[0].title}`);
                                        }

                                        if (q.loop === false || q.skipped === true) {
                                            q.songs.shift();
                                        }
                                        if (q.skipped === true) {
                                            q.skipped = false;
                                        }

                                        // Split the "queue drained" and "next song" branches — the OLD
                                        // code called utils.play(q.songs[0]) with songs[0] === undefined
                                        // AFTER arming disconnectTimer, which triggered the !song path
                                        // and immediately destroyed the connection. Auto-DC never fired.
                                        if (q.songs.length === 0) {
                                            utils.log(`[AUTO-DC] No songs left. Will disconnect in 5 minutes if idle.`);
                                            q.disconnectTimer = setTimeout(() => {
                                                const stillQ = global.queue.get("queue");
                                                if (stillQ && stillQ.songs.length === 0) {
                                                    utils.log(`[AUTO-DC] 5 minutes idle. Disconnecting...`);
                                                    try { lavalink.leaveChannel(guildId); } catch(e) {}
                                                    global.queue.delete("queue");
                                                    if (stillQ.textchannel) {
                                                        try { stillQ.textchannel.send("🌙 Khonshu disconnected after 5 minutes of inactivity."); } catch(e) {}
                                                    }
                                                }
                                            }, AUTO_DISCONNECT_MS);
                                            return;
                                        }

                                        utils.play(q.songs[0]);
                                    });

                                    player.on("stuck", (data) => {
                                        utils.log(`[LAVALINK] Track stuck`);
                                        const q = global.queue.get("queue");
                                        if (!q || !q.songs || q.songs.length === 0) return;
                                        // Preserve the current track when looping — old code shifted
                                        // unconditionally, so a transient stuck killed the loop.
                                        if (!q.loop && !q.skipped) {
                                            q.songs.shift();
                                        }
                                        if (q.songs.length === 0) {
                                            utils.log("[LAVALINK] Queue drained after stuck event.");
                                            return;
                                        }
                                        utils.play(q.songs[0]);
                                    });

                                    player.on("exception", (data) => {
                                        utils.log(`[LAVALINK] Track exception: ${data.message}`);
                                    });

                                    player.on("closed", (data) => {
                                        utils.log(`[LAVALINK] Voice connection closed: code ${data.code}`);
                                    });
                                }

                                // Play the track!
                                // `?? 0.5` (not `|| 0.5`) so an intentional 0 stays 0 (mute).
                                const rawVol = (typeof serverQueue.volume === "number" && Number.isFinite(serverQueue.volume)) ? serverQueue.volume : 0.5;
                                const vol = Math.max(0, Math.min(1000, Math.round(rawVol * 100)));
                                await lavalink.playTrack(player, track, vol);
                                utils.log(`[LAVALINK] Now playing: ${track.info.title}`);
                                serverQueue.useLavalink = true;
                                return; // SUCCESS!
                            }
                        }
                    }

                    utils.log(`[LAVALINK] Lavalink playback setup failed, falling back to ffmpeg...`);
                }
            } catch (e) {
                utils.log(`[LAVALINK] Lavalink error: ${e.message}, falling back to ffmpeg...`);
            }

            // === FALLBACK: Old ffmpeg method ===
            utils.getAudioStream(song.url, serverQueue.filters || [], async (ffmpegProcess) => {
                const currentQueue = global.queue.get("queue");
                if (!currentQueue) {
                    if (ffmpegProcess) { try { ffmpegProcess.kill(); } catch (_) {} }
                    return;
                }

                if (!ffmpegProcess) {
                    utils.log(`[AUDIO] Failed to get audio stream for: ${song.title}`);

                    // Notify the user
                    if (currentQueue.textchannel) {
                        try {
                            currentQueue.textchannel.send(`❌ **Failed to play '${song.title}'** — all audio sources unavailable. Skipping...`);
                        } catch (e) {}
                    }

                    // Remove the failed song and play the next one
                    if (currentQueue.songs && currentQueue.songs.length > 0) {
                        currentQueue.songs.shift();
                    }

                    if (currentQueue.songs && currentQueue.songs.length > 0) {
                        utils.log(`[AUDIO] Auto-skipping to next track: ${currentQueue.songs[0].title}`);
                        utils.play(currentQueue.songs[0]);
                    } else {
                        utils.log(`[AUTO-DC] No songs left after failure. Will disconnect in 5 minutes if idle.`);
                        currentQueue.disconnectTimer = setTimeout(() => {
                            const stillQ = global.queue.get("queue");
                            if (stillQ && stillQ.songs.length === 0) {
                                utils.log(`[AUTO-DC] 5 minutes idle. Disconnecting...`);
                                if (stillQ.connection) {
                                    try { stillQ.connection.destroy(); } catch(e) {}
                                }
                                global.queue.delete("queue");
                                if (stillQ.textchannel) {
                                    try { stillQ.textchannel.send("🌙 Khonshu disconnected after 5 minutes of inactivity."); } catch(e) {}
                                }
                            }
                        }, AUTO_DISCONNECT_MS);
                    }
                    return;
                }

                try {
                    // If Lavalink was "connected" so addAndPlay skipped joinVChannel, but
                    // Lavalink track resolution/join failed and we fell through to ffmpeg,
                    // there is no voice connection yet. Establish one now, otherwise the
                    // audio player has nothing to subscribe to and the track plays to
                    // nowhere while the queue silently advances.
                    if (!currentQueue.connection && currentQueue.voiceChannel) {
                        try {
                            utils.log("[AUDIO] No voice connection present for ffmpeg fallback — joining now.");
                            currentQueue.connection = await utils.joinVChannel(currentQueue.voiceChannel, currentQueue.voiceChannel.guild.client);
                            currentQueue.useLavalink = false;
                        } catch (joinErr) {
                            utils.log(`[AUDIO] Failed to join voice for ffmpeg fallback: ${joinErr && joinErr.message ? joinErr.message : joinErr}`);
                            if (ffmpegProcess) { try { ffmpegProcess.kill(); } catch (_) {} }
                            if (currentQueue.textchannel) {
                                try { currentQueue.textchannel.send(`❌ **Failed to play '${song.title}'** — could not connect to voice.`); } catch (_) {}
                            }
                            return;
                        }
                    }

                    const resource = createAudioResource(ffmpegProcess.stdout, {
                        inputType: StreamType.OggOpus,
                        inlineVolume: true
                    });

                    // `?? 1` (not `|| 1`) so an intentional 0 stays 0.
                    const rawVol = (typeof currentQueue.volume === "number" && Number.isFinite(currentQueue.volume)) ? currentQueue.volume : 1;
                    if (resource.volume) {
                        resource.volume.setVolume(rawVol);
                    }
                    currentQueue.currentResource = resource;

                    if (currentQueue.disconnectTimer) {
                        clearTimeout(currentQueue.disconnectTimer);
                        currentQueue.disconnectTimer = null;
                    }

                    if (!currentQueue.player) {
                        currentQueue.player = createAudioPlayer();

                        currentQueue.player.on(AudioPlayerStatus.Idle, () => {
                            utils.log(`[PLAYER] Track finished`);
                            const q = global.queue.get("queue");
                            if (!q) return;

                            if (q.restarting) {
                                q.restarting = false;
                                utils.play(q.songs[0]);
                                return;
                            }

                            if (q.ffmpegProcess) {
                                try { q.ffmpegProcess.kill(); } catch (e) {}
                            }

                            if (q.songs[0]) {
                                utils.log(`Finished playing the music : ${q.songs[0].title}`);
                            }

                            if (q.loop === false || q.skipped === true) {
                                q.songs.shift();
                            }
                            if (q.skipped === true) {
                                q.skipped = false;
                            }

                            // Same auto-DC fix as the Lavalink path — do NOT fall through
                            // to utils.play(undefined) after arming the timer.
                            if (q.songs.length === 0) {
                                utils.log(`[AUTO-DC] No songs left. Will disconnect in 5 minutes if idle.`);
                                q.disconnectTimer = setTimeout(() => {
                                    const stillQ = global.queue.get("queue");
                                    if (stillQ && stillQ.songs.length === 0) {
                                        utils.log(`[AUTO-DC] 5 minutes idle. Disconnecting...`);
                                        if (stillQ.connection) {
                                            try { stillQ.connection.destroy(); } catch(e) {}
                                        }
                                        global.queue.delete("queue");
                                        if (stillQ.textchannel) {
                                            try { stillQ.textchannel.send("🌙 Khonshu disconnected after 5 minutes of inactivity."); } catch(e) {}
                                        }
                                    }
                                }, AUTO_DISCONNECT_MS);
                                return;
                            }

                            utils.play(q.songs[0]);
                        });

                        currentQueue.player.on("error", (err) => {
                            console.error("Audio Player Error:", err && err.message ? err.message : err);
                        });

                        // Previous handler closed over the outer `song` variable, so after the
                        // first track this log printed the WRONG title on every subsequent song.
                        // The player is only created once per session, but Playing fires on each
                        // resource — read the current queue's head song at emit time.
                        currentQueue.player.on(AudioPlayerStatus.Playing, () => {
                            const q = global.queue.get("queue");
                            const title = (q && q.songs && q.songs[0] && q.songs[0].title) || "(unknown)";
                            utils.log(`[PLAYER] Track started playing: ${title}`);
                        });

                        if (currentQueue.connection) {
                            currentQueue.connection.subscribe(currentQueue.player);
                        }
                    }

                    // Kill the previous ffmpeg process before overwriting the reference.
                    // Otherwise every skip / new track leaks the old ffmpeg child + its fds.
                    if (currentQueue.ffmpegProcess && currentQueue.ffmpegProcess !== ffmpegProcess) {
                        try { currentQueue.ffmpegProcess.kill(); } catch (_) {}
                    }
                    currentQueue.ffmpegProcess = ffmpegProcess;
                    currentQueue.player.play(resource);

                } catch (err) {
                    console.error("Error starting playback:", err);
                }
            });
        }
    },

    /**
     * @description Fetches metadata (title, duration) for a YouTube video URL/ID using Piped/Invidious
     * @param {String} videoUrl The video URL or ID
     * @returns {Promise<{title: String, duration: Number}|null>}
     */
    fetchMetadata: async function(videoUrl) {
        const utils = require("./utils");
        const videoId = extractVideoId(videoUrl);
        if (!videoId) return null;

        utils.log(`[METADATA] Attempting fallback metadata search for ID: ${videoId}`);

        // Try Piped instances concurrently
        try {
            const pipedInstances = await getActivePipedInstances();
            const pipedUrls = pipedInstances.slice(0, 6);
            const pipedRes = await raceInstances(pipedUrls, async (instance) => {
                try {
                    const data = await fetchJSON(`${instance}/streams/${videoId}`, 5000);
                    if (data && data.title) {
                        utils.log(`[METADATA] Piped SUCCESS: "${data.title}" from ${instance}`);
                        return {
                            title: data.title,
                            duration: data.duration || 0
                        };
                    }
                } catch (e) {}
                return null;
            });
            if (pipedRes) return pipedRes;
        } catch (err) {
            utils.log(`[METADATA] Piped race failed: ${err.message}`);
        }

        // Try Invidious instances concurrently
        try {
            const invidiousInstances = await getActiveInvidiousInstances();
            const invidiousUrls = invidiousInstances.slice(0, 6);
            const invRes = await raceInstances(invidiousUrls, async (instance) => {
                try {
                    const data = await fetchJSON(`${instance}/api/v1/videos/${videoId}`, 5000);
                    if (data && data.title) {
                        utils.log(`[METADATA] Invidious SUCCESS: "${data.title}" from ${instance}`);
                        return {
                            title: data.title,
                            duration: data.lengthSeconds || 0
                        };
                    }
                } catch (e) {}
                return null;
            });
            if (invRes) return invRes;
        } catch (err) {
            utils.log(`[METADATA] Invidious race failed: ${err.message}`);
        }

        // Last resort: try yt-dlp --get-title
        try {
            utils.log(`[METADATA] Piped/Invidious failed. Trying yt-dlp --get-title...`);
            const { spawn } = require("child_process");
            const fs = require("fs");
            const path = require("path");
            const cookiesPath = path.join(__dirname, "cookies.txt");
            const ytArgs = ["--get-title", "--get-duration", "--no-warnings", "--no-check-certificates"];
            if (fs.existsSync(cookiesPath)) ytArgs.push("--cookies", cookiesPath);
            ytArgs.push(`https://www.youtube.com/watch?v=${videoId}`);

            const result = await new Promise((resolve) => {
                let done = false;
                const safeResolve = (v) => { if (!done) { done = true; resolve(v); } };
                let proc;
                try {
                    proc = spawn("yt-dlp", ytArgs, { stdio: ["ignore", "pipe", "pipe"] });
                } catch (spawnErr) {
                    utils.log(`[METADATA] yt-dlp spawn threw: ${spawnErr.message}`);
                    return safeResolve(null);
                }
                let output = "";
                proc.stdout.on("data", (d) => { output += d.toString(); });
                // Windows: plain kill() may not stop the process; SIGKILL on POSIX.
                const timeout = setTimeout(() => {
                    try { proc.kill(process.platform === "win32" ? undefined : "SIGKILL"); } catch(e) {}
                    safeResolve(null);
                }, 8000);
                proc.on("close", (code) => {
                    clearTimeout(timeout);
                    if (code === 0 && output.trim()) {
                        // Split on \r?\n so Windows CRLF doesn't leave trailing \r on the title,
                        // which the old code fed into strict equality checks downstream.
                        const lines = output.trim().split(/\r?\n/).map(l => l.trim()).filter(Boolean);
                        const title = lines[0];
                        let duration = 0;
                        if (lines[1]) {
                            const parts = lines[1].split(":").map(Number);
                            if (parts.length === 3) duration = parts[0]*3600 + parts[1]*60 + parts[2];
                            else if (parts.length === 2) duration = parts[0]*60 + parts[1];
                            else duration = parts[0] || 0;
                        }
                        if (title) {
                            utils.log(`[METADATA] yt-dlp SUCCESS: "${title}"`);
                            safeResolve({ title, duration });
                        } else safeResolve(null);
                    } else safeResolve(null);
                });
                proc.on("error", () => { clearTimeout(timeout); safeResolve(null); });
            });
            if (result) return result;
        } catch (err) {
            utils.log(`[METADATA] yt-dlp fallback failed: ${err.message}`);
        }

        return null;
    },

    /**
     * @description Fallback search query resolver using Piped/Invidious APIs
     * @param {String} searchQuery The search query
     * @returns {Promise<{title: String, duration: Number, url: String}|null>}
     */
    fetchSearch: async function(searchQuery) {
        const utils = require("./utils");
        utils.log(`[SEARCH] Attempting fallback search for query: "${searchQuery}"`);

        // Try Piped instances concurrently
        try {
            const pipedInstances = await getActivePipedInstances();
            const pipedUrls = pipedInstances.slice(0, 4);
            const pipedRes = await raceInstances(pipedUrls, async (instance) => {
                try {
                    const data = await fetchJSON(`${instance}/search?q=${encodeURIComponent(searchQuery)}&filter=videos`, 3000);
                    if (data && data.items && data.items.length > 0) {
                        const first = data.items.find(item => item.type === "stream");
                        if (first) {
                            utils.log(`[SEARCH] Piped SUCCESS: "${first.title}" from ${instance}`);
                            return {
                                title: first.title,
                                duration: first.duration || 0,
                                url: `https://www.youtube.com/watch?v=${extractVideoId(first.url) || first.url}`
                            };
                        }
                    }
                } catch (e) {}
                return null;
            });
            if (pipedRes) return pipedRes;
        } catch (err) {
            utils.log(`[SEARCH] Piped race failed: ${err.message}`);
        }

        // Try Invidious instances concurrently
        try {
            const invidiousInstances = await getActiveInvidiousInstances();
            const invidiousUrls = invidiousInstances.slice(0, 4);
            const invRes = await raceInstances(invidiousUrls, async (instance) => {
                try {
                    const data = await fetchJSON(`${instance}/api/v1/search?q=${encodeURIComponent(searchQuery)}&type=video`, 3000);
                    if (data && data.length > 0) {
                        const first = data[0];
                        utils.log(`[SEARCH] Invidious SUCCESS: "${first.title}" from ${instance}`);
                        return {
                            title: first.title,
                            duration: first.lengthSeconds || 0,
                            url: `https://www.youtube.com/watch?v=${first.videoId}`
                        };
                    }
                } catch (e) {}
                return null;
            });
            if (invRes) return invRes;
        } catch (err) {
            utils.log(`[SEARCH] Invidious race failed: ${err.message}`);
        }

        return null;
    },


    /**
     * @description Joins a voice channel using @discordjs/voice with DAVE E2EE support
     * @param {Object} voiceChannel The voice channel to join
     * @param {Object} client The Discord client
     * @returns {Object} The voice connection
     */
    joinVChannel: async function(voiceChannel, client) {
        const utils = require("./utils");
        utils.log(`[VOICE] Joining channel: ${voiceChannel.name} (${voiceChannel.id})`);

        const connection = joinVoiceChannel({
            channelId: voiceChannel.id,
            guildId: voiceChannel.guild.id,
            adapterCreator: voiceChannel.guild.voiceAdapterCreator,
            selfDeaf: false,
            selfMute: false
        });

        // Wait for the connection to be ready
        try {
            await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
            utils.log(`[VOICE] Successfully connected to ${voiceChannel.name} (DAVE E2EE active)`);
        } catch (err) {
            utils.log(`[VOICE] Connection failed, destroying...`);
            // Guard: entersState may reject because the connection already reached
            // Destroyed state; calling destroy() a second time throws in older
            // @discordjs/voice versions. Only destroy if still alive.
            try {
                if (connection.state && connection.state.status !== VoiceConnectionStatus.Destroyed) {
                    connection.destroy();
                }
            } catch (_) {}
            throw err;
        }

        return connection;
    }
}