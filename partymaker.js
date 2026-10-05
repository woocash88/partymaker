require('dotenv').config();
const { randomBytes } = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  EmbedBuilder, StringSelectMenuBuilder, ChannelType, Events, MessageFlags,
  REST, Routes, PermissionFlagsBits, AttachmentBuilder, ModalBuilder, TextInputBuilder, TextInputStyle
} = require('discord.js');

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMessages],
});

const { TOKEN, GUILD_ID, CLIENT_ID } = process.env;

// CZASY PRODUKCYJNE
const WARN_MINUTES = 25;
const EXPIRE_MINUTES = 30;
const THREAD_EXPIRY_MS = 86400000;  // 24h
const COOLDOWN_MS = 60000;          // 1 min cooldown na tworzenie

const PANEL_BANNER = 'dashboard.png';
const FEEDBACK_CHANNEL_ID = '1556778409583976529';

// Grafiki dla trybów gry
const modeBanners = {
  'Ranked':   'ranked.png',
  'Normal':   'normal.png',
  'Battlecup':'battlecup.png',
  'Inhouse':  'inhouse.png',
  'Low prio': 'lowprio.png',
};

const parties = new Map();
const creationCache = new Map();
let threadsToDelete = new Map();
const partyCooldowns = new Map();

const replyAndDelete = async (interaction, content, delay = 2000) => {
  const method = interaction.deferred || interaction.replied ? 'editReply' : 'reply';
  await interaction[method]({ content, components: [], embeds: [], flags: [MessageFlags.Ephemeral] }).catch(() => {});
  setTimeout(() => interaction.deleteReply().catch(() => {}), delay);
};

function logEvent(event, user = 'SYSTEM', details = '-') {
  const timestamp = new Date().toLocaleString('pl-PL', { timeZone: 'Europe/Warsaw' });
  const logEntry = `${timestamp};${event};${user.replace(/;/g, ' ')};${details.replace(/;/g, ' ')}\n`;
  const logPath = path.join(__dirname, 'party_logs.csv');
  if (!fs.existsSync(logPath)) fs.writeFileSync(logPath, 'Date;Event;User;Details\n');
  fs.appendFile(logPath, logEntry, (err) => { if (err) console.error("CSV Error:", err); });
}

const THREADS_FILE = path.join(__dirname, 'threads_to_delete.json');
const saveThreadsQueue = () => fs.writeFileSync(THREADS_FILE, JSON.stringify(Array.from(threadsToDelete.entries())));
const loadThreadsQueue = () => {
  if (fs.existsSync(THREADS_FILE)) {
    try { return new Map(JSON.parse(fs.readFileSync(THREADS_FILE))); } catch { return new Map(); }
  }
  return new Map();
};

const modeColors = { 'Ranked': 0xFF0000, 'Normal': 0x00FFFF, 'Battlecup': 0xFFD700, 'Inhouse': 0x808080, 'Low prio': 0xFF4500 };
const modeRoles = { 'Ranked': '<@&980824750291050527>', 'Normal': '<@&985527058929180683>', 'Battlecup': '<@&1104441802200719492>', 'Inhouse': '<@&980824894172446740>', 'Low prio': 'LOW PRIO 👩‍🦽' };
const modeEmojis = { 'Ranked': '⚔️', 'Normal': '🤙', 'Battlecup': '🏆', 'Inhouse': '🏠', 'Low prio': '☠️' };

const rankEmojis = {
  'Dowolna':  '985526786836279327',
  'Herald':   '985542468093214761',
  'Guardian': '985542497650491392',
  'Crusader': '985542375847919676',
  'Archon':   '985542342188617748',
  'Legend':   '985542440133992459',
  'Ancient':  '985538142436220958',
  'Divine':   '985542414955593798',
  'Immortal': '969396388280545320',
};

const rankDisplay = {
  'Dowolna':  '<:x_BBAunc:985526786836279327> Dowolna ranga',
  'Herald':   '<:x_BBherald:985542468093214761>',
  'Guardian': '<:x_BBguardian:985542497650491392>',
  'Crusader': '<:x_BCrusader:985542375847919676>',
  'Archon':   '<:x_BDarchon:985542342188617748>',
  'Legend':   '<:x_BLegend:985542440133992459>',
  'Ancient':  '<:x_BMAncient:985538142436220958>',
  'Divine':   '<:x_BMdivine:985542414955593798>',
  'Immortal': '<:x_BNimmortal:969396388280545320>',
};

