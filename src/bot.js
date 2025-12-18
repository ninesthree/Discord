import 'dotenv/config';
import fetch from 'node-fetch';
import {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  EmbedBuilder,
  ChannelType,
} from 'discord.js';
import { REST, Routes, SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';

// ---- Env & defaults ----
const BOT_TOKEN = process.env.BOT_TOKEN;
const ALLOW_MESSAGE_CONTENT = String(process.env.ALLOW_MESSAGE_CONTENT || 'true').toLowerCase() === 'true';
const OWNER_STARTUP_DM = String(process.env.OWNER_STARTUP_DM || 'false').toLowerCase() === 'true';
const OWNER_ID = process.env.OWNER_ID ? String(process.env.OWNER_ID) : null;
let ANNOUNCE_CHANNEL_ID = process.env.ANNOUNCE_CHANNEL_ID ? String(process.env.ANNOUNCE_CHANNEL_ID) : null;
const POLL_INTERVAL = Number(process.env.POLL_INTERVAL || 10);
const STAFF_ROLE_ID = process.env.STAFF_ROLE_ID ? String(process.env.STAFF_ROLE_ID) : null;
let TICKETS_CATEGORY_ID = process.env.TICKETS_CATEGORY_ID ? String(process.env.TICKETS_CATEGORY_ID) : null;
const DEV_ROLE_ID = process.env.DEV_ROLE_ID ? String(process.env.DEV_ROLE_ID) : '1451301740652789934';
const MOD_ROLE_ID = process.env.MOD_ROLE_ID ? String(process.env.MOD_ROLE_ID) : '1405004910499463266';
const GITHUB_ISSUES_URL = process.env.GITHUB_ISSUES_URL ? String(process.env.GITHUB_ISSUES_URL) : 'https://github.com/ninesthree/Discord/issues';

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const CLAIMS_TABLE = 'user_key_claims';
const KEYS_TABLE = 'user_keys';

const FEED_URL = process.env.FEED_URL || 'http://localhost:3000/api/bot/claim-feed';
const MARK_URL = process.env.MARK_URL || 'http://localhost:3000/api/bot/claim-feed/mark';
const ACTIVATE_VALIDATE_URL = process.env.ACTIVATE_VALIDATE_URL || 'http://localhost:3000/api/plugins/activate/validate';

if (!BOT_TOKEN) {
  console.error('Missing BOT_TOKEN in .env');
  process.exit(1);
}

// ---- Discord client ----
const intents = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.GuildMessageReactions,
  GatewayIntentBits.DirectMessages,
];
if (ALLOW_MESSAGE_CONTENT) intents.push(GatewayIntentBits.MessageContent);

const client = new Client({
  intents,
  partials: [Partials.Channel, Partials.Message, Partials.Reaction],
});

// ---- Utils ----
function headersJSON(key) {
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Prefer: 'return=representation',
  };
}

function headersCount(key) {
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Prefer: 'count=exact',
  };
}

function mask(token, showLast = 4) {
  const s = String(token || '');
  if (!s) return s;
  if (s.length <= showLast) return '•'.repeat(Math.max(0, showLast - s.length)) + s;
  return '•'.repeat(s.length - showLast) + s.slice(-showLast);
}

// Check Supabase user_keys for a key linked to a given Discord ID
async function validateKeyLinkedToDiscord(rawKey, discordId) {
  try {
    // Prefer website endpoint for validation to centralize logic and RLS
    if (ACTIVATE_VALIDATE_URL) {
      try {
        const res = await fetch(ACTIVATE_VALIDATE_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key: rawKey, discordId }),
        });
        if (res.ok) {
          const data = await res.json();
          return data.ok ? { ok: true, row: data.row } : { ok: false, reason: data.reason || 'not_linked' };
        }
      } catch {}
    }
    // Fallback: direct Supabase check
    const base = (SUPABASE_URL || '').replace(/\/$/, '');
    const serviceKey = SUPABASE_SERVICE_ROLE_KEY;
    if (!base || !serviceKey) return { ok: false, reason: 'service_key_missing' };
    const url = `${base}/rest/v1/${KEYS_TABLE}?select=key_id,raw_token,token,key,discord_id,user_id,status,expires_at&or=(raw_token.eq.${encodeURIComponent(rawKey)},token.eq.${encodeURIComponent(rawKey)},key.eq.${encodeURIComponent(rawKey)})&discord_id.eq.${encodeURIComponent(discordId)}&limit=1`;
    const res = await fetch(url, { headers: headersJSON(serviceKey), cache: 'no-store' });
    if (!res.ok) return { ok: false, reason: `http_${res.status}` };
    const rows = await res.json();
    const row = Array.isArray(rows) ? rows[0] : rows;
    if (!row) return { ok: false, reason: 'not_linked' };
    const status = String(row.status || '').toLowerCase();
    if (status === 'revoked') return { ok: false, reason: 'revoked' };
    if (row.expires_at) {
      const exp = new Date(row.expires_at);
      if (!isNaN(exp) && exp < new Date()) return { ok: false, reason: 'expired' };
    }
    return { ok: true, row };
  } catch (e) {
    return { ok: false, reason: 'exception', error: e?.message || String(e) };
  }
}

