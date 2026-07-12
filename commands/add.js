const utils = require("../utils");

/**
 * @description Grant bot access to a user. Usage: $add sudo <userID | @mention>
 *              Owner-only — sudo users can run every other command but cannot
 *              grant/revoke access, so we re-check ownership here even though the
 *              message gate already let them through.
 * @param {Discord.Client} client
 * @param {Discord.Message} message
 * @param {Array<String>} args e.g. ["sudo", "733592459480662016"]
 */
module.exports.run = async (client, message, args) => {

    // Privilege-escalation guard: only the configured owner may manage sudo access.
    if (message.author.id !== global.config.owner) {
        try { await message.channel.send("❌ Only the bot owner can manage sudo access."); } catch (_) {}
        return;
    }

    const sub = (args[0] || "").toLowerCase();
    if (sub !== "sudo") {
        try { await message.channel.send("❌ Usage: `$add sudo <userID | @mention>`"); } catch (_) {}
        return;
    }

    // Accept a raw snowflake or a <@id> / <@!id> mention.
    const raw = args[1] || "";
    const id = raw.replace(/[<@!>]/g, "").trim();

    if (!utils.isSnowflake(id)) {
        try { await message.channel.send("❌ That doesn't look like a valid user ID. Usage: `$add sudo <userID | @mention>`"); } catch (_) {}
        return;
    }

    if (!Array.isArray(global.config.allowed)) global.config.allowed = [];

    if (id === global.config.owner) {
        try { await message.channel.send("ℹ️ That user is the owner and already has full access."); } catch (_) {}
        return;
    }

    if (global.config.allowed.includes(id)) {
        try { await message.channel.send(`ℹ️ <@${id}> (\`${id}\`) already has sudo access.`); } catch (_) {}
        return;
    }

    global.config.allowed.push(id);
    const saved = utils.saveAllowed();

    // Best-effort username lookup for a friendlier confirmation; never block on it.
    let label = `\`${id}\``;
    try {
        const user = await client.users.fetch(id);
        if (user && user.username) label = `**${user.username}** (\`${id}\`)`;
    } catch (_) {}

    utils.log(`[SUDO] Owner granted sudo access to ${id}`);

    const note = saved ? "" : "\n⚠️ Access is active now but couldn't be saved to disk — it will be lost on restart.";
    try {
        await message.channel.send({
            content: `✅ Granted sudo access to ${label}.${note}`,
            allowedMentions: { parse: [] }
        });
    } catch (_) {}
};

module.exports.names = {
    list: ["add"]
};