async function closePartyThread(p) {
  try {
    if (p.message) await p.message.delete().catch(() => {});
    if (p.buttonsMessage) await p.buttonsMessage.delete().catch(() => {});

    if (p.threadId) {
      const thread = await client.channels.fetch(p.threadId).catch(() => null);
      if (thread && thread.isThread()) {
        if (p.warnMessageId) {
          await thread.messages.fetch(p.warnMessageId)
            .then(m => m.delete())
            .catch(() => {});
        }
        await thread.send("To ogłoszenie zostało zakończone. Wątek zostanie wkrótce usunięty.").catch(() => {});
      }

      threadsToDelete.set(p.threadId, { deleteAt: Date.now() + THREAD_EXPIRY_MS, channelId: p.channelId });
      saveThreadsQueue();
    }
  } catch (e) { console.error("closePartyThread Error:", e); }
}

function createSetupPanel(userId, mode) {
  const data = creationCache.get(userId);
  const guild = client.guilds.cache.get(GUILD_ID);
  const voiceChannels = guild.channels.cache
    .filter(c => c.type === ChannelType.GuildVoice && c.permissionsFor(guild.roles.everyone).has(PermissionFlagsBits.ViewChannel))
    .sort((a, b) => a.rawPosition - b.rawPosition).first(24);

  const vcOptions = [
    { label: '🚫 Brak kanału głosowego', value: 'none', default: data.vc === null },
    ...(voiceChannels.length
      ? voiceChannels.map(vc => ({ label: vc.name, value: vc.id, default: data.vc === vc.id }))
      : [])
  ];

  return {
    content: `### 🛠️ Konfiguracja: **${mode}**\n➡️ Graczy: **${data.count === 'Obojętnie' ? 'Obojętnie' : '+' + data.count}**\n🔰 Rangi: **${data.ranks.length ? data.ranks.join(', ') : '*Nie wybrano*'}**\n🔊 Kanał: ${data.vc ? `<#${data.vc}>` : '*Brak*'}\n📝 Opis: *${data.description || 'Brak'}*`,
    components: [
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder().setCustomId(`setcount_${mode}`).setPlaceholder(`Ilu szukasz? (+${data.count})`)
          .addOptions([{ label: 'Obojętnie', value: 'Obojętnie', default: data.count === 'Obojętnie' }, ...Array.from({ length: 9 }, (_, i) => ({ label: `Szukam +${i + 1}`, value: `${i + 1}`, default: data.count === `${i + 1}` }))])
      ),
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder().setCustomId(`setranks_${mode}`).setPlaceholder('Wybierz rangi').setMinValues(1).setMaxValues(5)
          .addOptions(Object.keys(rankEmojis).map(r => ({ label: r, value: r, emoji: rankEmojis[r], default: data.ranks.includes(r) })))
      ),
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder().setCustomId(`setvc_${mode}`).setPlaceholder('Wybierz kanał głosowy')
          .addOptions(vcOptions)
      ),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`setdesc_${mode}`).setLabel('Dodaj Opis').setEmoji('📝').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`publish_${mode}`).setLabel('Opublikuj Ogłoszenie').setStyle(ButtonStyle.Success)
      )
    ]
  };
}

client.once(Events.ClientReady, async () => {
  threadsToDelete = loadThreadsQueue();
  console.log(`🚀 Bot aktywny: ${client.user.tag}`);
  logEvent('BOT_START', 'SYSTEM', `tag=${client.user.tag}`);
  const commands = [{ name: 'party', description: 'Wysyła panel party maker' }];
  await new REST({ version: '10' }).setToken(TOKEN).put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
});

