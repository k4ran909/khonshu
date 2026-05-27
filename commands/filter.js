const strings = require("../strings.json");
const utils = require("../utils");

// ═══════════════════════════════════════════
// Available DSP Filters
// ═══════════════════════════════════════════
const AVAILABLE_FILTERS = ["bassboost", "nightcore", "vaporwave", "8d"];

/** 
 * @description Toggle DSP audio filters (bassboost, nightcore, vaporwave, 8d)
 * @param {Discord.Client} client the client that runs the commands
 * @param {Discord.Message} message the command's message
 * @param {Array<String>} args filter name or "clear"/"list"
 */
module.exports.run = async (client, message, args) => {

    const serverQueue = queue.get("queue");

    if (!serverQueue || !serverQueue.songs || serverQueue.songs.length === 0) {
        return message.channel.send("❌ You need to have a song playing to change filters.");
    }

    // Initialize filters array if not exists
    if (!serverQueue.filters) serverQueue.filters = [];

    // No args — show current status
    if (!args[0]) {
        const active = serverQueue.filters.length > 0 
            ? serverQueue.filters.map(f => `\`${f}\``).join(", ")
            : "None";
        return message.channel.send(
            `🎛️ **Active Filters:** ${active}\n` +
            `📋 **Available:** ${AVAILABLE_FILTERS.map(f => `\`${f}\``).join(", ")}\n` +
            `💡 Use \`$filter <name>\` to toggle, \`$filter clear\` to remove all.`
        );
    }

    const filterName = args[0].toLowerCase();

    // Clear all filters
    if (filterName === "clear" || filterName === "off" || filterName === "reset") {
        if (serverQueue.filters.length === 0) {
            return message.channel.send("🎛️ No filters are currently active.");
        }
        serverQueue.filters = [];
        utils.log(`[FILTER] Cleared all filters`);

        // Restart current track with no filters
        restartWithFilters(serverQueue, message);
        return;
    }

    // List available filters
    if (filterName === "list") {
        const active = serverQueue.filters.length > 0 
            ? serverQueue.filters.map(f => `\`${f}\``).join(", ")
            : "None";
        return message.channel.send(
            `🎛️ **Active Filters:** ${active}\n` +
            `📋 **Available:** ${AVAILABLE_FILTERS.map(f => `\`${f}\``).join(", ")}`
        );
    }

    // Validate filter name
    if (!AVAILABLE_FILTERS.includes(filterName)) {
        return message.channel.send(
            `❌ Unknown filter \`${filterName}\`.\n` +
            `📋 **Available:** ${AVAILABLE_FILTERS.map(f => `\`${f}\``).join(", ")}`
        );
    }

    // Toggle the filter
    const idx = serverQueue.filters.indexOf(filterName);
    if (idx > -1) {
        // Remove (disable)
        serverQueue.filters.splice(idx, 1);
        utils.log(`[FILTER] Disabled: ${filterName}`);
        try {
            await message.channel.send(`🎛️ **${filterName}** filter disabled. Active: ${serverQueue.filters.length > 0 ? serverQueue.filters.map(f => `\`${f}\``).join(", ") : "None"}`);
        } catch (e) {}
    } else {
        // Add (enable)
        serverQueue.filters.push(filterName);
        utils.log(`[FILTER] Enabled: ${filterName}`);
        try {
            await message.channel.send(`🎛️ **${filterName}** filter enabled. Active: ${serverQueue.filters.map(f => `\`${f}\``).join(", ")}`);
        } catch (e) {}
    }

    // Restart current track to apply new filter chain
    restartWithFilters(serverQueue, message);
};

/**
 * @description Restarts the current track to apply new filter settings
 */
function restartWithFilters(serverQueue, message) {
    if (!serverQueue || !serverQueue.songs || serverQueue.songs.length === 0) return;

    // Kill current ffmpeg process
    if (serverQueue.ffmpegProcess) {
        try { serverQueue.ffmpegProcess.kill(); } catch (e) {}
    }

    // Mark as restarting so the Idle handler doesn't shift the queue
    serverQueue.restarting = true;

    // Stop the player — the Idle handler will detect `restarting` and replay
    if (serverQueue.player) {
        serverQueue.player.stop();
    }
}

module.exports.names = {
    list: ["filter", "f", "fx", "effect"]
};
