const utils = require("../utils");
const fs = require("fs");
const path = require("path");

const BACKUP_FILE = path.join(__dirname, "..", "profile-backup.json");

// Discord "Bio" and "About Me" are the same single field. The profile endpoint
// returns it under user_profile.bio.
//
// IMPORTANT: selfbots (user accounts) must NOT call GET /users/:id — that route
// is bot-only and returns 401 Unauthorized for user tokens. The user-account-safe
// route is GET /users/:id/profile, which returns the user object *plus* bio and
// banner in one call. We build everything from that response.
function cdnAvatar(id, hash) {
    if (!hash) return null;
    const ext = hash.startsWith("a_") ? "gif" : "png";
    return `https://cdn.discordapp.com/avatars/${id}/${hash}.${ext}?size=1024`;
}
function cdnBanner(id, hash) {
    if (!hash) return null;
    const ext = hash.startsWith("a_") ? "gif" : "png";
    return `https://cdn.discordapp.com/banners/${id}/${hash}.${ext}?size=1024`;
}

async function fetchTargetProfile(client, id) {
    // Hit the profile endpoint directly. with_mutual_guilds helps the request
    // resolve when the relationship is via a shared server.
    const profile = await client.api.users(id).profile.get({
        query: { with_mutual_guilds: true, with_mutual_friends: false }
    });

    const u = (profile && profile.user) || {};
    const up = (profile && profile.user_profile) || {};

    const avatarHash = u.avatar || null;
    const bannerHash = up.banner || u.banner || null;
    const accent = typeof up.accent_color === "number" ? up.accent_color
        : typeof u.accent_color === "number" ? u.accent_color : null;
    const bio = typeof up.bio === "string" ? up.bio
        : typeof u.bio === "string" ? u.bio : null;

    return {
        id: u.id || id,
        username: u.username || "unknown",
        globalName: u.global_name || null,
        avatarURL: cdnAvatar(u.id || id, avatarHash),
        bannerURL: cdnBanner(u.id || id, bannerHash),
        accentColor: accent,
        bio: bio,
        // If we got here the profile was readable (bio/banner are present or empty,
        // not blocked). A 401/403 would have thrown before reaching this point.
        profileReadable: true
    };
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
        // The profile endpoint 401/403s when you have no relationship with the
        // target (no mutual server, not friends, no pending request), and 404s
        // for a nonexistent ID. Translate the raw HTTP error into guidance.
        const code = (e && (e.httpStatus || e.status)) || 0;
        const raw = e && e.message ? e.message : String(e);
        let hint;
        if (code === 404 || /Unknown User/i.test(raw)) {
            hint = "❌ No user exists with that ID. Double-check the ID.";
        } else if (code === 401 || code === 403 || /Unauthorized|Missing Access|403|401/i.test(raw)) {
            hint = "❌ Can't read that user's profile. Discord only allows it when you **share a server with them, are friends, or have a pending friend request**. Join a mutual server (or add them) and try again.";
        } else {
            hint = `❌ Couldn't fetch that user's profile: ${raw}`;
        }
        utils.log(`[CLONE] Profile fetch failed for ${id} (code ${code}): ${raw}`);
        try { await message.channel.send(hint); } catch (_) {}
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