function buildDmEmbedExact(token) {
  return new EmbedBuilder()
    .setTitle('RadiantArchive')
    .setDescription(`M2M × VoID\n\n${token}\nDont share \"Ra-Beta\" key with anyone this will lead to a BAN\n\nThanks again from the radiant team for helping with the beta`)
    .setColor(0xF59E0B);
}

function buildChannelEmbedClaim({ keyId, userId, token, discordId, createdAt }) {
  const mention = discordId ? `<@${discordId}>` : null;
  const embed = new EmbedBuilder()
    .setTitle('Key Claimed')
    .setDescription(`${mention ? `${mention} ` : ''}claimed a beta key.`)
    .setColor(0xF59E0B);
  if (keyId) embed.addFields({ name: 'Key ID', value: String(keyId), inline: true });
  if (userId) embed.addFields({ name: 'User ID', value: String(userId), inline: true });
  if (token) embed.addFields({ name: 'Token', value: `\`${mask(token)}\``, inline: false });
  embed.addFields({ name: 'Issued At', value: createdAt || new Date().toISOString(), inline: true });
  return embed;
}

// ---- Data helpers ----
async function fetchAuthUser(userId) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return null;
  try {
    const res = await fetch(`${SUPABASE_URL.replace(/\/$/, '')}/auth/v1/admin/users/${userId}`, {
      headers: headersJSON(SUPABASE_SERVICE_ROLE_KEY),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function extractDiscordId(authUser) {
  try {
    const meta = (authUser?.user_metadata) || {};
    const sub = String(meta?.sub || '');
    if (/^\d{15,20}$/.test(sub)) return Number(sub);
    for (const ident of authUser?.identities || []) {
      if (ident?.provider === 'discord') {
        const data = ident?.identity_data || {};
        const val = String(data?.sub || data?.user_id || '');
        if (/^\d{15,20}$/.test(val)) return Number(val);
      }
    }
  } catch {}
  return null;
}

async function fetchClaimsList() {
  // Prefer processed=false or NULL; fallback to latest 50
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return [];
  const base = SUPABASE_URL.replace(/\/$/, '');
  const urls = [
    `${base}/rest/v1/${CLAIMS_TABLE}?select=id,claim_id,user_id,discord_id,raw_token,created_at,claimed_at,processed&or=(processed.is.false,processed.is.null)&order=created_at.desc&limit=50`,
    `${base}/rest/v1/${CLAIMS_TABLE}?select=id,claim_id,user_id,discord_id,raw_token,created_at,claimed_at&order=created_at.desc&limit=50`,
  ];
  for (const url of urls) {
    try {
      const resp = await fetch(url, { headers: headersJSON(SUPABASE_SERVICE_ROLE_KEY) });
      if (!resp.ok) continue;
      const data = await resp.json();
      const arr = Array.isArray(data) ? data : [];
      console.log(`[supabase] fetched ${arr.length} claims from`, url.includes('processed') ? 'unprocessed query' : 'latest query');
      return arr;
    } catch {}
  }
  return [];
}

async function updateRowStatus(rowId, status = '', note = '') {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return;
  try {
    const base = SUPABASE_URL.replace(/\/$/, '');
    const url = `${base}/rest/v1/${CLAIMS_TABLE}?or=(id.eq.${rowId},claim_id.eq.${rowId})`;
    await fetch(url, {
      method: 'PATCH',
      headers: headersJSON(SUPABASE_SERVICE_ROLE_KEY),
      body: JSON.stringify({ processed: true, status, note }),
    });
  } catch {}
}

async function fetchFeed() {
  if (!FEED_URL) return null;
  try {
    const resp = await fetch(FEED_URL, { headers: { Accept: 'application/json' } });
    if (!resp.ok) return null;
    const json = await resp.json();
    const n = Array.isArray(json?.items) ? json.items.length : 0;
    console.log(`[feed] fetched ${n} items`);
    return json;
  } catch {
    return null;
  }
}

async function markViaFeed(rowId, status = 'announced', note = 'sent') {
  if (!MARK_URL) return;
  try {
    await fetch(MARK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ id: rowId, status, note }),
    });
  } catch {}
}

