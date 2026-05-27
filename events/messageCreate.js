const strings = require('../strings.json')
const utils = require('../utils')

module.exports = (client, message) => {
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

        // Only the owner can use this bot
        if (message.author.id !== global.config.owner) {
            return message.channel.send(strings.permissionDenied);
        }

        // Remove the mention and parse command
        content = message.content.replace(botMention, '').replace(botMentionNick, '').trim();
    }

    if (!content) return;

    const args = content.split(/ +/g);
    const command = args.shift().toLowerCase();
    const cmd = client.commands.get(command);
    if (!cmd) return;

    // For DMs, attach a helper to find owner's voice channel across guilds
    if (isDM) {
        message._isDM = true;
        message._client = client;
    }

    utils.log(`${message.author.username} ran command: ${command} ${args.join(' ')} ${isDM ? '(via DM)' : ''}`);
    cmd.run(client, message, args);
};