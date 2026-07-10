const strings = require("../strings.json");
const utils = require("../utils");

// ═══════════════════════════════════════════
// Available DSP Filters
// ═══════════════════════════════════════════
const AVAILABLE_FILTERS = ["bassboost", "nightcore", "vaporwave", "8d"];

// Lavalink filter presets. Each preset yields a partial Shoukaku filter payload;
// active filters get merged and passed to player.setFilters(...).
const LAVALINK_PRESETS = {
    bassboost: {
        equalizer: [
            { band: 0, gain: 0.30 },
            { band: 1, gain: 0.25 },
            { band: 2, gain: 0.20 },
            { band: 3, gain: 0.15 },
            { band: 4, gain: 0.10 }
        ]
    },
    nightcore: {
        timescale: { speed: 1.25, pitch: 1.25, rate: 1.0 }
    },
    vaporwave: {
        timescale: { speed: 0.8, pitch: 0.8, rate: 1.0 }
    },
    "8d": {
        rotation: { rotationHz: 0.2 }
    }
};

/**
 * @description Toggle DSP audio filters (bassboost, nightcore, vaporwave, 8d).
 *              Works on both the ffmpeg pipeline (restart current track) and the
 *              Lavalink pipeline (setFilters, no restart needed).
 * @param {Discord.Client} client
 * @param {Discord.Message} message
 * @param {Array<String>} args filter name / "clear" / "list"
 */
module.exports.run = async (client, message, args) => {

    const serverQueue = global.queue.get("queue");

    if (!serverQueue || !serverQueue.songs || serverQueue.songs.length === 0) {
        try { await message.channel.send("❌ You need to have a song playing to change filters."); } catch (_) {}
        return;
    }

    // Initialize filters array if not exists (older queue constructors omit it).
    if (!serverQueue.filters) serverQueue.filters = [];

    // No args — show current status
    if (!args[0]) {
        const active = serverQueue.filters.length > 0
            ? serverQueue.filters.map(f => `\`${f}\``).join(", ")
            : "None";
        try {
            await message.channel.send(
                `🎛️ **Active Filters:** ${active}\n` +
                `📋 **Available:** ${AVAILABLE_FILTERS.map(f => `\`${f}\``).join(", ")}\n` +
                `💡 Use \`$filter <name>\` to toggle, \`$filter clear\` to remove all.`
            );
        } catch (_) {}
        return;
    }

    const filterName = args[0].toLowerCase();

    // Clear all filters
    if (filterName === "clear" || filterName === "off" || filterName === "reset") {
        if (serverQueue.filters.length === 0) {
            try { await message.channel.send("🎛️ No filters are currently active."); } catch (_) {}
            return;
        }
        serverQueue.filters = [];
        utils.log(`[FILTER] Cleared all filters`);
        await applyFilters(serverQueue, message);
        return;
    }

    // List available filters
    if (filterName === "list") {
        const active = serverQueue.filters.length > 0
            ? serverQueue.filters.map(f => `\`${f}\``).join(", ")
            : "None";
        try {
            await message.channel.send(
                `🎛️ **Active Filters:** ${active}\n` +
                `📋 **Available:** ${AVAILABLE_FILTERS.map(f => `\`${f}\``).join(", ")}`
            );
        } catch (_) {}
        return;
    }

    // Validate filter name
    if (!AVAILABLE_FILTERS.includes(filterName)) {
        try {
            await message.channel.send(
                `❌ Unknown filter \`${filterName}\`.\n` +
                `📋 **Available:** ${AVAILABLE_FILTERS.map(f => `\`${f}\``).join(", ")}`
            );
        } catch (_) {}
        return;
    }

    // Toggle the filter
    const idx = serverQueue.filters.indexOf(filterName);
    if (idx > -1) {
        serverQueue.filters.splice(idx, 1);
        utils.log(`[FILTER] Disabled: ${filterName}`);
        try {
            await message.channel.send(`🎛️ **${filterName}** filter disabled. Active: ${serverQueue.filters.length > 0 ? serverQueue.filters.map(f => `\`${f}\``).join(", ") : "None"}`);
        } catch (_) {}
    } else {
        serverQueue.filters.push(filterName);
        utils.log(`[FILTER] Enabled: ${filterName}`);
        try {
            await message.channel.send(`🎛️ **${filterName}** filter enabled. Active: ${serverQueue.filters.map(f => `\`${f}\``).join(", ")}`);
        } catch (_) {}
    }

    await applyFilters(serverQueue, message);
};

/**
 * @description Applies the current filter set. On Lavalink, uses setFilters (no restart).
 *              On the ffmpeg pipeline, restarts the current track through the Idle handler.
 */
async function applyFilters(serverQueue, message) {
    if (!serverQueue || !serverQueue.songs || serverQueue.songs.length === 0) return;

    if (serverQueue.useLavalink && serverQueue.guildId) {
        try {
            const lavalink = require("../lavalink");
            const player = lavalink.getPlayer(serverQueue.guildId);
            if (player) {
                // Merge every enabled preset into one payload; empty payload clears everything.
                const payload = {};
                for (const name of serverQueue.filters) {
                    const preset = LAVALINK_PRESETS[name];
                    if (!preset) continue;
                    for (const key of Object.keys(preset)) {
                        payload[key] = preset[key];
                    }
                }
                await player.setFilters(payload);
                utils.log(`[FILTER] Applied Lavalink filters: ${JSON.stringify(payload)}`);
            } else {
                utils.log("[FILTER] Lavalink path active but no player found; filter stored but not applied.");
            }
        } catch (e) {
            utils.log(`[FILTER] Lavalink setFilters failed: ${e && e.message ? e.message : e}`);
        }
        return;
    }

    // ffmpeg path — kill current process and let the Idle handler restart.
    if (serverQueue.ffmpegProcess) {
        try { serverQueue.ffmpegProcess.kill(); } catch (_) {}
    }
    serverQueue.restarting = true;
    if (serverQueue.player) {
        try { serverQueue.player.stop(); } catch (_) {}
    }
}

module.exports.names = {
    list: ["filter", "f", "fx", "effect"]
};