// ---- Core behaviors ----
const lastSeen = new Set();

async function sendClaimantDm(discordId, token) {
  try {
    const user = await client.users.fetch(String(discordId));
    if (!user) return false;
    const embed = buildDmEmbedExact(token);
    await user.send({ embeds: [embed] });
    console.log(`[dm] sent to ${discordId}`);
    return true;
  } catch {
    console.warn(`[dm] failed to ${discordId}`);
    return false;
  }
}

async function announceToChannel({ keyId, userId, token, discordId, createdAt }) {
  try {
    if (!ANNOUNCE_CHANNEL_ID) return false;
    const channel = await client.channels.fetch(ANNOUNCE_CHANNEL_ID);
    if (!channel) return false;
    const embed = buildChannelEmbedClaim({ keyId, userId, token, discordId, createdAt });
    await channel.send({ embeds: [embed] });
    console.log(`[announce] key ${keyId} user ${userId} discord ${discordId || 'n/a'}`);
    return true;
  } catch {
    return false;
  }
}

async function processClaimRow(row) {
  const rowId = row.claim_id || row.id;
  if (lastSeen.has(rowId)) return;
  lastSeen.add(rowId);

  const userId = row.user_id;
  const token = row.raw_token || '';
  const createdAt = row.created_at || new Date().toISOString();

  // Prefer discord_id from row; fallback to Auth Admin
  let discordId = null;
  if (row.discord_id) {
    try { discordId = Number(row.discord_id); } catch {}
  }
  if (!discordId) {
    const auth = await fetchAuthUser(userId);
    discordId = extractDiscordId(auth) || null;
  }

  // Announce-first (channel)
  const announced = await announceToChannel({ keyId: rowId, userId, token, discordId, createdAt });
  // DM claimant when possible
  if (discordId) {
    const sent = await sendClaimantDm(discordId, token);
    await updateRowStatus(rowId, sent ? 'dm_sent' : 'announced', sent ? 'sent' : 'dm_failed');
  } else {
    await updateRowStatus(rowId, 'announced', 'no discord id; announced only');
  }
}

async function pollOnceSupabase() {
  const items = await fetchClaimsList();
  if (!items?.length) {
    console.log('[supabase] no claims fetched');
  }
  for (const row of items) {
    // If processed is true, skip
    if (row.processed) continue;
    await processClaimRow(row);
  }
}

async function pollOnceFeed() {
  const data = await fetchFeed();
  if (!data) {
    console.log('[feed] unavailable');
  }
  const items = (data?.items) || [];
  for (const row of items) {
    const rowId = row.claim_id || row.id;
    if (lastSeen.has(rowId)) continue;
    lastSeen.add(rowId);
    const token = row.raw_token || '';
    const createdAt = row.created_at || new Date().toISOString();
    const discordId = row.discord_id || null;
    await announceToChannel({ keyId: rowId, userId: row.user_id, token, discordId, createdAt });
    if (discordId) {
      await sendClaimantDm(discordId, token);
    }
    await markViaFeed(rowId, 'announced', 'sent');
  }
}

async function runLoop() {
  // Supabase every cycle; feed also if reachable
  await pollOnceSupabase();
  await pollOnceFeed();
}

// ---- Owner/interactive menu ----
// ---- Help embed ----
function buildHelpEmbed() {
  return new EmbedBuilder()
    .setTitle('Help')
    .setDescription('Available commands for all users')
    .addFields(
      { name: '/help', value: 'Show this help', inline: false },
        { name: '/activate', value: 'Activate beta key for our plugins', inline: false },
        { name: '/reset', value: 'Reset your key for our plugins', inline: false },
        { name: '/ticket open', value: 'Create a support ticket', inline: false },
      { name: '/ticket close', value: 'Close the current ticket channel', inline: false },
    )
    .setColor(0x5865F2)
    .setFooter({ text: 'Radiant Archive' });
}

// Track menu messages for reaction handling
const MENU_MESSAGE_IDS = new Set();

// ---- Message triggers ----
// Disable legacy text triggers/menu; use slash commands only

