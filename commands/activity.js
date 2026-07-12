const utils = require("../utils");

// Map a leading keyword to a Discord activity type. If the first word isn't one
// of these, we default to PLAYING and treat the whole input as the name — so
// `$activity Genshin Impact` just works.
const TYPE_MAP = {
    playing: "PLAYING", play: "PLAYING",
    watching: "WATCHING", watch: "WATCHING",
    listening: "LISTENING", listen: "LISTENING",
    competing: "COMPETING", compete: "COMPETING",
    streaming: "STREAMING", stream: "STREAMING",
    custom: "CUSTOM"
};

// Words that clear the activity.
const CLEAR_WORDS = new Set(["clear", "off", "none", "remove", "reset", "stop"]);

// A default stream URL so STREAMING activities render with the purple marker.
const DEFAULT_STREAM_URL = "https://www.twitch.tv/discord";

/**
 * @description Set the bot's activity. Owner-only.
 *   $activity Genshin Impact            → Playing Genshin Impact
 *   $activity playing GTA-V             → Playing GTA-V
 *   $activity watching a movie          → Watching a movie
 *   $activity listening Spotify         → Listening to Spotify
 *   $activity competing a tournament    → Competing in a tournament
 *   $activity streaming just chatting   → Streaming just chatting (purple)
 *   $activity custom just vibing        → custom status (no verb prefix)
 *   $activity clear                     → remove the activity
 * @param {Discord.Client} client
 * @param {Discord.Message} message
 * @param {Array<String>} args
 */
module.exports.run = async (client, message, args) => {

    if (message.author.id !== global.config.owner) {
        try { await message.channel.send("❌ Only the bot owner can change the activity."); } catch (_) {}
        return;
    }

    if (args.length === 0) {
        try {
            await message.channel.send(
                "❌ Usage: `$activity [type] <text>`\n" +
                "Types: `playing` (default), `watching`, `listening`, `competing`, `streaming`, `custom`\n" +
                "Examples: `$activity Genshin Impact` • `$activity watching a movie` • `$activity clear`"
            );
        } catch (_) {}
        return;
    }

    // Clear the activity but keep the current status.
    if (args.length === 1 && CLEAR_WORDS.has(args[0].toLowerCase())) {
        try {
            client.user.setActivity(null);
        } catch (e) {
            try { await message.channel.send(`❌ Failed to clear activity: ${e && e.message ? e.message : e}`); } catch (_) {}
            return;
        }
        const cur = utils.loadPresence() || {};
        delete cur.activity;
        utils.savePresence(cur);
        utils.log("[PRESENCE] Owner cleared activity");
        try { await message.channel.send("✅ Activity cleared."); } catch (_) {}
        return;
    }

    // Resolve the type: first word if it's a known keyword, otherwise PLAYING.
    let type = "PLAYING";
    let words = args.slice();
    const maybeType = args[0].toLowerCase();
    if (TYPE_MAP[maybeType]) {
        type = TYPE_MAP[maybeType];
        words = args.slice(1);
    }

    const name = words.join(" ").trim();
    if (!name) {
        try { await message.channel.send("❌ You need to provide the activity text, e.g. `$activity playing Genshin Impact`."); } catch (_) {}
        return;
    }

    const options = { type };
    if (type === "STREAMING") options.url = DEFAULT_STREAM_URL;

    try {
        client.user.setActivity(name, options);
    } catch (e) {
        try { await message.channel.send(`❌ Failed to set activity: ${e && e.message ? e.message : e}`); } catch (_) {}
        return;
    }

    // Persist alongside the current status.
    const cur = utils.loadPresence() || {};
    cur.activity = { type, name };
    if (options.url) cur.activity.url = options.url;
    const saved = utils.savePresence(cur);

    utils.log(`[PRESENCE] Owner set activity: ${type} ${name}`);

    // Human-readable preview matching how Discord renders each type.
    const VERB = { PLAYING: "Playing", WATCHING: "Watching", LISTENING: "Listening to", COMPETING: "Competing in", STREAMING: "Streaming" };
    const preview = type === "CUSTOM" ? name : `${VERB[type] || "Playing"} ${name}`;
    const note = saved ? "" : "\n⚠️ Applied now but couldn't be saved — it will reset on restart.";
    try {
        await message.channel.send({ content: `✅ Activity set: **${preview}**${note}`, allowedMentions: { parse: [] } });
    } catch (_) {}
};

module.exports.names = {
    list: ["activity", "act", "playing"]
};
