const utils = require("../utils");

/** 
 * @description Join a Discord server using an invite link
 * @param {Discord.Client} client the client that runs the commands
 * @param {Discord.Message} message the command's message
 * @param {Array<String>} args the invite link
 */
module.exports.run = async (client, message, args) => {

    if (!args[0]) {
        return message.channel.send(
            "❌ **Usage:** `server <invite link>`\n" +
            "**Example:** `server https://discord.gg/INVITE_CODE`\n\n" +
            "💡 **Tip:** Use `server info <invite>` to view server details without joining."
        );
    }

    // Sub-command: server info <invite>
    if (args[0].toLowerCase() === "info" && args[1]) {
        return await showInviteInfo(client, message, args[1]);
    }

    // Sub-command: server list — show all servers the bot is in
    if (args[0].toLowerCase() === "list") {
        const guilds = client.guilds.cache
            .sort((a, b) => b.memberCount - a.memberCount)
            .map((g, i) => `**${g.name}** — \`${g.id}\` (${g.memberCount} members)`)
            .slice(0, 25);
        
        return message.channel.send(
            `📋 **Servers (${client.guilds.cache.size} total):**\n${guilds.join("\n")}`
            + (client.guilds.cache.size > 25 ? `\n... and ${client.guilds.cache.size - 25} more` : "")
        );
    }

    // Sub-command: server leave <guild_id>
    if (args[0].toLowerCase() === "leave" && args[1]) {
        const guild = client.guilds.cache.get(args[1]);
        if (!guild) return message.channel.send(`❌ Not in a server with ID: \`${args[1]}\``);
        try {
            await guild.leave();
            utils.log(`[SERVER] Left server: ${guild.name}`);
            return message.channel.send(`✅ Left **${guild.name}**`);
        } catch (e) {
            return message.channel.send(`❌ Failed to leave: ${e.message}`);
        }
    }

    const input = args[0].trim();

    // Extract invite code from various Discord invite URL formats
    const inviteRegex = /(?:https?:\/\/)?(?:www\.)?(?:discord\.gg|discord(?:app)?\.com\/invite)\/([a-zA-Z0-9-]+)/i;
    const match = input.match(inviteRegex);
    const inviteCode = match ? match[1] : input;

    utils.log(`[SERVER] Attempting to join server with invite code: ${inviteCode}`);

    try {
        // First, fetch invite info
        const invite = await client.fetchInvite(inviteCode);
        const guildName = invite.guild ? invite.guild.name : "Unknown Server";
        const memberCount = invite.memberCount || "?";

        // Check if already in the server
        if (invite.guild && client.guilds.cache.has(invite.guild.id)) {
            utils.log(`[SERVER] Already a member of: ${guildName}`);
            return message.channel.send(`✅ Already in **${guildName}**!`);
        }

        // Accept the invite
        await client.acceptInvite(inviteCode);
        utils.log(`[SERVER] Successfully joined: ${guildName} (${memberCount} members)`);
        return message.channel.send(`✅ Joined **${guildName}**! (${memberCount} members)`);

    } catch (e) {
        utils.log(`[SERVER] Failed to join: ${e.message}`);

        if (e.message.includes("CAPTCHA")) {
            return message.channel.send(
                "❌ **Discord requires a CAPTCHA to join this server.**\n\n" +
                "🔧 **Workaround:** Join this server manually from your account, then use the bot normally.\n" +
                "💡 Use `server info <invite>` to preview the server details first."
            );
        }

        return message.channel.send(`❌ Failed to join server: ${e.message}`);
    }
};

/**
 * @description Show invite/server info without joining
 */
async function showInviteInfo(client, message, input) {
    const inviteRegex = /(?:https?:\/\/)?(?:www\.)?(?:discord\.gg|discord(?:app)?\.com\/invite)\/([a-zA-Z0-9-]+)/i;
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

        return message.channel.send(info.join("\n"));
    } catch (e) {
        return message.channel.send(`❌ Could not fetch invite info: ${e.message}`);
    }
}

module.exports.names = {
    list: ["server", "joinserver", "invite"]
};