client.on(Events.MessageCreate, async (message) => {
  if (message.system && message.type === 18) {
    await message.delete().catch(() => {});
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  const userId = interaction.user.id;
  const userTag = interaction.user.tag;

  if (interaction.isChatInputCommand() && interaction.commandName === 'party') {
    await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
    logEvent('COMMAND_PARTY', userTag, `channel=${interaction.channelId}`);
    const bannerPath = path.join(__dirname, PANEL_BANNER);
    const files = fs.existsSync(bannerPath) ? [new AttachmentBuilder(bannerPath)] : [];

    const embed = new EmbedBuilder()
      .setTitle('Jak to działa?')
      .setDescription(`1️⃣ Wybierz tryb gry poniżej.\n2️⃣ Podaj liczbę graczy, rangi oraz kanał głosowy.\n3️⃣ Gotowe! 😎\n\nPo **${WARN_MINUTES} min** otrzymasz przypomnienie, a po **${EXPIRE_MINUTES} min** ogłoszenie wygaśnie automatycznie.\nJeśli przebywasz na podanym kanale głosowym, to ogłoszenie będzie aktywne dopóki jesteś na tym kanale.\n\n[📜 Kliknij tutaj, aby sprawdzić Changelog!](https://discord.com/channels/947158056381337630/1516744426406543400/1516744500553318420)`)
      .setColor(0xFF0000);

    if (files.length) embed.setImage(`attachment://${PANEL_BANNER}`);
    const row = new ActionRowBuilder().addComponents(['Ranked', 'Normal', 'Battlecup', 'Low prio'].map((m, i) =>
      new ButtonBuilder().setCustomId(`start_${m}`).setLabel(m).setEmoji(modeEmojis[m]).setStyle([ButtonStyle.Success, ButtonStyle.Primary, ButtonStyle.Secondary, ButtonStyle.Danger][i])
    ));
    row.addComponents(new ButtonBuilder().setCustomId('feedback').setLabel('Co myślisz o bocie?').setEmoji('💬').setStyle(ButtonStyle.Secondary));

    await interaction.channel.send({ embeds: [embed], components: [row], files });
    return replyAndDelete(interaction, 'Panel wysłany!', 1000);
  }

  if (interaction.isButton()) {
    const parts = interaction.customId.split('_');
    const action = parts.shift();
    const id = parts.join('_');

    if (action === 'start') {
      await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

      const cooldownEnd = partyCooldowns.get(userId);
      if (cooldownEnd && Date.now() < cooldownEnd) {
        const timeLeft = Math.ceil((cooldownEnd - Date.now()) / 1000);
        return replyAndDelete(interaction, `⏳ Poczekaj jeszcze **${timeLeft}s** przed utworzeniem kolejnego ogłoszenia!`, 1500);
      }

      if (Array.from(parties.values()).some(p => p.leaderId === userId)) {
        logEvent('START_BLOCKED', userTag, `reason=already_has_party mode=${id}`);
        return replyAndDelete(interaction, '❌ Masz już aktywne ogłoszenie!');
      }

      creationCache.set(userId, { count: (id === 'Low prio' ? 'Obojętnie' : '1'), ranks: (id === 'Low prio' ? ['Dowolna'] : []), vc: null, description: '', processing: false, timestamp: Date.now() });
      logEvent('SETUP_START', userTag, `mode=${id}`);
      return interaction.editReply(createSetupPanel(userId, id));
    }

    if (action === 'feedback') {
      const modal = new ModalBuilder().setCustomId('modalfeedback').setTitle('Co myślisz o bocie?');
      const input = new TextInputBuilder().setCustomId('feedbackinput').setLabel('Twoja opinia (max 1000 znaków)').setStyle(TextInputStyle.Paragraph).setMaxLength(1000).setRequired(true);
      modal.addComponents(new ActionRowBuilder().addComponents(input));
      return await interaction.showModal(modal);
    }

    if (action === 'setdesc') {
      const modal = new ModalBuilder().setCustomId(`modaldesc_${id}`).setTitle('Opis ogłoszenia');
      const input = new TextInputBuilder().setCustomId('descinput').setLabel('Limit 50 znaków').setStyle(TextInputStyle.Paragraph).setMaxLength(50).setPlaceholder('np. szukam pos 4/5').setRequired(false);
      modal.addComponents(new ActionRowBuilder().addComponents(input));
      return await interaction.showModal(modal);
    }

    if (action === 'publish') {
      const cooldownEnd = partyCooldowns.get(userId);
      if (cooldownEnd && Date.now() < cooldownEnd) {
        const timeLeft = Math.ceil((cooldownEnd - Date.now()) / 1000);
        return replyAndDelete(interaction, `⏳ Poczekaj jeszcze **${timeLeft}s** przed utworzeniem kolejnego ogłoszenia!`, 1500);
      }

      const data = creationCache.get(userId);
      if (!data || data.processing) return;
      data.processing = true;
      await interaction.deferUpdate();

      const partyId = randomBytes(4).toString('hex');

      try {
        creationCache.delete(userId);
        partyCooldowns.set(userId, Date.now() + COOLDOWN_MS);

        const threadButtons = [
          new ButtonBuilder().setCustomId(`join_${partyId}`).setLabel('Dołącz do ekipy').setEmoji('✅').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`extend_${partyId}`).setLabel('Przedłuż').setEmoji('🔄').setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId(`stop_${partyId}`).setLabel('Zakończ ogłoszenie').setEmoji('🛑').setStyle(ButtonStyle.Danger)
        ];

        if (data.vc) {
          threadButtons.push(new ButtonBuilder().setLabel('Wejdź na VC').setEmoji('🔊').setStyle(ButtonStyle.Link).setURL(`https://discord.com/channels/${GUILD_ID}/${data.vc}`));
        }

        const threadRow = new ActionRowBuilder().addComponents(...threadButtons);

        const formattedRanks = (data.ranks.length ? data.ranks : ['Dowolna']).map(r => rankDisplay[r] || r).join(' ');

        // Grafika dedykowana dla trybu gry
        const bannerFile = modeBanners[id];
        const bannerPath = path.join(__dirname, bannerFile);
        const threadFiles = fs.existsSync(bannerPath) ? [new AttachmentBuilder(bannerPath, { name: bannerFile })] : [];

        const embedTitle = data.description ? `"${data.description}"` : `${modeEmojis[id] || '🎮'} Ogłoszenie: ${id}`;
        const embed = new EmbedBuilder()
          .setTitle(embedTitle)
          .setColor(modeColors[id] || 0x2b2d31)
          .setDescription(
            `👤 **Lider:** <@${userId}>\n` +
            `➡️ **Potrzeba:** ${data.count === 'Obojętnie' ? 'Obojętnie' : '+' + data.count}\n` +
            `🔰 **Rangi:** ${formattedRanks}\n` +
            `⏰ **Start:** <t:${Math.floor(Date.now() / 1000)}:R>\n` +
            `${data.vc ? `🔊 **Kanał:** <#${data.vc}>\n` : ''}` +
            `${id === 'Low prio' ? `☠️ **Tryb:** SINGLE DRAFT` : ''}`
          );
        if (threadFiles.length) embed.setImage(`attachment://${bannerFile}`);

        const controlMsg = await interaction.channel.send({
          content: modeRoles[id] || `<@${userId}> szuka zawodników do party!`,
          embeds: [embed],
          files: threadFiles
        });

        const buttonsMsg = await interaction.channel.send({
          components: [threadRow]
        });

        const thread = await controlMsg.startThread({
          name: `${id} - ${interaction.user.username}`,
          autoArchiveDuration: 1440
        });

        parties.set(partyId, {
          id: partyId,
          leaderId: userId,
          members: [userId],
          start: Date.now(),
          message: controlMsg,
          buttonsMessage: buttonsMsg,
          threadId: thread.id,
          channelId: interaction.channelId,
          warned: false,
          mode: id,
          count: data.count,
          ranks: data.ranks,
          vc: data.vc,
          description: data.description
        });

        logEvent('PUBLISH', userTag, `partyId=${partyId} mode=${id} count=${data.count}`);

        return replyAndDelete(interaction, '✅ Ogłoszenie opublikowane! Wątek został utworzony poniżej.', 2500);
      } catch (e) {
        console.error("🔥 BŁĄD PUBLIKACJI:", e);
        data.processing = false;
        logEvent('PUBLISH_ERROR', userTag, `mode=${id} error=${e.message}`);
        return replyAndDelete(interaction, '❌ Błąd podczas publikacji. Sprawdź terminal bota!');
      }
    }

    if (action === 'join' || action === 'stop' || action === 'extend') {
      const p = parties.get(id);
      if (!p) {
        if (action === 'join') { logEvent('JOIN_FAIL', userTag, `partyId=${id} reason=expired`); return replyAndDelete(interaction, 'To ogłoszenie już wygasło.'); }
        return;
      }

      if (action === 'join') {
        if (p.leaderId === userId || p.members.includes(userId)) {
          logEvent('JOIN_BLOCKED', userTag, `partyId=${id} reason=already_member`);
          return replyAndDelete(interaction, '❌ Już jesteś członkiem tego party!');
        }

        const thread = p.threadId ? await client.channels.fetch(p.threadId).catch(() => null) : null;
        if (thread) {
          await thread.members.add(userId).catch(() => {});
          await thread.send(`👋 <@${userId}> dołączył do ekipy! Poczekalnia zaktualizowana.\n🔔 <@${p.leaderId}> masz nowego chętnego gracza!`);
        }

        p.members.push(userId);
        logEvent('JOIN', userTag, `partyId=${id} members=${p.members.length}`);

        return replyAndDelete(interaction, '✅ Dołączono pomyślnie!', 1000);
      }

      if (p.leaderId !== userId) {
        return replyAndDelete(interaction, '❌ Tylko lider party może zarządzać tym ogłoszeniem!', 2000);
      }

      if (action === 'extend') {
        p.start = Date.now();
        p.warned = false;

        const t = p.threadId ? await client.channels.fetch(p.threadId).catch(() => null) : null;
        if (t && p.warnMessageId) (await t.messages.fetch(p.warnMessageId).catch(() => null))?.delete().catch(() => {});

        logEvent('EXTEND', userTag, `partyId=${id}`);

        return replyAndDelete(interaction, '✅ Czas ważności ogłoszenia został zresetowany na nowo!', 2000);
      } else {
        parties.delete(id);
        logEvent('STOP', userTag, `partyId=${id} members=${p.members.length}`);

        await closePartyThread(p);

        return replyAndDelete(interaction, '🛑 Twoje ogłoszenie zostało pomyślnie zamknięte i usunięte z tablicy.', 2000);
      }
    }
  }

  if (interaction.isModalSubmit()) {
    const parts = interaction.customId.split('_');
    const action = parts.shift();
    const mode = parts.join('_');

    if (interaction.customId === 'modalfeedback') {
      const text = interaction.fields.getTextInputValue('feedbackinput').trim();
      if (!text) return interaction.reply({ content: '❌ Wiadomość jest pusta.', flags: [MessageFlags.Ephemeral] });
      try {
        const channel = await client.channels.fetch(FEEDBACK_CHANNEL_ID);
        const embed = new EmbedBuilder()
          .setTitle('💬 Opinia o bocie')
          .setDescription(text)
          .setAuthor({ name: userTag, iconURL: interaction.user.displayAvatarURL() })
          .setFooter({ text: `ID: ${userId}` })
          .setTimestamp()
          .setColor(0xFF0000);
        await channel.send({ embeds: [embed] });
        logEvent('FEEDBACK_SENT', userTag, `length=${text.length}`);
        return interaction.reply({ content: '✅ Dziękujemy za opinię!', flags: [MessageFlags.Ephemeral] });
      } catch (err) {
        logEvent('FEEDBACK_FAILED', userTag, String(err.message || err));
        return interaction.reply({ content: '❌ Nie udało się wysłać wiadomości. Spróbuj później.', flags: [MessageFlags.Ephemeral] });
      }
    }

    if (action === 'modaldesc') {
      const data = creationCache.get(userId);
      if (!data) return;
      const desc = interaction.fields.getTextInputValue('descinput');
      data.description = desc;
      data.timestamp = Date.now();
      logEvent('SET_DESC', userTag, `mode=${mode} desc=${desc || 'empty'}`);
      return await interaction.update(createSetupPanel(userId, mode));
    }
  }

  if (interaction.isStringSelectMenu()) {
    const parts = interaction.customId.split('_');
    const action = parts.shift();
    const mode = parts.join('_');
    const data = creationCache.get(userId);
    if (!data) return;

    await interaction.deferUpdate();
    if (action === 'setcount') { data.count = interaction.values[0]; logEvent('SET_COUNT', userTag, `mode=${mode} count=${data.count}`); }
    if (action === 'setranks') { data.ranks = interaction.values; logEvent('SET_RANKS', userTag, `mode=${mode} ranks=${data.ranks.join('|')}`); }
    if (action === 'setvc') {
      data.vc = interaction.values[0] === 'none' ? null : interaction.values[0];
      logEvent('SET_VC', userTag, `mode=${mode} vc=${data.vc ?? 'none'}`);
    }

    data.timestamp = Date.now();
    await interaction.editReply(createSetupPanel(userId, mode));
  }
});

