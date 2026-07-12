const utils = require("../utils");

/**
 * @description View who currently has bot access. Usage: $sudo list
 *              Owner-only, to avoid leaking the access list to sudo users.
 * @param {Discord.Client} client
 * @param {Discord.Message} message
 * @param {Array<String>} args e.g. ["list"]
 */
module.exports.run = async (client, message, args) => {

    if (message.author.id !== global.config.owner) {
        try { await message.channel.send("❌ Only the bot owner can view the sudo list."); } catch (_) {}
        return;
    }

    const sub = (args[0] || "list").toLowerCase();
    if (sub !== "list") {
        try { await message.channel.send("❌ Usage: `$sudo list`  •  `$add sudo <id>`  •  `$remove sudo <id>`"); } catch (_) {}
        return;
    }

    const allowed = Array.isArray(global.config.allowed) ? global.config.allowed : [];

    const lines = [`🔐 **Bot Access**`, `• Owner: \`${global.config.owner || "(unset)"}\``];

    if (allowed.length === 0) {
        lines.push("• Sudo users: _none_");
    } else {
        lines.push(`• Sudo users (${allowed.length}):`);
        for (const id of allowed) {
            let label = `\`${id}\``;
            try {
                const user = await client.users.fetch(id);
                if (user && user.username) label = `**${user.username}** (\`${id}\`)`;
            } catch (_) {}
            lines.push(`   – ${label}`);
        }
    }

    try {
        await message.channel.send({
            content: lines.join("\n"),
            allowedMentions: { parse: [] }
        });
    } catch (_) {}
};

module.exports.names = {
    list: ["sudo"]
};
