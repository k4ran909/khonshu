// Load .env file if present
try {
  const fs = require("fs");
  const path = require("path");
  const envPath = path.join(__dirname, ".env");
  if (fs.existsSync(envPath)) {
    const envConfig = fs.readFileSync(envPath, "utf8");
    for (const line of envConfig.split("\n")) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith("#") && trimmed.includes("=")) {
        const [key, ...vals] = trimmed.split("=");
        const val = vals.join("=").trim().replace(/^["']|["']$/g, "");
        if (key && process.env[key.trim()] === undefined) {
          process.env[key.trim()] = val;
        }
      }
    }
  }
} catch (e) {}

// Setup global undici proxy if HTTP_PROXY is defined in environment (Node 20+ fetch support)
if (process.env.HTTP_PROXY) {
  try {
    const { setGlobalDispatcher, EnvHttpProxyAgent } = require("undici");
    const proxyAgent = new EnvHttpProxyAgent();
    setGlobalDispatcher(proxyAgent);
    console.log(`[INIT] Globally configured undici EnvHttpProxyAgent with HTTP_PROXY: ${process.env.HTTP_PROXY}`);
  } catch (e) {
    console.error("[INIT] Failed to configure global undici EnvHttpProxyAgent:", e);
  }
}

// Ensure ffmpeg-static path is globally available in environment variables for fluent-ffmpeg (both CJS and ESM)
try {
  const isAlpine = require("fs").existsSync("/etc/alpine-release");
  if (isAlpine || process.platform === "linux") {
    process.env.FFMPEG_PATH = "ffmpeg";
    console.log("[INIT] Alpine Linux or Linux environment detected. Using native system 'ffmpeg' binary.");
  } else {
    const ffmpegStaticPath = require("ffmpeg-static");
    if (ffmpegStaticPath) {
      process.env.FFMPEG_PATH = ffmpegStaticPath;
      console.log(`[INIT] Set process.env.FFMPEG_PATH to: ${ffmpegStaticPath}`);
    }
  }
} catch (e) {
  console.error("[INIT] Failed to set process.env.FFMPEG_PATH:", e);
}

// Write YouTube cookies from environment variable if provided
if (process.env.YOUTUBE_COOKIES) {
  try {
    let cookiesContent = process.env.YOUTUBE_COOKIES.trim();
    // Auto-detect base64: if it doesn't start with '#' (Netscape header), try decoding
    if (cookiesContent.startsWith("base64:")) {
      cookiesContent = Buffer.from(cookiesContent.substring(7), "base64").toString("utf8");
    } else if (!cookiesContent.startsWith("#") && !cookiesContent.startsWith(".")) {
      // Looks like base64 (doesn't start with Netscape cookie markers), try decoding
      try {
        const decoded = Buffer.from(cookiesContent, "base64").toString("utf8");
        if (decoded.includes("# Netscape") || decoded.includes(".youtube.com")) {
          cookiesContent = decoded;
          console.log("[INIT] Auto-detected and decoded base64 YOUTUBE_COOKIES");
        }
      } catch (e) {
        // Not valid base64, use raw content
      }
    }
    // Sanitize cookies: only allow standard printable ASCII, tab, carriage return, and newline
    cookiesContent = cookiesContent.replace(/[^\x09\x0A\x0D\x20-\x7E]/g, "");
    
    const path = require("path");
    const fs = require("fs");
    fs.writeFileSync(path.join(__dirname, "cookies.txt"), cookiesContent, "utf8");
    console.log("[INIT] Successfully wrote and sanitized cookies from YOUTUBE_COOKIES environment variable to cookies.txt");
  } catch (e) {
    console.error("[INIT] Failed to write cookies from YOUTUBE_COOKIES:", e);
  }
}

const Discord = require("discord.js-selfbot-v13");
const client = new Discord.Client({
  intents: [
    Discord.Intents.FLAGS.GUILDS,
    Discord.Intents.FLAGS.GUILD_MESSAGES,
    Discord.Intents.FLAGS.GUILD_VOICE_STATES
  ],  
  checkUpdate: false,
});

const fs = require('fs');
const Enmap = require('enmap');
const utils = require('./utils');

if (!process.env.TOKEN){
  try{
    const config = require("./config");
    global.config = {'token': config.token, 'prefix': config.prefix, 'owner': config.owner};
  } catch (e){
    console.error("No config file found, create it or use environnement variables.");
    process.exit(1);
  };
} else{
  if (!process.env.PREFIX) process.env.PREFIX="$";
  global.config = {
    'token': process.env.TOKEN,
    'prefix': process.env.PREFIX,
    'owner': process.env.OWNER || ""
  };
}
// Build the allowed (sudo) list by MERGING two sources so runtime grants survive
// restarts and env-configured users are never dropped:
//   1. allowed.json at the project root — written by $add/$remove sudo at runtime
//   2. the ALLOWED env var (comma-separated) — static deploy-time config
// The merged, de-duplicated result is what the authorization gate checks.
{
  let fromFile = [];
  try { fromFile = require("./allowed.json").allowed || []; }
  catch (e) { fromFile = []; }

  const fromEnv = process.env.ALLOWED
    ? process.env.ALLOWED.split(",").map(s => s.trim()).filter(Boolean)
    : [];

  global.config.allowed = [...new Set([...fromFile, ...fromEnv])];
}

client.login(global.config.token)

utils.log("Logging in...");

/* ----------------------------------------------- */

global.queue = new Map();
global.ownerVoiceChannel = null; // Tracks owner's current voice channel for DM commands

// Track owner's voice state in real-time
client.on('voiceStateUpdate', (oldState, newState) => {
    if (newState.id === global.config.owner) {
        global.ownerVoiceChannel = newState.channel || null;
    }
});
client.commands = new Enmap();

/* ----------------------------------------------- */

var loaded = {events: [], commands: []};

var promise = new Promise((resolve) => {
  fs.readdir('./events/', (err, files) => {
    if (err) return console.error;
    files.forEach(file => {
      if (!file.endsWith('.js')) return;
      const evt = require(`./events/${file}`);
      let evtName = file.split('.')[0];
      loaded.events.push(evtName)
      client.on(evtName, evt.bind(null, client));
    });
    resolve();
  });
});


fs.readdir('./commands/', async (err, files) => {
  if (err) return console.error;
  files.forEach(file => {
    if (!file.endsWith('.js')) return;
    let props = require(`./commands/${file}`);
    props.names.list.forEach(name => {
      client.commands.set(name, props);
    })
    let cmdName = file.split('.')[0];
    loaded.commands.push(cmdName)
  });
  promise.then(() => {utils.log(`Table of commands and events :\n${utils.showTable(loaded)}`)});
});


/* ----------------------------------------------- */