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
                if (res.statusCode !== 200) {
                    resolve(null);
                    res.resume(); // drain
                    return;
                }
                let body = "";
                res.on("data", chunk => body += chunk);
                res.on("end", () => {
                    try { resolve(JSON.parse(body)); } catch (e) { resolve(null); }
                });
            });
            req.on("error", () => resolve(null));
            req.on("timeout", () => { req.destroy(); resolve(null); });
        } catch (e) {
            resolve(null);
        }
    });
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
    let yt;
    try {
        const { Innertube } = await import('youtubei.js');
        const createOpts = { retrieve_player: true, generate_session_locally: true };
        if (cookieString) {
            createOpts.cookie = cookieString;
        }
        yt = await Innertube.create(createOpts);
    } catch (err) {
        console.log(`[INNERTUBE] Failed to create Innertube instance: ${err.message}`);
        return null;
    }

    // Helper to get URL from a format (handles both direct and ciphered)
    const getFormatUrl = (format) => {
        if (format.url) return format.url;
        try {
            if (typeof format.decipher === 'function') {
                return format.decipher(yt.session.player);
            }
        } catch (e) {
            console.log(`[INNERTUBE] Decipher failed for format: ${e.message}`);
        }
        return null;
    };

    // Helper to extract audio URL from streaming data
    const extractFromStreamingData = (streamingData, label) => {
        if (!streamingData) return null;
        const adaptive = streamingData.adaptive_formats || [];
        const combined = streamingData.formats || [];
        console.log(`[INNERTUBE] ${label}: adaptive=${adaptive.length}, combined=${combined.length}`);

        // Try adaptive audio formats first
        const audioFormats = adaptive
            .filter(f => f.mime_type && (f.mime_type.includes('audio/webm') || f.mime_type.includes('audio/mp4')))
            .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));

        for (const fmt of audioFormats) {
            const url = getFormatUrl(fmt);
            if (url) {
                console.log(`[INNERTUBE] SUCCESS! Got audio via ${label}: ${fmt.mime_type} (${fmt.bitrate}bps)`);
                return url;
            }
        }

        // Try combined formats (video+audio) as fallback
        for (const fmt of combined) {
            const url = getFormatUrl(fmt);
            if (url) {
                console.log(`[INNERTUBE] SUCCESS! Got combined format via ${label}: ${fmt.mime_type}`);
                return url;
            }
        }
        return null;
    };

    // Phase 1: Try getInfo with each client type
    for (const clientType of clientTypes) {
        try {
            console.log(`[INNERTUBE] Trying getInfo(${clientType}) for: ${videoId}`);
            const info = await yt.getInfo(videoId, clientType);

            if (!info || !info.streaming_data) {
                console.log(`[INNERTUBE] No streaming data from ${clientType} (getInfo)`);
                continue;
            }

            const result = extractFromStreamingData(info.streaming_data, `${clientType}/getInfo`);
            if (result) return result;

            console.log(`[INNERTUBE] ${clientType}/getInfo: formats found but all URLs are ciphered/inaccessible`);
        } catch (e) {
            console.log(`[INNERTUBE] ${clientType}/getInfo failed: ${e.message}`);
        }
    }

    // Phase 2: Try getBasicInfo (lighter request, sometimes works when getInfo doesn't)
    for (const clientType of ['TV_EMBEDDED', 'WEB_EMBEDDED', 'ANDROID', 'IOS']) {
        try {
            console.log(`[INNERTUBE] Trying getBasicInfo(${clientType}) for: ${videoId}`);
            const info = await yt.getBasicInfo(videoId, clientType);

            if (!info || !info.streaming_data) {
                console.log(`[INNERTUBE] No streaming data from ${clientType} (getBasicInfo)`);
                continue;
            }

            const result = extractFromStreamingData(info.streaming_data, `${clientType}/getBasicInfo`);
            if (result) return result;
        } catch (e) {
            console.log(`[INNERTUBE] ${clientType}/getBasicInfo failed: ${e.message}`);
        }
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
                console.log(`[COBALT] SUCCESS from ${endpoint}!`);

                // Dynamically resolve 'Unknown Track' title if available
                try {
                    const q = global.queue?.get("queue");
                    if (q && q.songs && result.filename) {
                        const matchSong = q.songs.find(s => s.title === "Unknown Track" && s.url && extractVideoId(s.url) === videoId);
                        if (matchSong) {
                            const cleanTitle = result.filename.replace(/\.[^/.]+$/, "").replace(/_/g, " ");
                            if (cleanTitle && cleanTitle !== videoId) {
                                const oldTitle = matchSong.title;
                                matchSong.title = cleanTitle;
                                console.log(`[COBALT] Dynamically resolved title: "${cleanTitle}"`);
                                if (matchSong._discordMsg) {
                                    try {
                                        const msg = matchSong._discordMsg;
                                        const newText = msg.content.replace(oldTitle, cleanTitle);
                                        msg.edit(newText).catch(() => {});
                                    } catch (editErr) {}
                                }
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
                        const q = global.queue?.get("queue");
                        if (q && q.songs && data.title) {
                            const matchSong = q.songs.find(s => s.title === "Unknown Track" && s.url && extractVideoId(s.url) === videoId);
                            if (matchSong) {
                                const oldTitle = matchSong.title;
                                matchSong.title = data.title;
                                matchSong.duration = data.duration || matchSong.duration;
                                console.log(`[FALLBACK] Dynamically resolved title: "${data.title}"`);
                                // Edit the Discord message to show the real title
                                if (matchSong._discordMsg) {
                                    try {
                                        const msg = matchSong._discordMsg;
                                        const newText = msg.content.replace(oldTitle, data.title);
                                        msg.edit(newText).catch(() => {});
                                    } catch (editErr) {}
                                }
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
                        const q = global.queue?.get("queue");
                        if (q && q.songs && data.title) {
                            const matchSong = q.songs.find(s => s.title === "Unknown Track" && s.url && extractVideoId(s.url) === videoId);
                            if (matchSong) {
                                const oldTitle = matchSong.title;
                                matchSong.title = data.title;
                                matchSong.duration = data.lengthSeconds || matchSong.duration;
                                console.log(`[FALLBACK] Dynamically resolved title: "${data.title}"`);
                                // Edit the Discord message to show the real title
                                if (matchSong._discordMsg) {
                                    try {
                                        const msg = matchSong._discordMsg;
                                        const newText = msg.content.replace(oldTitle, data.title);
                                        msg.edit(newText).catch(() => {});
                                    } catch (editErr) {}
                                }
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
    log: function(content) {
        date_ob = new Date();
      
        date = date_ob.getDate().toString();
        month = date_ob.getMonth().toString();
        year = date_ob.getFullYear().toString();
      
        if(date.length === 1){date = "0" + date;};
        if(month.length === 1){month = "0" + month;};
        
        dmy = date + "/" + month + "/" + year;
      
        /* Gets hours, minutes and seconds */ 
        hms = date_ob.toLocaleTimeString();
      
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
        stringOfWords = words.join(" ");
        lookingOnYtb = new Promise(async (resolve) => {
            YouTube.search(stringOfWords, { limit: 1 })
                .then(result => {
                    resolve("https://www.youtube.com/watch?v=" + result[0].id);
                });
        });

        let link = await lookingOnYtb;
        return link;
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
            ffmpeg.stdout.on("error", () => {});
            ffmpeg.stderr.on("data", (data) => {
                const msg = data.toString().trim();
                // Suppress harmless messages that occur when player is stopped mid-stream
                if (msg && !/(Connection reset by peer|Broken pipe|Error muxing a packet|Error submitting a packet)/i.test(msg)) {
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
        const cookiesPath = path.join(process.cwd(), "cookies.txt");

        const ytdlpArgs = [
            "--no-playlist",
            "--format", "bestaudio/best",
            "--get-url",
            "--no-warnings",
            "--no-check-certificates",
            "--extractor-args", "youtube:player_client=mweb,tv"
        ];
        if (fs.existsSync(cookiesPath)) {
            ytdlpArgs.push("--cookies", cookiesPath);
        }
        ytdlpArgs.push(url);

        const ytdlp = spawn("yt-dlp", ytdlpArgs, { stdio: ["ignore", "pipe", "pipe"] });
        let ytdlpUrl = "";

        ytdlp.stdout.on("data", (data) => { ytdlpUrl += data.toString().trim(); });
        ytdlp.stderr.on("data", (data) => {
            const msg = data.toString().trim();
            if (msg.includes("ERROR")) utils.log(`[YT-DLP] ${msg}`);
        });

        ytdlp.on("close", async (code) => {
            if (code === 0 && ytdlpUrl) {
                if (ytdlpUrl.includes("\n")) ytdlpUrl = ytdlpUrl.split("\n")[0].trim();
                utils.log(`[AUDIO] yt-dlp success! Starting ffmpeg...`);
                callback(startFfmpeg(ytdlpUrl));
                return;
            }
            utils.log(`[AUDIO] ALL methods failed. No audio source available.`);
            callback(null);
        });
    },




    /**
     * @description Plays the next song in the queue using Lavalink (primary) or @discordjs/voice (fallback)
     * @param {Object} song The song object to play
     */
    play: async function(song) {

        const utils = require("./utils");
        const serverQueue = queue.get("queue");

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
            queue.delete("queue");
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
                        // Join voice channel via Lavalink/Shoukaku
                        const guildId = serverQueue.voiceChannel?.guild?.id || serverQueue.guildId;
                        const channelId = serverQueue.voiceChannel?.id || serverQueue.channelId;
                        
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

                                // Set up event handlers (once)
                                if (!serverQueue.lavalinkEventsSet) {
                                    serverQueue.lavalinkEventsSet = true;
                                    
                                    player.on("end", (data) => {
                                        if (data.reason === "replaced") return;
                                        
                                        utils.log(`[LAVALINK] Track finished`);
                                        const q = queue.get("queue");
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

                                        if (q.songs.length === 0) {
                                            utils.log(`[AUTO-DC] No songs left. Will disconnect in 5 minutes if idle.`);
                                            q.disconnectTimer = setTimeout(() => {
                                                const stillQ = queue.get("queue");
                                                if (stillQ && stillQ.songs.length === 0) {
                                                    utils.log(`[AUTO-DC] 5 minutes idle. Disconnecting...`);
                                                    try { lavalink.leaveChannel(guildId); } catch(e) {}
                                                    queue.delete("queue");
                                                    if (stillQ.textchannel) {
                                                        try { stillQ.textchannel.send("🌙 Khonshu disconnected after 5 minutes of inactivity."); } catch(e) {}
                                                    }
                                                }
                                            }, AUTO_DISCONNECT_MS);
                                        }

                                        utils.play(q.songs[0]);
                                    });

                                    player.on("stuck", (data) => {
                                        utils.log(`[LAVALINK] Track stuck, skipping...`);
                                        const q = queue.get("queue");
                                        if (q) {
                                            q.songs.shift();
                                            utils.play(q.songs[0]);
                                        }
                                    });

                                    player.on("exception", (data) => {
                                        utils.log(`[LAVALINK] Track exception: ${data.message}`);
                                    });

                                    player.on("closed", (data) => {
                                        utils.log(`[LAVALINK] Voice connection closed: code ${data.code}`);
                                    });
                                }

                                // Play the track!
                                const vol = Math.round((serverQueue.volume || 0.5) * 100);
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
            utils.getAudioStream(song.url, serverQueue.filters || [], (ffmpegProcess) => {
                const currentQueue = queue.get("queue");
                if (!currentQueue) {
                    if (ffmpegProcess) ffmpegProcess.kill();
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
                            const stillQ = queue.get("queue");
                            if (stillQ && stillQ.songs.length === 0) {
                                utils.log(`[AUTO-DC] 5 minutes idle. Disconnecting...`);
                                if (stillQ.connection) {
                                    try { stillQ.connection.destroy(); } catch(e) {}
                                }
                                queue.delete("queue");
                                if (stillQ.textchannel) {
                                    try { stillQ.textchannel.send("🌙 Khonshu disconnected after 5 minutes of inactivity."); } catch(e) {}
                                }
                            }
                        }, 300000);
                    }
                    return;
                }

                try {
                    const resource = createAudioResource(ffmpegProcess.stdout, {
                        inputType: StreamType.OggOpus,
                        inlineVolume: true
                    });

                    if (resource.volume) {
                        resource.volume.setVolume(currentQueue.volume);
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
                            const q = queue.get("queue");
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

                            if (q.songs.length === 0) {
                                utils.log(`[AUTO-DC] No songs left. Will disconnect in 5 minutes if idle.`);
                                q.disconnectTimer = setTimeout(() => {
                                    const stillQ = queue.get("queue");
                                    if (stillQ && stillQ.songs.length === 0) {
                                        utils.log(`[AUTO-DC] 5 minutes idle. Disconnecting...`);
                                        if (stillQ.connection) {
                                            try { stillQ.connection.destroy(); } catch(e) {}
                                        }
                                        queue.delete("queue");
                                        if (stillQ.textchannel) {
                                            try { stillQ.textchannel.send("🌙 Khonshu disconnected after 5 minutes of inactivity."); } catch(e) {}
                                        }
                                    }
                                }, AUTO_DISCONNECT_MS);
                            }

                            utils.play(q.songs[0]);
                        });

                        currentQueue.player.on("error", (err) => {
                            console.error("Audio Player Error:", err);
                        });

                        currentQueue.player.on(AudioPlayerStatus.Playing, () => {
                            utils.log(`[PLAYER] Track started playing: ${song.title}`);
                        });

                        if (currentQueue.connection) {
                            currentQueue.connection.subscribe(currentQueue.player);
                        }
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
            const cookiesPath = path.join(process.cwd(), "cookies.txt");
            const ytArgs = ["--get-title", "--get-duration", "--no-warnings", "--no-check-certificates"];
            if (fs.existsSync(cookiesPath)) ytArgs.push("--cookies", cookiesPath);
            ytArgs.push(`https://www.youtube.com/watch?v=${videoId}`);

            const result = await new Promise((resolve) => {
                const proc = spawn("yt-dlp", ytArgs, { stdio: ["ignore", "pipe", "pipe"] });
                let output = "";
                proc.stdout.on("data", (d) => { output += d.toString(); });
                const timeout = setTimeout(() => { try { proc.kill(); } catch(e) {} resolve(null); }, 8000);
                proc.on("close", (code) => {
                    clearTimeout(timeout);
                    if (code === 0 && output.trim()) {
                        const lines = output.trim().split("\n");
                        const title = lines[0]?.trim();
                        // Parse duration like "3:45" or "1:02:30"
                        let duration = 0;
                        if (lines[1]) {
                            const parts = lines[1].trim().split(":").map(Number);
                            if (parts.length === 3) duration = parts[0]*3600 + parts[1]*60 + parts[2];
                            else if (parts.length === 2) duration = parts[0]*60 + parts[1];
                            else duration = parts[0] || 0;
                        }
                        if (title) {
                            utils.log(`[METADATA] yt-dlp SUCCESS: "${title}"`);
                            resolve({ title, duration });
                        } else resolve(null);
                    } else resolve(null);
                });
                proc.on("error", () => { clearTimeout(timeout); resolve(null); });
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
            connection.destroy();
            throw err;
        }

        return connection;
    }
}