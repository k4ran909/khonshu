const utils = require('../utils')

module.exports = async (client, message) => {
    // Ignore own messages
    if (message.author.id === client.user.id) return;

    const isDM = !message.guild;
    const botMention = `<@${client.user.id}>`;
    const botMentionNick = `<@!${client.user.id}>`;

    let content;

    if (isDM) {
        // In DMs: no mention needed, just type the command directly
        // Only owner can use
        if (message.author.id !== global.config.owner) return;
        content = message.content.trim();
    } else {
        // In servers: must mention the bot
        if (!message.content.startsWith(botMention) && !message.content.startsWith(botMentionNick)) return;

        // Only the owner can use this bot — silently ignore non-owners so we don't
        // (a) hand attackers a rate-limit / spam vector, and
        // (b) advertise the account as a selfbot every time someone pings it.
        if (message.author.id !== global.config.owner) return;

        // Remove the mention and parse command
        content = message.content.replace(botMention, '').replace(botMentionNick, '').trim();
    }

    if (!content) return;

    const args = content.split(/\s+/g);
    const command = args.shift().toLowerCase();
    const cmd = client.commands.get(command);
    if (!cmd) return;

    // For DMs, attach a helper to find owner's voice channel across guilds
    if (isDM) {
        message._isDM = true;
        message._client = client;
    }

    utils.log(`${message.author.username} ran command: ${command} ${args.join(' ')} ${isDM ? '(via DM)' : ''}`);

    // Await the command and swallow errors here so a bug in one command
    // never becomes an unhandled promise rejection that crashes the process.
    try {
        await cmd.run(client, message, args);
    } catch (e) {
        utils.log(`[CMD ERROR] ${command} threw: ${e && e.stack ? e.stack : e}`);
        try { await message.channel.send(`❌ Command \`${command}\` errored: ${e && e.message ? e.message : e}`); } catch (_) {}
    }
};
