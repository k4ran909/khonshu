const utils = require("../utils");
const fs = require("fs");
const path = require("path");

const BACKUP_FILE = path.join(__dirname, "..", "profile-backup.json");

// Discord "Bio" and "About Me" are the same single field. The profile endpoint
// returns it under user_profile.bio.
async function fetchTargetProfile(client, id) {
    // Basic user object gives username, global_name, avatar, banner, accent_color.
    const user = await client.users.fetch(id, { force: true });

    const out = {
        id: user.id,
        username: user.username,
        globalName: user.globalName || null,
        avatarURL: user.avatarURL ? user.avatarURL({ format: "png", size: 1024, dynamic: true }) : null,
        bannerURL: null,
        accentColor: typeof user.accentColor === "number" ? user.accentColor : null,
        bio: null,
        profileReadable: false
    };

    // Bio + banner require a profile fetch, which only works with a mutual
    // guild / friendship / pending request. Degrade gracefully if it fails.
    try {
        const profile = await user.getProfile();
        out.profileReadable = true;
        if (profile && profile.user_profile && typeof profile.user_profile.bio === "string") {
            out.bio = profile.user_profile.bio;
        } else if (profile && typeof profile.bio === "string") {
            out.bio = profile.bio;
        }
        // Prefer the banner hash from the profile payload if the basic object lacked one.
        const pUser = profile && profile.user;
        if (pUser && pUser.banner) {
            out.bannerURL = `https://cdn.discordapp.com/banners/${user.id}/${pUser.banner}.${pUser.banner.startsWith("a_") ? "gif" : "png"}?size=1024`;
        }
    } catch (e) {
        utils.log(`[CLONE] Could not read full profile for ${id} (no mutual guild/friend?): ${e && e.message ? e.message : e}`);
    }

    // Fall back to the banner from the basic user object if present.
    if (!out.bannerURL && user.banner) {
        try { out.bannerURL = user.bannerURL({ format: "png", size: 1024, dynamic: true }); } catch (_) {}
    }

    return out;
}

// Snapshot the bot's own current profile so it can be restored later.
async function backupOwnProfile(client) {
    const me = client.user;
    const backup = {
        savedAt: new Date().toISOString(),
        globalName: me.globalName || null,
        bio: null,
        accentColor: typeof me.accentColor === "number" ? me.accentColor : null,
        avatarDataURL: null,
        bannerDataURL: null
    };

    // Read our own bio via profile fetch (self always readable).
    try {
        const profile = await me.getProfile();
        if (profile && profile.user_profile && typeof profile.user_profile.bio === "string") {
            backup.bio = profile.user_profile.bio;
        }
    } catch (_) {}

    // Snapshot images as data URLs — CDN hashes change once we overwrite them.
    try {
        const a = me.avatarURL ? me.avatarURL({ format: "png", size: 1024, dynamic: true }) : null;
        if (a) backup.avatarDataURL = await utils.fetchImageAsDataURL(a);
    } catch (_) {}
    try {
        const b = me.banner ? me.bannerURL({ format: "png", size: 1024, dynamic: true }) : null;
        if (b) backup.bannerDataURL = await utils.fetchImageAsDataURL(b);
    } catch (_) {}

    try {
        fs.writeFileSync(BACKUP_FILE, JSON.stringify(backup, null, 2) + "\n", "utf8");
        return true;
    } catch (e) {
        utils.log(`[CLONE] Failed to write profile-backup.json: ${e && e.message ? e.message : e}`);
        return false;
    }
}

/**
 * @description Clone a Discord user's profile (display name, avatar, banner,
 *   accent color, bio/about) onto this account. Owner-only.
 *   Usage: $clone <userID | @mention>   •   $clone restore
 * @param {Discord.Client} client
 * @param {Discord.Message} message
 * @param {Array<String>} args
 */
