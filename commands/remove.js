const utils = require("../utils");

/**
 * @description Revoke bot access from a user. Usage: $remove sudo <userID | @mention>
 *              Owner-only, for the same privilege-escalation reason as $add.
 * @param {Discord.Client} client
 * @param {Discord.Message} message
 * @param {Array<String>} args e.g. ["sudo", "733592459480662016"]
 */
module.exports.run = async (client, message, args) => {

    if (message.author.id !== global.config.owner) {
        try { await message.channel.send("❌ Only the bot owner can manage sudo access."); } catch (_) {}
        return;
    }

    const sub = (args[0] || "").toLowerCase();
    if (sub !== "sudo") {
        try { await message.channel.send("❌ Usage: `$remove sudo <userID | @mention>`"); } catch (_) {}
        return;
    }

    const raw = args[1] || "";
    const id = raw.replace(/[<@!>]/g, "").trim();

    if (!utils.isSnowflake(id)) {
        try { await message.channel.send("❌ That doesn't look like a valid user ID. Usage: `$remove sudo <userID | @mention>`"); } catch (_) {}
        return;
    }

    if (!Array.isArray(global.config.allowed)) global.config.allowed = [];

    const idx = global.config.allowed.indexOf(id);
    if (idx === -1) {
        try { await message.channel.send(`ℹ️ <@${id}> (\`${id}\`) doesn't have sudo access.`); } catch (_) {}
        return;
    }

    global.config.allowed.splice(idx, 1);
    const saved = utils.saveAllowed();

    utils.log(`[SUDO] Owner revoked sudo access from ${id}`);

    const note = saved ? "" : "\n⚠️ Access is revoked now but couldn't be saved to disk — it may return on restart.";
    try {
        await message.channel.send({
            content: `✅ Revoked sudo access from \`${id}\`.${note}`,
            allowedMentions: { parse: [] }
        });
    } catch (_) {}
};

module.exports.names = {
    list: ["remove", "del", "rm"]
};