client.once(Events.ClientReady, async () => {
  console.log(`Logged in as ${client.user.tag}`);
  // Ensure visible online presence
  try {
    await client.user.setPresence({ status: 'online', activities: [{ name: 'Radiant Archive', type: 0 }] });
  } catch {}
  // Register global slash commands for DM-safe operations (no Message Content intent needed)
  try {
    const commands = [
      new SlashCommandBuilder().setName('status').setDescription('Show helper status').setDMPermission(true),
      new SlashCommandBuilder().setName('help').setDescription('Show available user commands').setDMPermission(true),
      new SlashCommandBuilder().setName('menu').setDescription('Show help menu').setDMPermission(true),
      new SlashCommandBuilder()
        .setName('announce')
        .setDescription('Set announce channel (owner only)')
        .addStringOption(opt => opt.setName('channel_id').setDescription('Channel ID').setRequired(true)),
      new SlashCommandBuilder()
        .setName('clear')
        .setDescription('Clear recent messages in this channel (best-effort)')
        .addIntegerOption(opt => opt.setName('count').setDescription('How many (default 100, max 1000)').setRequired(false)),
      new SlashCommandBuilder()
        .setName('clear-dm')
        .setDescription('Delete recent bot messages in this DM')
        .setDMPermission(true)
        .addIntegerOption(opt => opt.setName('count').setDescription('How many (max 100)').setRequired(false)),
      new SlashCommandBuilder()
        .setName('activate')
        .setDescription('Activate your plugin (M2M or VoID) with your key')
        .setDMPermission(true)
        .addStringOption(o => o
          .setName('plugin')
          .setDescription('Plugin to activate')
          .addChoices(
            { name: 'M2M', value: 'M2M' },
            { name: 'VoID', value: 'VoID' },
          )
          .setRequired(true)
        )
        .addStringOption(o => o
          .setName('key')
          .setDescription('Your activation key (e.g., RA-BETA-0000-0000)')
          .setRequired(true)
        ),
      new SlashCommandBuilder()
        .setName('reset')
        .setDescription('Request a simple reset ack or clear bot messages (best-effort)')
        .setDMPermission(true),
      new SlashCommandBuilder()
        .setName('ticket')
        .setDescription('Ticket operations')
        .addSubcommand(sc => sc
          .setName('open')
          .setDescription('Open a private ticket channel with an issue statement and message')
          .addStringOption(o => o
            .setName('issue')
            .setDescription('Issue statement')
            .addChoices(
              { name: 'Support', value: 'Support' },
              { name: 'Key', value: 'Key' },
              { name: 'Bug', value: 'Bug' },
            )
            .setRequired(true)
          )
          .addStringOption(o => o
            .setName('message')
            .setDescription('Describe your issue')
            .setRequired(true)
          )
        )
        .addSubcommand(sc => sc
          .setName('close')
          .setDescription('Close the current ticket channel')
        ),
      new SlashCommandBuilder()
        .setName('issue')
        .setDescription('Report an issue and open a ticket')
        .addSubcommand(sc => sc
          .setName('report')
          .setDescription('Report an issue and open a ticket')
          .addStringOption(o => o.setName('text').setDescription('Your issue').setRequired(true))
        )
        .addSubcommand(sc => sc
          .setName('open')
          .setDescription('Open a ticket for a user (staff)')
          .addUserOption(o => o.setName('user').setDescription('User to open ticket for').setRequired(true))
          .addStringOption(o => o.setName('subject').setDescription('Subject').setRequired(false))
        ),
    ].map(c => c.toJSON());

    const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);
    const appId = client.application.id;
    await rest.put(Routes.applicationCommands(appId), { body: commands });
    console.log('[commands] registered (global)');
    // Also register per-guild to force immediate schema update in the server
    for (const [gid] of client.guilds.cache) {
      try {
        await rest.put(Routes.applicationGuildCommands(appId, gid), { body: commands });
        console.log(`[commands] registered (guild ${gid})`);
      } catch (e) {
        console.warn(`[commands] guild register failed ${gid}`, e?.status || e?.message || e);
      }
    }
  } catch (e) {
    console.warn('[commands] register failed', e?.status || e?.message || e);
  }
  // Optional: owner startup DM (single minimal embed). Menu is NOT sent on startup.
  if (OWNER_STARTUP_DM) {
    try {
      if (OWNER_ID) {
        const owner = await client.users.fetch(OWNER_ID);
        const summary = new EmbedBuilder()
          .setTitle('{ Dev Build }')
          .setDescription('Status : Started')
          .setColor(0x2f3136);
        await owner.send({ embeds: [summary] });
      }
    } catch {}
  }

  // Start polling loop
  setInterval(async () => {
    try {
      await runLoop();
    } catch (e) {
      console.warn('poll error', e);
    }
  }, Math.max(5, POLL_INTERVAL) * 1000);
});

