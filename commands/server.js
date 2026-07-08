const utils = require("../utils");

/**
 * @description Server management: list joined servers, preview an invite, or leave a server.
 *              NOTE: The old `server <invite>` auto-accept path called `client.acceptInvite`
 *              which is one of Discord's top selfbot-detection signals. It has been removed —
 *              use `server info <invite>` to preview, then join manually from your account.
 * @param {Discord.Client} client
 * @param {Discord.Message} message
 * @param {Array<String>} args
 */
module.exports.run = async (client, message, args) => {

    const sub = args[0] ? args[0].toLowerCase() : "";

    // Sub-command: server info <invite>
    if (sub === "info" && args[1]) {
        return showInviteInfo(client, message, args[1]);
    }

    // Sub-command: server list — show all servers the bot is in
    if (sub === "list") {
        const total = client.guilds.cache.size;
        const guilds = client.guilds.cache
            .sort((a, b) => b.memberCount - a.memberCount)
            .map(g => `**${g.name}** — \`${g.id}\` (${g.memberCount} members)`);
        const head = guilds.slice(0, 25);
        try {
            await message.channel.send(
                `📋 **Servers (${total} total):**\n${head.join("\n")}`
                + (total > 25 ? `\n... and ${total - 25} more` : "")
            );
        } catch (_) {}
        return;
    }

    // Sub-command: server leave <guild_id>
    if (sub === "leave" && args[1]) {
        const guild = client.guilds.cache.get(args[1]);
        if (!guild) {
            try { await message.channel.send(`❌ Not in a server with ID: \`${args[1]}\``); } catch (_) {}
            return;
        }
        try {
            await guild.leave();
            utils.log(`[SERVER] Left server: ${guild.name}`);
            try { await message.channel.send(`✅ Left **${guild.name}**`); } catch (_) {}
        } catch (e) {
            try { await message.channel.send(`❌ Failed to leave: ${e && e.message ? e.message : e}`); } catch (_) {}
        }
        return;
    }

    // Default / usage / accidental raw-invite invocation
    try {
        await message.channel.send(
            "**Server management commands:**\n" +
            "• `server list` — list servers the bot is in\n" +
            "• `server info <invite>` — preview a server without joining\n" +
            "• `server leave <guildId>` — leave a server\n\n" +
            "⚠ Auto-accepting invites via the bot has been disabled — Discord treats it as a selfbot signal. " +
            "Use `server info <invite>` to preview, then join manually from your Discord client."
        );
    } catch (_) {}
};

/**
 * @description Show invite/server info without joining. Read-only API call, safe.
 */
async function showInviteInfo(client, message, input) {
    const inviteRegex = /(?:https?:\/\/)?(?:www\.)?(?:discord\.gg|discord(?:app)?\.com\/invite)\/([a-zA-Z0-9_-]+)/i;
    const match = input.match(inviteRegex);
    const inviteCode = match ? match[1] : input;

    try {
        const invite = await client.fetchInvite(inviteCode);
        const guild = invite.guild;
        const alreadyIn = guild && client.guilds.cache.has(guild.id);

        const info = [
            `📋 **Server Info:**`,
            `**Name:** ${guild ? guild.name : "Unknown"}`,
            `**ID:** \`${guild ? guild.id : "N/A"}\``,
            `**Members:** ${invite.memberCount || "?"} (${invite.presenceCount || "?"} online)`,
            `**Channel:** #${invite.channel ? invite.channel.name : "unknown"}`,
            `**Status:** ${alreadyIn ? "✅ Already a member" : "❌ Not a member"}`
        ];

        if (guild && guild.description) {
            info.push(`**Description:** ${guild.description}`);
        }

        try { await message.channel.send(info.join("\n")); } catch (_) {}
    } catch (e) {
        try { await message.channel.send(`❌ Could not fetch invite info: ${e && e.message ? e.message : e}`); } catch (_) {}
    }
}

module.exports.names = {
    list: ["server", "joinserver", "invite"]
};