// Interwał co 15 sekund — sprawdzenie wygaśnięcia ogłoszeń (warn po 25min, expire po 30min)
setInterval(async () => {
  const guild = client.guilds.cache.get(GUILD_ID);

  for (const [id, p] of parties.entries()) {
    const now = Date.now();
    let diff = (now - p.start) / 60000;

    if (diff >= WARN_MINUTES && !p.warned) {
      let isLeaderOnVC = false;

      if (p.vc) {
        const voiceChannel = guild.channels.cache.get(p.vc);
        isLeaderOnVC = voiceChannel?.members.has(p.leaderId);
      }

      if (p.vc && isLeaderOnVC) {
        p.start = Date.now();
        p.warned = false;
        logEvent('AUTO_EXTEND_VC', 'SYSTEM', `partyId=${id} leader=${p.leaderId} channel=${p.vc}`);

        const t = p.threadId ? await client.channels.fetch(p.threadId).catch(() => null) : null;
        if (t && p.warnMessageId) (await t.messages.fetch(p.warnMessageId).catch(() => null))?.delete().catch(() => {});
      } else {
        p.warned = true;
        logEvent('WARN_EXPIRE', 'SYSTEM', `partyId=${id} leader=${p.leaderId}`);
        const t = p.threadId ? await client.channels.fetch(p.threadId).catch(() => null) : null;
        if (t) {
          const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`extend_${id}`).setLabel('Nadal szukam').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`stop_${id}`).setLabel('Zakończ').setStyle(ButtonStyle.Danger)
          );
          const wm = await t.send({ content: `⚠️ <@${p.leaderId}> Twoje ogłoszenie zaraz wygaśnie. Czy nadal szukasz graczy do party?`, components: [row] }).catch(() => null);
          if (wm) p.warnMessageId = wm.id;
        }
      }
    }

    diff = (Date.now() - p.start) / 60000;

    if (diff >= EXPIRE_MINUTES) {
      parties.delete(id);
      logEvent('EXPIRE', 'SYSTEM', `partyId=${id} leader=${p.leaderId}`);

      await closePartyThread(p);
    }
  }
}, 15000);

setInterval(() => {
  const now = Date.now();
  for (const [uid, data] of creationCache.entries()) {
    if (now - data.timestamp > 10 * 60 * 1000) creationCache.delete(uid);
  }
  for (const [uid, exp] of partyCooldowns.entries()) {
    if (now > exp) partyCooldowns.delete(uid);
  }
}, 60000);

// Usuwanie wątków po 24h
setInterval(async () => {
  const now = Date.now();
  let ch = false;
  for (const [tid, d] of threadsToDelete.entries()) {
    if (now >= d.deleteAt) {
      try {
        const c = await client.channels.fetch(d.channelId);
        const t = await c.threads.fetch(tid);
        if (t) await t.delete();
        logEvent('THREAD_DELETED', 'SYSTEM', `threadId=${tid}`);
      } catch (e) {
        logEvent('THREAD_DELETE_ERROR', 'SYSTEM', `threadId=${tid} error=${e.message}`);
        console.error("Thread delete error:", e);
      }
      threadsToDelete.delete(tid);
      ch = true;
    }
  }
  if (ch) saveThreadsQueue();
}, 30000);

client.login(TOKEN);