// Interactions (slash commands & buttons)
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      const name = interaction.commandName;
      if (name === 'status') {
        const text = `Announce: ${ANNOUNCE_CHANNEL_ID ? `set (${ANNOUNCE_CHANNEL_ID})` : 'unset'} | Interval: ${POLL_INTERVAL}s | Feed: ${FEED_URL ? 'on' : 'off'} | Supabase: ${SUPABASE_URL ? 'on' : 'off'}`;
        await interaction.reply({ content: text, ephemeral: false });
        return;
      }
      if (name === 'help') {
        const embed = buildHelpEmbed();
        await interaction.reply({ embeds: [embed], ephemeral: false });
        return;
      }
      if (name === 'menu') {
        const embed = buildHelpEmbed();
        await interaction.reply({ embeds: [embed], ephemeral: false, fetchReply: true });
        const msg = await interaction.fetchReply();
        try { await msg.react('🌐'); MENU_MESSAGE_IDS.add(msg.id); } catch {}
        return;
      }
      if (name === 'announce') {
        const isOwner = OWNER_ID && String(interaction.user.id) === OWNER_ID;
        if (!isOwner) { await interaction.reply({ content: 'Owner only.', ephemeral: true }); return; }
        const cid = interaction.options.getString('channel_id', true).replace(/[^0-9]/g, '');
        ANNOUNCE_CHANNEL_ID = cid;
        await interaction.reply({ content: `Announce channel set to ${cid}.`, ephemeral: false });
        return;
      }
      if (name === 'clear') {
        const channel = interaction.channel;
        const isDM = channel?.isDMBased?.() || channel?.type === 1;
        let remain = Math.min(Math.max(interaction.options.getInteger('count') ?? 100, 1), 1000);
        await interaction.reply({ content: `Clearing up to ${remain} message(s)...`, ephemeral: false });
        let deleted = 0;
        try {
          if (isDM) {
            // In DMs, bots can only delete their own messages
            while (remain > 0) {
              const fetchCount = Math.min(100, remain);
              const messages = await channel.messages.fetch({ limit: fetchCount });
              if (!messages?.size) break;
              for (const msg of messages.values()) {
                if (remain <= 0) break;
                if (msg.author?.id === client.user.id) {
                  try { await msg.delete(); deleted++; } catch {}
                }
                remain--;
              }
              if (messages.size < fetchCount) break;
            }
          } else {
            // Guild channel: try bulk delete first (limited to <14 days)
            const me = interaction.guild?.members?.me;
            const canManage = me && channel && me.permissionsIn(channel).has(PermissionFlagsBits.ManageMessages);
            if (canManage && channel?.bulkDelete) {
              while (remain > 0) {
                const batch = Math.min(100, remain);
                try {
                  const col = await channel.bulkDelete(batch, true);
                  const n = col?.size ?? 0;
                  deleted += n;
                  remain -= batch;
                  if (n === 0) break; // likely older than 14 days; fall back
                } catch {
                  break;
                }
              }
            }
            // Fallback: delete bot's own messages individually (no special perms)
            while (remain > 0) {
              const fetchCount = Math.min(100, remain);
              const messages = await channel.messages.fetch({ limit: fetchCount });
              if (!messages?.size) break;
              let any = false;
              for (const msg of messages.values()) {
                if (remain <= 0) break;
                if (msg.author?.id === client.user.id) {
                  try { await msg.delete(); deleted++; any = true; } catch {}
                }
                remain--;
              }
              if (!any) break;
            }
          }
        } catch {}
        try {
          const doneMsg = await channel.send(`Done. Deleted ${deleted} message(s).`);
          // Auto-delete the confirmation after 2 seconds so /clear leaves no residual messages
          setTimeout(async () => { try { await doneMsg.delete(); } catch {} }, 2_000);
        } catch {}
        return;
      }
      if (name === 'clear-dm') {
        const channel = interaction.channel;
        if (!channel?.isDMBased?.() && channel?.type !== 1) { // 1 = DM
          await interaction.reply({ content: 'Use this in a DM with me.', ephemeral: true });
          return;
        }
        const count = Math.min(Math.max(interaction.options.getInteger('count') ?? 25, 1), 100);
        await interaction.reply({ content: `Clearing up to ${count} of my recent messages...`, ephemeral: false });
        let deleted = 0;
        try {
          const messages = await channel.messages.fetch({ limit: 100 });
          for (const msg of messages.values()) {
            if (deleted >= count) break;
            if (msg.author?.id === client.user.id) {
              try { await msg.delete(); deleted++; } catch {}
            }
          }
        } catch {}
        try {
          const doneMsg = await channel.send(`Done. Deleted ${deleted} message(s).`);
          // Auto-delete the confirmation after 2 seconds for a clean DM
          setTimeout(async () => { try { await doneMsg.delete(); } catch {} }, 2_000);
        } catch {}
        return;
      }
      if (name === 'activate') {
        const plugin = interaction.options.getString('plugin', true);
        const rawKey = interaction.options.getString('key', true);
        const masked = mask(rawKey, 4);
        const user = interaction.user;
        // Basic format check and Supabase validation
        const formatValid = /^RA-[A-Z]+-[0-9A-Z-]+$/i.test(rawKey) || /^RA-BETA-[0-9-]+$/i.test(rawKey);
        // Check if key is linked to this Discord user in Supabase
        const linked = await validateKeyLinkedToDiscord(rawKey, user.id);
        const statusColor = linked.ok && formatValid ? 0x22c55e : 0xF59E0B;
        const reasonText = linked.ok
          ? 'Key link verified.'
          : linked.reason === 'not_linked'
            ? 'This key is not linked to your Discord ID. Activation cannot proceed.'
            : linked.reason === 'revoked'
              ? 'This key is revoked.'
              : linked.reason === 'expired'
                ? 'This key is expired.'
                : linked.reason === 'service_key_missing'
                  ? 'Server configuration missing for Supabase validation.'
                  : 'Could not validate the key link right now.';
        const ack = new EmbedBuilder()
          .setTitle('Activation Requested')
          .setDescription(`Plugin: **${plugin}**\nKey: ${masked}\nUser: <@${user.id}>\n\n${reasonText}\nIf this was a mistake, open a ticket with /ticket open.`)
          .setColor(statusColor);
        try {
          await interaction.reply({ embeds: [ack], ephemeral: true });
        } catch {
          await interaction.reply({ content: `Activation requested for ${plugin}. Key: ${masked} — ${reasonText}`, ephemeral: true }).catch(() => {});
        }
        // Reject if not linked; do not proceed to staff log when unlinked
        if (!linked.ok) { return; }
        // Staff log when linked OK
        if (ANNOUNCE_CHANNEL_ID) {
          try {
            const chan = await client.channels.fetch(ANNOUNCE_CHANNEL_ID);
            if (chan && chan.type === ChannelType.GuildText) {
              const staff = new EmbedBuilder()
                .setTitle('Activation Request')
                .setDescription(`Plugin: **${plugin}**\nKey: ${masked}\nUser: <@${user.id}>\nValidation: ${linked.ok ? 'linked' : linked.reason || 'unknown'}`)
                .setColor(0x5865F2);
              await chan.send({ embeds: [staff] });
            }
          } catch {}
        }
        return;
      }
      if (name === 'reset') {
        // Simple ack; users can use /clear or /clear-dm for cleanup
        await interaction.reply({ content: 'Reset acknowledged. If this is about a problem, please use /issue report to describe it.', ephemeral: true });
        return;
      }
      if (name === 'ticket') {
        const sub = interaction.options.getSubcommand();
        if (sub === 'open') {
          const issue = interaction.options.getString('issue', true);
          const userMessage = interaction.options.getString('message', true);
          const guild = interaction.guild;
          if (!guild) { await interaction.reply({ content: 'Use this in a server.', ephemeral: true }); return; }
          const me = guild.members.me;
          if (!me) { await interaction.reply({ content: 'Bot missing guild context.', ephemeral: true }); return; }
          // Brief delay and cache refresh to avoid race with other instances
          try { await new Promise(r => setTimeout(r, 400)); await guild.channels.fetch(); } catch {}
          // Ensure tickets category exists
          let cat = TICKETS_CATEGORY_ID ? await guild.channels.fetch(TICKETS_CATEGORY_ID).catch(() => null) : null;
          if (!cat || cat?.type !== ChannelType.GuildCategory) {
            cat = guild.channels.cache.find(c => c.type === ChannelType.GuildCategory && /tickets?/i.test(c.name));
          }
          if (!cat) {
            try {
              cat = await guild.channels.create({ name: 'tickets', type: ChannelType.GuildCategory });
              TICKETS_CATEGORY_ID = cat.id;
            } catch {}
          }
          if (!cat) { await interaction.reply({ content: 'Could not prepare ticket category.', ephemeral: true }); return; }
          const user = interaction.user;
          // Compute next ticket number based on channels count under the ticket category
          const existingTickets = guild.channels.cache.filter(ch => ch.parentId === cat.id && ch.type === ChannelType.GuildText);
          const nextNumber = String(existingTickets.size + 1).padStart(4, '0');
          let nameCandidate = `ticket-${nextNumber}`;
          // Ensure uniqueness if a race occurs
          let guard = 0;
          while (guild.channels.cache.some(ch => ch.name === nameCandidate && ch.parentId === cat.id) && guard < 5) {
            const bump = String(existingTickets.size + 1 + guard + 1).padStart(4, '0');
            nameCandidate = `ticket-${bump}`;
            guard++;
          }
          const overwrites = [
            { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
            { id: user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
          ];
          if (STAFF_ROLE_ID) {
            overwrites.push({ id: STAFF_ROLE_ID, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] });
          }
          // Always allow Dev/Mod roles access
          overwrites.push({ id: DEV_ROLE_ID, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] });
          overwrites.push({ id: MOD_ROLE_ID, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] });
          let chan;
          try {
            chan = await guild.channels.create({
              name: nameCandidate,
              type: ChannelType.GuildText,
              parent: cat.id,
              permissionOverwrites: overwrites,
              reason: `Ticket for ${user.tag}`,
            });
          } catch (e) {
            await interaction.reply({ content: 'Failed to create ticket channel.', ephemeral: true });
            return;
          }
          const intro = new EmbedBuilder()
            .setTitle(`Ticket #${nextNumber}`)
            .setDescription((() => {
              const devmod = `<@&${DEV_ROLE_ID}> & <@&${MOD_ROLE_ID}>`;
              const mention = `<@${user.id}>`;
              const msg = `${userMessage}`;
              if (issue === 'Support') {
                return `${devmod} , Support , ${mention} Need support?\n\n${msg}\n\nPlease wait while we get to you as soon as possible.`;
              }
              if (issue === 'Bug') {
                return `${devmod} , Bug , ${mention} Thanks reporting a issue during the beta\n\n${msg}\n\nPlease wait while we get to you as soon as possible, remember you can report bugs via Github too\nLink = ${GITHUB_ISSUES_URL}`;
              }
              if (issue === 'Key') {
                return `${devmod} , Key , ${mention} Having issues with the claimed key?\n\n${msg}\n\nPlease wait while we get to you`;
              }
              // Fallback
              return `${devmod} , ${issue} , ${mention}\n\n${msg}\n\nPlease wait while we get to you as soon as possible.`;
            })())
            .setColor(0xF59E0B);
          try { await chan.send({ embeds: [intro] }); } catch {}
          await interaction.reply({ content: `Ticket created: <#${chan.id}>`, ephemeral: true });
          return;
        }
        if (sub === 'close') {
          const channel = interaction.channel;
          const guild = interaction.guild;
          if (!guild || !channel || channel.type !== ChannelType.GuildText) { await interaction.reply({ content: 'Use in a ticket text channel.', ephemeral: true }); return; }
          // Basic close: remove send perms for requester
          const requesterId = interaction.user.id;
          try {
            await channel.permissionOverwrites.edit(requesterId, { SendMessages: false });
          } catch {}
          const closed = new EmbedBuilder().setTitle('Ticket Closed').setDescription('This ticket has been closed.').setColor(0x2f3136);
          try { await channel.send({ embeds: [closed] }); } catch {}
          await interaction.reply({ content: 'Ticket closed.', ephemeral: true });
          return;
        }
      }
      if (name === 'issue') {
        const sub = interaction.options.getSubcommand();
        if (sub === 'report') {
          const text = interaction.options.getString('text', true);
          // Reuse ticket open flow
          interaction.options._hoistedOptions = []; // ensure no leftover options
          // Call through: we can't easily call our handler; recreate minimal flow
          const guild = interaction.guild;
          if (!guild) { await interaction.reply({ content: 'Use this in a server.', ephemeral: true }); return; }
          try { await new Promise(r => setTimeout(r, 400)); await guild.channels.fetch(); } catch {}
          let cat = TICKETS_CATEGORY_ID ? await guild.channels.fetch(TICKETS_CATEGORY_ID).catch(() => null) : null;
          if (!cat || cat?.type !== ChannelType.GuildCategory) {
            cat = guild.channels.cache.find(c => c.type === ChannelType.GuildCategory && /tickets?/i.test(c.name));
          }
          if (!cat) {
            try { cat = await guild.channels.create({ name: 'tickets', type: ChannelType.GuildCategory }); TICKETS_CATEGORY_ID = cat.id; } catch {}
          }
          if (!cat) { await interaction.reply({ content: 'Could not prepare ticket category.', ephemeral: true }); return; }
          const user = interaction.user;
          const nameCandidate = `ticket-${user.id}`;
          const existing = guild.channels.cache.find(ch => ch.name === nameCandidate && ch.parentId === cat.id);
          if (existing) {
            await interaction.reply({ content: `You already have a ticket: <#${existing.id}>`, ephemeral: true });
            return;
          }
          const overwrites = [
            { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
            { id: user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
          ];
          if (STAFF_ROLE_ID) overwrites.push({ id: STAFF_ROLE_ID, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] });
          let chan;
          try {
            chan = await guild.channels.create({ name: nameCandidate, type: ChannelType.GuildText, parent: cat.id, permissionOverwrites: overwrites, reason: `Ticket for ${user.tag}` });
          } catch { await interaction.reply({ content: 'Failed to create ticket channel.', ephemeral: true }); return; }
          const intro = new EmbedBuilder().setTitle('Issue Reported').setDescription(`Hi ${user}, thanks for your report.\n\n**Details:**\n${text}`).setColor(0xF59E0B);
          try { await chan.send({ content: `<@${user.id}>`, embeds: [intro] }); } catch {}
          await interaction.reply({ content: `Ticket created: <#${chan.id}>`, ephemeral: true });
          return;
        }
        if (sub === 'open') {
          // Staff-only: open for another user
          const guild = interaction.guild;
          if (!guild) { await interaction.reply({ content: 'Use this in a server.', ephemeral: true }); return; }
          const me = guild.members.me;
          const member = interaction.options.getUser('user', true);
          const subject = interaction.options.getString('subject') || 'support';
          // Check staff role
          if (STAFF_ROLE_ID) {
            const invoker = await guild.members.fetch(interaction.user.id).catch(() => null);
            if (!invoker || !invoker.roles.cache.has(STAFF_ROLE_ID)) { await interaction.reply({ content: 'Staff only.', ephemeral: true }); return; }
          }
          try { await new Promise(r => setTimeout(r, 400)); await guild.channels.fetch(); } catch {}
          let cat = TICKETS_CATEGORY_ID ? await guild.channels.fetch(TICKETS_CATEGORY_ID).catch(() => null) : null;
          if (!cat || cat?.type !== ChannelType.GuildCategory) { cat = guild.channels.cache.find(c => c.type === ChannelType.GuildCategory && /tickets?/i.test(c.name)); }
          if (!cat) { try { cat = await guild.channels.create({ name: 'tickets', type: ChannelType.GuildCategory }); TICKETS_CATEGORY_ID = cat.id; } catch {} }
          if (!cat) { await interaction.reply({ content: 'Could not prepare ticket category.', ephemeral: true }); return; }
          const nameCandidate = `ticket-${member.id}`;
          const existing = guild.channels.cache.find(ch => ch.name === nameCandidate && ch.parentId === cat.id);
          if (existing) { await interaction.reply({ content: `Ticket already exists: <#${existing.id}>`, ephemeral: true }); return; }
          const overwrites = [
            { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
            { id: member.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
          ];
          if (STAFF_ROLE_ID) overwrites.push({ id: STAFF_ROLE_ID, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] });
          let chan; try { chan = await guild.channels.create({ name: nameCandidate, type: ChannelType.GuildText, parent: cat.id, permissionOverwrites: overwrites, reason: `Ticket for ${member.tag}` }); } catch { await interaction.reply({ content: 'Failed to create ticket channel.', ephemeral: true }); return; }
          const intro = new EmbedBuilder().setTitle('Ticket Opened').setDescription(`A ticket has been opened for <@${member.id}>. Subject: **${subject}**`).setColor(0xF59E0B);
          try { await chan.send({ content: `<@${member.id}>`, embeds: [intro] }); } catch {}
          await interaction.reply({ content: `Ticket created: <#${chan.id}>`, ephemeral: true });
          return;
        }
      }
    }
  } catch {}
});

client.login(BOT_TOKEN);
