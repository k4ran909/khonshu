const utils = require("../utils");

// Friendly aliases → the four statuses Discord accepts.
const STATUS_MAP = {
    online: "online", active: "online", on: "online",
    idle: "idle", away: "idle", afk: "idle",
    dnd: "dnd", busy: "dnd", "do-not-disturb": "dnd", donotdisturb: "dnd",
    invisible: "invisible", offline: "invisible", off: "invisible", hidden: "invisible"
};

/**
 * @description Change the bot's online status. Usage: $status <online|idle|dnd|invisible>
 *              Aliases accepted: active, away/afk, busy, offline. Owner-only.
 * @param {Discord.Client} client
 * @param {Discord.Message} message
 * @param {Array<String>} args e.g. ["dnd"]
 */
module.exports.run = async (client, message, args) => {

    if (message.author.id !== global.config.owner) {
        try { await message.channel.send("❌ Only the bot owner can change the status."); } catch (_) {}
        return;
    }

    const choice = (args[0] || "").toLowerCase();
    const status = STATUS_MAP[choice];

    if (!status) {
        try {
            await message.channel.send(
                "❌ Usage: `$status <online | idle | dnd | invisible>`\n" +
                "Aliases: `active`, `away`/`afk`, `busy`, `offline`"
            );
        } catch (_) {}
        return;
    }

    try {
        client.user.setStatus(status);
    } catch (e) {
        try { await message.channel.send(`❌ Failed to set status: ${e && e.message ? e.message : e}`); } catch (_) {}
        return;
    }

    // Persist alongside any existing activity so a restart restores both.
    const current = utils.loadPresence() || {};
    current.status = status;
    const saved = utils.savePresence(current);

    utils.log(`[PRESENCE] Owner set status to ${status}`);

    const emoji = { online: "🟢", idle: "🌙", dnd: "⛔", invisible: "⚫" }[status] || "🔵";
    const note = saved ? "" : "\n⚠️ Applied now but couldn't be saved — it will reset on restart.";
    try { await message.channel.send(`${emoji} Status set to **${status}**.${note}`); } catch (_) {}
};

module.exports.names = {
    list: ["status"]
};