module.exports.run = async (client, message, args) => {

    if (message.author.id !== global.config.owner) {
        try { await message.channel.send("❌ Only the bot owner can clone profiles."); } catch (_) {}
        return;
    }

    const first = (args[0] || "").toLowerCase();

    // ─── Restore path ───
    if (first === "restore" || first === "revert" || first === "reset") {
        if (!fs.existsSync(BACKUP_FILE)) {
            try { await message.channel.send("❌ No profile backup found. Nothing to restore."); } catch (_) {}
            return;
        }
        let backup;
        try { backup = JSON.parse(fs.readFileSync(BACKUP_FILE, "utf8")); }
        catch (e) {
            try { await message.channel.send(`❌ Backup file is corrupted: ${e && e.message ? e.message : e}`); } catch (_) {}
            return;
        }

        const restored = [];
        const failed = [];
        try { await client.user.setGlobalName(backup.globalName || ""); restored.push("name"); } catch (e) { failed.push(`name (${e.message})`); }
        try { await client.user.setAboutMe(backup.bio || ""); restored.push("bio"); } catch (e) { failed.push(`bio (${e.message})`); }
        try { await client.user.setAccentColor(backup.accentColor ?? null); restored.push("accent"); } catch (e) { failed.push(`accent (${e.message})`); }
        if (backup.avatarDataURL) { try { await client.user.setAvatar(backup.avatarDataURL); restored.push("avatar"); } catch (e) { failed.push(`avatar (${e.message})`); } }
        if (backup.bannerDataURL) { try { await client.user.setBanner(backup.bannerDataURL); restored.push("banner"); } catch (e) { failed.push(`banner (${e.message})`); } }

        utils.log(`[CLONE] Owner restored profile from backup (${restored.join(", ")})`);
        let msg = `✅ Restored your profile: ${restored.length ? restored.join(", ") : "nothing"}.`;
        if (failed.length) msg += `\n⚠️ Failed: ${failed.join("; ")}`;
        try { await message.channel.send(msg); } catch (_) {}
        return;
    }

    // ─── Clone path ───
    const id = (args[0] || "").replace(/[<@!>]/g, "").trim();
    if (!utils.isSnowflake(id)) {
        try { await message.channel.send("❌ Usage: `$clone <userID | @mention>`  •  `$clone restore` to revert."); } catch (_) {}
        return;
    }

    let target;
    try {
        target = await fetchTargetProfile(client, id);
    } catch (e) {
        try { await message.channel.send(`❌ Couldn't fetch that user: ${e && e.message ? e.message : e}`); } catch (_) {}
        return;
    }

    let status;
    try { status = await message.channel.send(`⏳ Cloning **${target.globalName || target.username}**… backing up your profile first.`); } catch (_) {}

    // Back up our own profile before overwriting (only if no backup exists yet,
    // so repeated clones don't clobber the original with a cloned snapshot).
    if (!fs.existsSync(BACKUP_FILE)) {
        await backupOwnProfile(client);
    }

    const applied = [];
    const skipped = [];
    const failed = [];

    // Name (display name) — always available.
    const name = target.globalName || target.username;
    try { await client.user.setGlobalName(name); applied.push(`name → ${name}`); }
    catch (e) { failed.push(`name (${e.message})`); }

    // Avatar.
    if (target.avatarURL) {
        try { await client.user.setAvatar(target.avatarURL); applied.push("avatar"); }
        catch (e) { failed.push(`avatar (${e.message})`); }
    } else skipped.push("avatar (none)");

    // Bio / About Me.
    if (typeof target.bio === "string" && target.bio.length) {
        try { await client.user.setAboutMe(target.bio); applied.push("bio"); }
        catch (e) { failed.push(`bio (${e.message})`); }
    } else {
        skipped.push(target.profileReadable ? "bio (empty)" : "bio (not readable — need mutual server/friend)");
    }

    // Banner.
    if (target.bannerURL) {
        try { await client.user.setBanner(target.bannerURL); applied.push("banner"); }
        catch (e) { failed.push(`banner (${e.message})`); }
    } else skipped.push(target.profileReadable ? "banner (none)" : "banner (not readable)");

    // Accent color.
    if (typeof target.accentColor === "number") {
        try { await client.user.setAccentColor(target.accentColor); applied.push("accent color"); }
        catch (e) { failed.push(`accent (${e.message})`); }
    } else skipped.push("accent color (none)");

    utils.log(`[CLONE] Owner cloned ${id} — applied: ${applied.join(", ")}`);

    const lines = [`✅ Cloned **${name}** (\`${id}\`)`];
    if (applied.length) lines.push(`• Applied: ${applied.join(", ")}`);
    if (skipped.length) lines.push(`• Skipped: ${skipped.join(", ")}`);
    if (failed.length) lines.push(`• ⚠️ Failed: ${failed.join("; ")}`);
    lines.push(`_Run \`${global.config.prefix || "$"}clone restore\` to revert to your original profile._`);

    const content = lines.join("\n");
    try {
        if (status && status.edit) await status.edit({ content, allowedMentions: { parse: [] } });
        else await message.channel.send({ content, allowedMentions: { parse: [] } });
    } catch (_) {}
};

module.exports.names = {
    list: ["clone"]
};
