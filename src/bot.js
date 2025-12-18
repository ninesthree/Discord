import 'dotenv/config';
import fetch from 'node-fetch';
import {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  EmbedBuilder,
} from 'discord.js';
import { REST, Routes, SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';

// ---- Env & defaults ----
const BOT_TOKEN = process.env.BOT_TOKEN;
const ALLOW_MESSAGE_CONTENT = String(process.env.ALLOW_MESSAGE_CONTENT || 'true').toLowerCase() === 'true';
const OWNER_STARTUP_DM = String(process.env.OWNER_STARTUP_DM || 'false').toLowerCase() === 'true';
const OWNER_ID = process.env.OWNER_ID ? String(process.env.OWNER_ID) : null;
let ANNOUNCE_CHANNEL_ID = process.env.ANNOUNCE_CHANNEL_ID ? String(process.env.ANNOUNCE_CHANNEL_ID) : null;
const POLL_INTERVAL = Number(process.env.POLL_INTERVAL || 10);

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const CLAIMS_TABLE = 'user_key_claims';
const KEYS_TABLE = 'user_keys';

const FEED_URL = process.env.FEED_URL || 'http://localhost:3000/api/bot/claim-feed';
const MARK_URL = process.env.MARK_URL || 'http://localhost:3000/api/bot/claim-feed/mark';

if (!BOT_TOKEN) {
  console.error('Missing BOT_TOKEN in .env');
  process.exit(1);
}

// ---- Discord client ----
const intents = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.DirectMessages,
];
if (ALLOW_MESSAGE_CONTENT) intents.push(GatewayIntentBits.MessageContent);

const client = new Client({
  intents,
  partials: [Partials.Channel],
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
function buildInteractiveMenuEmbed() {
  return new EmbedBuilder()
    .setTitle('Radiant Helper Menu')
    .setDescription('\nPage 1 of 1')
    .addFields(
      { name: 'Core', value: 'Use reactions to navigate', inline: false },
      { name: 'Website', value: 'Open website-related tools (Keys)', inline: false },
    )
    .setFooter({ text: "React with 🌐 to open Website menu." })
    .setColor(0x2f3136);
}

function buildWebsiteSubmenuEmbed() {
  return new EmbedBuilder()
    .setTitle('Website Submenu')
    .addFields(
      { name: 'Keys', value: 'Manage website key claims, announce channel, status', inline: false },
      { name: 'Quick commands', value: [
        'status — runtime status',
        'announce <#channelId> — set announce channel',
        'menu — owner menu',
      ].join('\n'), inline: false },
    )
    .setFooter({ text: 'More modules can be added later.' })
    .setColor(0xF59E0B);
}

async function sendOwnerInteractiveMenu() {
  try {
    if (!OWNER_ID) return;
    const owner = await client.users.fetch(OWNER_ID);
    if (!owner) return;
    const embed = buildInteractiveMenuEmbed();
    const msg = await owner.send({ embeds: [embed] });
    await msg.react('🌐');
    const filter = (reaction, user) => reaction.message.id === msg.id && reaction.emoji.name === '🌐' && String(user.id) === OWNER_ID;
    const collector = msg.createReactionCollector({ filter, time: 120000, max: 1 });
    collector.on('collect', async () => {
      try {
        const w = buildWebsiteSubmenuEmbed();
        await owner.send({ embeds: [w] });
      } catch {}
    });
  } catch {}
}

// ---- Message triggers ----
if (ALLOW_MESSAGE_CONTENT) {
  client.on(Events.MessageCreate, async (message) => {
    try {
      if (message.author.bot) return;
      const content = (message.content || '').trim();
      const lower = content.toLowerCase();

      // Plain menu/menu with bang for privileged user
      if (lower === 'menu' || lower === '!menu') {
        const isOwner = OWNER_ID && String(message.author.id) === OWNER_ID;
        if (!isOwner) return;
        const embed = buildInteractiveMenuEmbed();
        try {
          const dm = await message.author.send({ embeds: [embed] });
          await dm.react('🌐');
          await message.channel.send({ embeds: [embed] });
        } catch {}
        return;
      }

      // status
      if (lower === 'status') {
        const text = `Announce: ${ANNOUNCE_CHANNEL_ID ? `set (${ANNOUNCE_CHANNEL_ID})` : 'unset'} | Interval: ${POLL_INTERVAL}s | Feed: ${FEED_URL ? 'on' : 'off'} | Supabase: ${SUPABASE_URL ? 'on' : 'off'}`;
        await message.channel.send(text);
        return;
      }

      // announce <channelId>
      if (lower.startsWith('announce ')) {
        const isOwner = OWNER_ID && String(message.author.id) === OWNER_ID;
        if (!isOwner) return;
        const parts = content.split(/\s+/);
        const cid = parts[1]?.replace(/[^0-9]/g, '') || '';
        if (!cid) {
          await message.channel.send('Usage: announce <channelId>');
          return;
        }
        ANNOUNCE_CHANNEL_ID = cid;
        await message.channel.send(`Announce channel set to ${cid}.`);
        return;
      }
    } catch {}
  });
}

client.once(Events.ClientReady, async () => {
  console.log(`Logged in as ${client.user.tag}`);
  // Register global slash commands for DM-safe operations (no Message Content intent needed)
  try {
    const commands = [
      new SlashCommandBuilder().setName('status').setDescription('Show helper status'),
      new SlashCommandBuilder().setName('menu').setDescription('Show the helper menu'),
      new SlashCommandBuilder()
        .setName('announce')
        .setDescription('Set announce channel (owner only)')
        .addStringOption(opt => opt.setName('channel_id').setDescription('Channel ID').setRequired(true)),
      new SlashCommandBuilder()
        .setName('clear')
        .setDescription('Clear recent messages in this channel or DM (best-effort)')
        .addIntegerOption(opt => opt.setName('count').setDescription('How many (default 100, max 1000)').setRequired(false)),
      new SlashCommandBuilder()
        .setName('clear-dm')
        .setDescription('Delete recent bot messages in this DM')
        .addIntegerOption(opt => opt.setName('count').setDescription('How many (max 100)').setRequired(false)),
    ].map(c => c.toJSON());

    const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);
    const appId = client.application.id;
    await rest.put(Routes.applicationCommands(appId), { body: commands });
    console.log('[commands] registered (global)');
    // Also register per-guild for immediate availability
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
      if (name === 'menu') {
        const embed = buildInteractiveMenuEmbed();
        await interaction.reply({ embeds: [embed], ephemeral: false });
        try { const msg = await interaction.fetchReply(); await msg.react('🌐'); } catch {}
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
          // Auto-delete the confirmation after 10 seconds so /clear leaves no residual messages
          setTimeout(async () => { try { await doneMsg.delete(); } catch {} }, 10_000);
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
          // Auto-delete the confirmation after 10 seconds for a clean DM
          setTimeout(async () => { try { await doneMsg.delete(); } catch {} }, 10_000);
        } catch {}
        return;
      }
    }
  } catch {}
});

client.login(BOT_TOKEN);
