// ======================== TARAGON TELEGRAM BOT ========================
// Install: npm install
// Run:     node bot.js
// ======================================================================

'use strict';

const TelegramBot  = require('node-telegram-bot-api');
const axios        = require('axios');
const yts          = require('yt-search');
const ytdl         = require('@distube/ytdl-core');
const fs           = require('fs');
const path         = require('path');
const http         = require('http');
const { exec, spawn } = require('child_process');
const { promisify }   = require('util');
const execAsync       = promisify(exec);

// =====================================================================
//  RENDER FIX — bind to HTTP port or Render kills the process
// =====================================================================
const PORT = process.env.PORT || 3000;
http.createServer((_, res) => {
    res.writeHead(200); res.end('🤖 Taragon Bot is alive!');
}).listen(PORT, () => console.log(`✅ HTTP keep-alive on port ${PORT}`));

// =====================================================================
//  CONFIG
// =====================================================================
const TOKEN = process.env.BOT_TOKEN || '8838166170:AAGzpSpkuSzr01jn7KP5551VrhsS1xF6A9E';
if (!TOKEN) { console.error('❌ No BOT_TOKEN set'); process.exit(1); }

const bot       = new TelegramBot(TOKEN, { polling: true });
const startTime = Date.now();
const chatMemory = new Map();

let settings = {
    mode: 'public',
    chatbotGlobal: true,
    funMode: true,
    ownerId: null,
    admins: [],
};

// yt-dlp binary path (installed by postinstall, no sudo needed)
const YTDLP_PATH = path.join(__dirname, 'bin', 'yt-dlp');
const hasYtDlp   = () => fs.existsSync(YTDLP_PATH);

// =====================================================================
//  UTILITIES
// =====================================================================
const esc = s => String(s||'')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');

const fmtNum = n => {
    n = parseInt(n); if (!n||isNaN(n)) return null;
    if (n>=1e9) return (n/1e9).toFixed(1).replace(/\.0$/,'')+'B';
    if (n>=1e6) return (n/1e6).toFixed(1).replace(/\.0$/,'')+'M';
    if (n>=1e3) return (n/1e3).toFixed(1).replace(/\.0$/,'')+'K';
    return String(n);
};

const fmtSec = s => {
    s=parseInt(s); if(!s||isNaN(s)) return null;
    const h=Math.floor(s/3600),m=Math.floor((s%3600)/60),ss=s%60;
    return h ? `${h}:${String(m).padStart(2,'0')}:${String(ss).padStart(2,'0')}` : `${m}:${String(ss).padStart(2,'0')}`;
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

const formatUptime = () => {
    const u = Date.now()-startTime;
    return `${Math.floor(u/3600000)}h ${Math.floor((u%3600000)/60000)}m ${Math.floor((u%60000)/1000)}s`;
};

function buildCaption({ title, artist, duration, views, likes, link, type='song' }) {
    const icon = type==='video' ? '🎬' : '🎵';
    const lines = [`${icon} <b>${esc(title||'Unknown')}</b>`];
    if (artist)   lines.push(`👤 <b>Artist:</b> ${esc(artist)}`);
    if (duration) lines.push(`⏱ <b>Duration:</b> ${duration}`);
    if (views)    lines.push(`👁 <b>Views:</b> ${views}`);
    if (likes)    lines.push(`❤️ <b>Likes:</b> ${likes}`);
    if (link)     lines.push(`🔗 <a href="${esc(link)}">Open on YouTube</a>`);
    lines.push(`\n🇻🇦 <i>Taragon Squad TRS</i>`);
    return lines.join('\n');
}

// =====================================================================
//  HTTP HELPERS
// =====================================================================
const REQ_OPTS = {
    timeout: 30000,
    headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept':     'application/json',
    }
};

async function tryGet(url, opts={}, attempts=2) {
    for (let i=1; i<=attempts; i++) {
        try { return await axios.get(url, { ...REQ_OPTS, ...opts }); }
        catch(e) { if (i<attempts) await sleep(1500*i); else throw e; }
    }
}

async function fetchBuffer(url) {
    const r = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: 120000,
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': '*/*' },
    });
    return Buffer.from(r.data);
}

// =====================================================================
//  YOUTUBE SEARCH
// =====================================================================
async function searchYT(query) {
    // 1. yt-search (scrapes YouTube)
    try {
        const r = await yts(query);
        const v = r?.videos?.[0];
        if (v?.url) return {
            url:       v.url,
            videoId:   v.videoId,
            title:     v.title,
            artist:    v.author?.name,
            duration:  v.timestamp,
            views:     fmtNum(v.views),
            thumbnail: v.thumbnail,
            link:      v.url,
        };
    } catch(e) { console.log('[search] yt-search err:', e.message); }

    // 2. Scrape YouTube search HTML
    try {
        const res = await axios.get(
            `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`,
            { timeout:15000, headers:{'User-Agent':'Mozilla/5.0','Accept-Language':'en-US,en'} }
        );
        const m = res.data.match(/"videoId":"([^"]{11})"[^}]*?"title":\{"runs":\[\{"text":"([^"]+)"/);
        if (m) {
            const [,videoId,title] = m;
            return {
                url:       `https://www.youtube.com/watch?v=${videoId}`,
                videoId,   title,
                thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
                link:      `https://www.youtube.com/watch?v=${videoId}`,
            };
        }
    } catch(e) { console.log('[search] scrape err:', e.message); }

    throw new Error('Song not found. Try different keywords.');
}

async function resolveUrl(url) {
    const videoId = url.match(/(?:v=|youtu\.be\/)([A-Za-z0-9_-]{11})/)?.[1];
    try {
        const r = await yts({ videoId });
        if (r?.title) return {
            url, videoId,
            title:     r.title,
            artist:    r.author?.name,
            duration:  r.timestamp,
            views:     fmtNum(r.views),
            thumbnail: r.thumbnail || (videoId && `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`),
            link:      url,
        };
    } catch {}
    return { url, videoId, title:'Video', thumbnail: videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : null, link: url };
}

// =====================================================================
//  AUDIO DOWNLOAD — @distube/ytdl-core first, then 8 API fallbacks
// =====================================================================
async function downloadAudio(info) {
    const { url, videoId, title } = info;

    // ── METHOD 1: @distube/ytdl-core (direct, fastest, no external APIs) ──
    try {
        console.log('[audio] trying ytdl-core...');
        const chunks = [];
        await new Promise((resolve, reject) => {
            const stream = ytdl(url, {
                filter:  'audioonly',
                quality: 'highestaudio',
                requestOptions: { headers: { 'User-Agent': 'Mozilla/5.0' } },
            });
            stream.on('data',  c => chunks.push(c));
            stream.on('end',   () => resolve());
            stream.on('error', e  => reject(e));
            setTimeout(() => reject(new Error('ytdl timeout')), 90000);
        });
        const buf = Buffer.concat(chunks);
        if (buf.length > 50000) { console.log('[audio] ✅ ytdl-core'); return buf; }
        throw new Error('buffer too small');
    } catch(e) { console.log('[audio] ✗ ytdl-core:', e.message); }

    // ── METHOD 2: External API waterfall ──
    const vid = videoId || url.match(/(?:v=|youtu\.be\/)([A-Za-z0-9_-]{11})/)?.[1] || '';

    const APIS = [
        {
            name: 'gifted',
            call: () => tryGet(`https://api.giftedtech.my.id/api/downloader/ytmp3?apikey=gifted&url=${encodeURIComponent(url)}`),
            pick: d => d?.data?.download_url || d?.result?.download_url,
        },
        {
            name: 'ryzen',
            call: () => tryGet(`https://api.ryzendesu.vip/api/downloader/ytmp3?url=${encodeURIComponent(url)}`),
            pick: d => d?.data?.link || d?.link || d?.audio,
        },
        {
            name: 'siputzx',
            call: () => tryGet(`https://api.siputzx.my.id/api/d/ytmp3?url=${encodeURIComponent(url)}`),
            pick: d => d?.data?.url || d?.data?.mp3 || d?.url,
        },
        {
            name: 'yupra',
            call: () => tryGet(`https://api.yupra.my.id/api/downloader/ytmp3?url=${encodeURIComponent(url)}`),
            pick: d => d?.data?.data?.download_url || d?.data?.download_url,
        },
        {
            name: 'okatsu',
            call: () => tryGet(`https://okatsu-rolezapiiz.vercel.app/downloader/ytmp3?url=${encodeURIComponent(url)}`),
            pick: d => d?.data?.dl || d?.dl,
        },
        {
            name: 'vapis',
            call: () => tryGet(`https://vapis.my.id/api/ytdl/mp3?url=${encodeURIComponent(url)}`),
            pick: d => d?.result?.download_url || d?.download_url || d?.url,
        },
        {
            name: 'zell',
            call: () => tryGet(`https://zellapi.autos/downloader/ytmp3?url=${encodeURIComponent(url)}`),
            pick: d => d?.result?.download_url || d?.data?.url,
        },
        {
            name: 'eliteprotech',
            call: () => tryGet(`https://eliteprotech-apis.zone.id/ytdown?url=${encodeURIComponent(url)}&format=mp3`),
            pick: d => d?.data?.downloadURL,
        },
    ];

    for (const api of APIS) {
        try {
            console.log(`[audio] trying ${api.name}...`);
            const res  = await api.call();
            const link = api.pick(res.data);
            if (link && link.startsWith('http')) {
                const buf = await fetchBuffer(link);
                if (buf.length > 50000) { console.log(`[audio] ✅ ${api.name}`); return buf; }
                console.log(`[audio] ${api.name} buffer too small (${buf.length}b)`);
            }
        } catch(e) { console.log(`[audio] ✗ ${api.name}: ${e.message}`); }
    }

    // ── METHOD 3: yt-dlp binary (installed by postinstall.js) ──
    if (hasYtDlp()) {
        try {
            console.log('[audio] trying yt-dlp binary...');
            const chunks = [];
            await new Promise((resolve, reject) => {
                const proc = spawn(YTDLP_PATH, [
                    '-x','--audio-format','mp3','--audio-quality','0','-o','-', url
                ]);
                proc.stdout.on('data', c => chunks.push(c));
                proc.stderr.on('data', d => console.log('[yt-dlp]', d.toString().slice(0,120)));
                proc.on('close', code => code===0 ? resolve() : reject(new Error(`yt-dlp exit ${code}`)));
                proc.on('error', reject);
            });
            const buf = Buffer.concat(chunks);
            if (buf.length > 50000) { console.log('[audio] ✅ yt-dlp'); return buf; }
        } catch(e) { console.log('[audio] ✗ yt-dlp:', e.message); }
    }

    throw new Error('All download sources failed. Try again in a few minutes or use a direct YouTube URL.');
}

// =====================================================================
//  VIDEO DOWNLOAD
// =====================================================================
async function downloadVideo(info) {
    const { url } = info;

    // ytdl-core first
    try {
        console.log('[video] trying ytdl-core...');
        const chunks = [];
        await new Promise((resolve, reject) => {
            const stream = ytdl(url, {
                filter: f => f.container==='mp4' && f.hasVideo && f.hasAudio,
                quality: 'highestvideo',
            });
            stream.on('data',  c => chunks.push(c));
            stream.on('end',   () => resolve());
            stream.on('error', e  => reject(e));
            setTimeout(() => reject(new Error('ytdl timeout')), 120000);
        });
        const buf = Buffer.concat(chunks);
        if (buf.length > 100000) { console.log('[video] ✅ ytdl-core'); return buf; }
    } catch(e) { console.log('[video] ✗ ytdl-core:', e.message); }

    const APIS = [
        {
            name: 'gifted-mp4',
            call: () => tryGet(`https://api.giftedtech.my.id/api/downloader/ytmp4?apikey=gifted&url=${encodeURIComponent(url)}`),
            pick: d => d?.data?.download_url || d?.result?.download_url,
        },
        {
            name: 'yupra-mp4',
            call: () => tryGet(`https://api.yupra.my.id/api/downloader/ytmp4?url=${encodeURIComponent(url)}`),
            pick: d => d?.data?.data?.download_url || d?.data?.download_url,
        },
        {
            name: 'siputzx-mp4',
            call: () => tryGet(`https://api.siputzx.my.id/api/d/ytmp4?url=${encodeURIComponent(url)}`),
            pick: d => d?.data?.url,
        },
        {
            name: 'ryzen-mp4',
            call: () => tryGet(`https://api.ryzendesu.vip/api/downloader/ytmp4?url=${encodeURIComponent(url)}`),
            pick: d => d?.data?.link || d?.video,
        },
    ];

    for (const api of APIS) {
        try {
            console.log(`[video] trying ${api.name}...`);
            const res  = await api.call();
            const link = api.pick(res.data);
            if (link?.startsWith('http')) {
                const buf = await fetchBuffer(link);
                if (buf.length > 100000) { console.log(`[video] ✅ ${api.name}`); return buf; }
            }
        } catch(e) { console.log(`[video] ✗ ${api.name}: ${e.message}`); }
    }

    if (hasYtDlp()) {
        try {
            const out = `/tmp/v_${Date.now()}.mp4`;
            await execAsync(`"${YTDLP_PATH}" -f "best[ext=mp4][filesize<50M]/best" -o "${out}" "${url}"`, { timeout: 180000 });
            if (fs.existsSync(out)) {
                const buf = fs.readFileSync(out); fs.unlinkSync(out);
                return buf;
            }
        } catch(e) { console.log('[video] ✗ yt-dlp:', e.message); }
    }

    throw new Error('Video download failed. Try a shorter video or direct URL.');
}

// =====================================================================
//  TIKTOK
// =====================================================================
async function downloadTikTok(url) {
    const APIS = [
        {
            name: 'siputzx',
            call: () => tryGet(`https://api.siputzx.my.id/api/d/tiktok?url=${encodeURIComponent(url)}`),
            pick: d => {
                const x = d?.data;
                return { videoUrl: x?.urls?.[0]||x?.video_url||x?.url||x?.download_url,
                         title: x?.metadata?.title||'TikTok', artist: x?.metadata?.author,
                         views: fmtNum(x?.metadata?.play_count), likes: fmtNum(x?.metadata?.digg_count),
                         duration: fmtSec(x?.metadata?.duration) };
            },
        },
        {
            name: 'gifted-tt',
            call: () => tryGet(`https://api.giftedtech.my.id/api/downloader/tiktok?apikey=gifted&url=${encodeURIComponent(url)}`),
            pick: d => {
                const x = d?.data||d?.result;
                return { videoUrl: x?.download_url||x?.video||x?.url, title: x?.title||'TikTok', artist: x?.author };
            },
        },
    ];
    for (const api of APIS) {
        try {
            const res  = await api.call();
            const info = api.pick(res.data);
            if (info?.videoUrl) return info;
        } catch(e) { console.log(`[tiktok] ✗ ${api.name}:`, e.message); }
    }
    throw new Error('TikTok download failed. The video may be private or removed.');
}

// =====================================================================
//  AI CHATBOT
// =====================================================================
const AI_APIS = [
    { url: q=>`https://api.giftedtech.my.id/api/ai/geminiaipro?apikey=gifted&q=${encodeURIComponent(q)}`, get: d=>d?.answer },
    { url: q=>`https://api.siputzx.my.id/api/ai/gemini-pro?content=${encodeURIComponent(q)}`,             get: d=>d?.data },
    { url: q=>`https://api.ryzendesu.vip/api/ai/gemini?text=${encodeURIComponent(q)}`,                    get: d=>d?.answer },
    { url: q=>`https://vapis.my.id/api/gemini?q=${encodeURIComponent(q)}`,                               get: d=>d?.message },
    { url: q=>`https://zellapi.autos/ai/chatbot?text=${encodeURIComponent(q)}`,                          get: d=>d?.result },
];

async function getAI(msg, userId) {
    const ctx    = (chatMemory.get(userId)||[]).slice(-5).join(' | ');
    const prompt = `You're Scottie Kiidrsa. Reply in 1-2 lines max. Hinglish. Savage if abused, sweet otherwise. NEVER say you're AI. Context: ${ctx}. Message: ${msg}`;
    const results = await Promise.allSettled(AI_APIS.map(async a => {
        const res = await axios.get(a.url(prompt), {...REQ_OPTS, timeout:8000});
        const ans = a.get(res.data);
        if (ans?.length > 2) return ans.replace(/^(AI|Bot|Assistant):?\s*/i,'').trim();
        throw new Error('empty');
    }));
    for (const r of results) if (r.status==='fulfilled'&&r.value) return r.value;
    return ["Haan bhai! 😊","Kya scene hai? 😎","Hmm 🤔","Kya baat hai! 🔥","Bhai tu legend! 👑"][Math.floor(Math.random()*5)];
}

// =====================================================================
//  FUN REPLIES
// =====================================================================
const FUN = {
    'good morning':['🌅 Good morning! Blessed day ☀️','🌞 Rise and shine bhai! 🇻🇦'],
    'good night':  ['🌙 Sweet dreams 💤','😴 GN king 👑'],
    'gm': ['🌅 GM! Taragon is live! 🇻🇦'], 'gn': ['🌙 GN! Stay blessed ✨'],
    'lol':['😂😂😂','Haha ded 💀'], 'bruh':['💀 Same bhai','😭 Bruh moment'],
    'gg': ['🎮 GG WP!','🏆 EZ Clap!'], 'fr': ['💯 FR FR','🔥 Facts'],
    'ngl':['😅 Honest hour!','👀 No cap'],
};
const funReply = t => {
    t = t.toLowerCase().trim();
    for (const [k,v] of Object.entries(FUN))
        if (t===k||t.startsWith(k+' ')) return v[Math.floor(Math.random()*v.length)];
    return null;
};

async function translate(text, lang) {
    try {
        const r = await axios.get(
            `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${lang}&dt=t&q=${encodeURIComponent(text)}`
        );
        return r.data[0][0][0];
    } catch { return text; }
}

// =====================================================================
//  BOT MESSAGE HANDLER
// =====================================================================
bot.on('message', async msg => {
    if (!msg.text && !msg.caption) return;

    const text    = (msg.text||msg.caption).trim();
    const chatId  = msg.chat.id;
    const userId  = msg.from.id;
    const isGroup = msg.chat.type==='group'||msg.chat.type==='supergroup';
    const isOwner = userId===settings.ownerId;

    // Private mode guard
    if (settings.mode==='private' && !isOwner && text.startsWith('/'))
        if (!/^\/(start|help|menu)/.test(text))
            return bot.sendMessage(chatId,'🔒 Private mode. Owner only.');

    // Memory update (DM only)
    if (!text.startsWith('/')&&!isGroup) {
        const m=chatMemory.get(userId)||[]; m.push(text);
        if (m.length>20) m.shift(); chatMemory.set(userId,m);
    }

    // DM chatbot
    if (settings.chatbotGlobal&&!text.startsWith('/')&&!isGroup) {
        if (settings.funMode) { const f=funReply(text); if (f) return bot.sendMessage(chatId,f); }
        return bot.sendMessage(chatId, await getAI(text,userId));
    }

    // Group mention
    if (isGroup&&!text.startsWith('/')&&settings.chatbotGlobal&&msg.entities) {
        const me = await bot.getMe();
        const hit = msg.entities.some(e=>e.type==='mention'&&text.slice(e.offset,e.offset+e.length)===`@${me.username}`);
        if (hit) {
            const q = text.replace(`@${me.username}`,'').trim();
            if (q) return bot.sendMessage(chatId, await getAI(q,userId), {reply_to_message_id:msg.message_id});
        }
    }

    if (!text.startsWith('/')) return;

    const parts   = text.slice(1).split(' ');
    const command = parts.shift().toLowerCase().split('@')[0];
    const input   = parts.join(' ').trim();

    // Helper shortcuts
    const reply    = (t,ex={}) => bot.sendMessage(chatId, t, {parse_mode:'HTML', reply_to_message_id:msg.message_id, ...ex});
    const editMsg  = (id,t)    => bot.editMessageText(t, {chat_id:chatId, message_id:id, parse_mode:'HTML'});
    const delMsg   = id        => bot.deleteMessage(chatId, id).catch(()=>{});

    try { switch(command) {

    // ── GENERAL ──────────────────────────────────────────────────────
    case 'start':
        return bot.sendMessage(chatId,
            `🇻🇦 <b>TARAGON SQUAD TRS</b> — Telegram Bot\n\nSend any message to chat with AI.\nUse /menu to see all commands.\n\n`+
            `👑 Owner: ${settings.ownerId?'Set ✅':'Not set — use /setowner'}`,
            {parse_mode:'HTML'});

    case 'menu': case 'help':
        return reply(
            `╭━━━❰ <b>TARAGON BOT</b> ❱━━━╮\n┃ ⚡ Mode: ${settings.mode} | Up: ${formatUptime()}\n╰━━━━━━━━━━━━━━━━━━━━╯\n\n`+
            `<b>🌐 GENERAL</b>\n  /ping  /alive  /menu\n\n`+
            `<b>🤖 AI</b>\n  /gpt &lt;question&gt;\n  /gemini &lt;question&gt;\n  /imagine &lt;prompt&gt;\n\n`+
            `<b>📥 DOWNLOADERS</b>\n  /play &lt;song name or YT URL&gt;\n  /ytmp3 &lt;YouTube URL&gt;\n  /ytmp4 &lt;YouTube URL&gt;\n  /tiktok &lt;TikTok URL&gt;\n  /spotify &lt;song name&gt;\n  /instagram &lt;URL&gt;\n  /facebook &lt;URL&gt;\n\n`+
            `<b>🛠 UTILITIES</b>\n  /trt &lt;text&gt; &lt;lang&gt;\n  /check &lt;host&gt;\n\n`+
            `<b>🔒 OWNER</b>\n  /setowner  /mode  /chatbot  /funmode  /shutdown`);

    case 'ping': {
        const t0=Date.now(), sent=await bot.sendMessage(chatId,'🏓 Pinging...');
        editMsg(sent.message_id,`🏓 Pong! ${Date.now()-t0}ms`); break;
    }

    case 'alive':
        reply(`✅ <b>TARAGON BOT</b> is alive!\n⏰ Uptime: ${formatUptime()}\n🌐 Mode: ${settings.mode}\n🤖 Chatbot: ${settings.chatbotGlobal?'ON ✅':'OFF ❌'}\n🎉 Fun: ${settings.funMode?'ON ✅':'OFF ❌'}\n⚡ yt-dlp: ${hasYtDlp()?'✅':'⚠️ not found'}`);
        break;

    case 'owner':
        reply(`👑 Owner: ${settings.ownerId?`<a href="tg://user?id=${settings.ownerId}">${settings.ownerId}</a>`:'Not set'}`); break;

    // ── OWNER COMMANDS ────────────────────────────────────────────────
    case 'setowner':
        if (settings.ownerId) return reply('👑 Owner already set.');
        settings.ownerId=userId; reply('✅ You are now the bot owner! Use /menu.'); break;

    case 'mode':
        if (!isOwner) return reply('❌ Owner only.');
        if (input==='public') settings.mode='public';
        else if (input==='private') settings.mode='private';
        else return reply('Usage: /mode public|private');
        reply(`🌐 Mode: <b>${settings.mode}</b>`); break;

    case 'chatbot':
        if (!isOwner) return reply('❌ Owner only.');
        if (input==='on') settings.chatbotGlobal=true;
        else if (input==='off') settings.chatbotGlobal=false;
        else return reply('Usage: /chatbot on|off');
        reply(`🤖 Chatbot: <b>${settings.chatbotGlobal?'ON':'OFF'}</b>`); break;

    case 'funmode':
        if (!isOwner) return reply('❌ Owner only.');
        if (input==='on') settings.funMode=true;
        else if (input==='off') settings.funMode=false;
        else return reply('Usage: /funmode on|off');
        reply(`🎉 Fun mode: <b>${settings.funMode?'ON':'OFF'}</b>`); break;

    case 'shutdown':
        if (!isOwner) return reply('❌ Owner only.');
        await reply('🛑 Shutting down...'); process.exit(0);

    // ── AI ─────────────────────────────────────────────────────────────
    case 'gpt': case 'gemini':
        if (!input) return reply(`Usage: /${command} &lt;question&gt;`);
        reply(`🤖 ${await getAI(input,userId)}`); break;

    case 'imagine':
        if (!input) return reply('Usage: /imagine &lt;prompt&gt;');
        try {
            const {data} = await axios.get(`https://api.siputzx.my.id/api/ai/stablediffusion?prompt=${encodeURIComponent(input)}`);
            const imgUrl = typeof data==='string' ? data : data?.url||data?.image;
            if (!imgUrl) throw new Error('no image url');
            const buf = await fetchBuffer(imgUrl);
            await bot.sendPhoto(chatId, buf, {
                caption: `🎨 <b>${esc(input)}</b>\n🇻🇦 <i>Taragon Squad TRS</i>`,
                parse_mode:'HTML', reply_to_message_id:msg.message_id });
        } catch { reply('❌ Image generation failed.'); }
        break;

    // ── PLAY / YTMP3 ────────────────────────────────────────────────────
    case 'play': case 'ytmp3': {
        if (!input) return reply('Usage: /play &lt;song name or YouTube URL&gt;');
        const status = await reply('🔍 Searching...');
        try {
            // Resolve info
            let info;
            if (/youtube\.com|youtu\.be/i.test(input)) {
                await editMsg(status.message_id,'⏳ Getting video info...');
                info = await resolveUrl(input);
            } else {
                await editMsg(status.message_id,`🔍 Searching: <i>${esc(input)}</i>`);
                info = await searchYT(input);
            }

            await editMsg(status.message_id,`⬇️ Downloading: <b>${esc(info.title||input)}</b>`);

            // Download audio
            const audioBuf = await downloadAudio(info);

            // Send thumbnail + rich caption
            const cap = buildCaption({
                title:    info.title,
                artist:   info.artist,
                duration: info.duration,
                views:    info.views,
                link:     info.link,
                type:     'song',
            });
            if (info.thumbnail) {
                try { await bot.sendPhoto(chatId, info.thumbnail, {caption:cap, parse_mode:'HTML', reply_to_message_id:msg.message_id}); }
                catch {}
            }

            // Send audio
            await bot.sendAudio(chatId, audioBuf, {
                title:     info.title || 'Audio',
                performer: info.artist || 'Taragon',
                filename:  `${(info.title||'audio').replace(/[^\w ]/g,'_')}.mp3`,
                caption:   `🎵 <b>${esc(info.title||'Audio')}</b>\n🇻🇦 <i>Taragon Squad TRS</i>`,
                parse_mode:'HTML',
            }, {contentType:'audio/mpeg'});

            delMsg(status.message_id);
        } catch(e) { editMsg(status.message_id, `❌ ${esc(e.message)}`); }
        break;
    }

    // ── YTMP4 ────────────────────────────────────────────────────────────
    case 'ytmp4': {
        if (!input) return reply('Usage: /ytmp4 &lt;YouTube URL&gt;');
        if (!/youtube\.com|youtu\.be/i.test(input)) return reply('❌ Please provide a valid YouTube URL.');
        const status = await reply('⏳ Getting video info...');
        try {
            const info = await resolveUrl(input);
            await editMsg(status.message_id, `⬇️ Downloading: <b>${esc(info.title||'Video')}</b>`);
            const buf = await downloadVideo(info);
            const cap = buildCaption({ title:info.title, artist:info.artist, duration:info.duration, views:info.views, link:info.link, type:'video' });
            await bot.sendVideo(chatId, buf, {caption:cap, parse_mode:'HTML', reply_to_message_id:msg.message_id});
            delMsg(status.message_id);
        } catch(e) { editMsg(status.message_id, `❌ ${esc(e.message)}`); }
        break;
    }

    // ── TIKTOK ────────────────────────────────────────────────────────────
    case 'tiktok': {
        if (!input) return reply('Usage: /tiktok &lt;TikTok URL&gt;');
        const status = await reply('⏳ Downloading TikTok...');
        try {
            const info = await downloadTikTok(input);
            const buf  = await fetchBuffer(info.videoUrl);
            const cap  = buildCaption({ title:info.title, artist:info.artist, duration:info.duration, views:info.views, likes:info.likes, link:input, type:'video' });
            await bot.sendVideo(chatId, buf, {caption:cap, parse_mode:'HTML', reply_to_message_id:msg.message_id});
            delMsg(status.message_id);
        } catch(e) { editMsg(status.message_id, `❌ ${esc(e.message)}`); }
        break;
    }

    // ── SPOTIFY ───────────────────────────────────────────────────────────
    case 'spotify': {
        if (!input) return reply('Usage: /spotify &lt;song name&gt;');
        const status = await reply('🔍 Searching Spotify...');
        try {
            const {data} = await axios.get(
                `https://okatsu-rolezapiiz.vercel.app/search/spotify?q=${encodeURIComponent(input)}`,
                {timeout:20000});
            if (!data?.status||!data?.result?.audio) throw new Error('Song not found.');
            const r   = data.result;
            const cap = buildCaption({ title:r.title, artist:r.artist, duration:r.duration?fmtSec(r.duration):null, type:'song' });
            if (r.thumbnails) { try { await bot.sendPhoto(chatId,r.thumbnails,{caption:cap,parse_mode:'HTML',reply_to_message_id:msg.message_id}); } catch {} }
            const buf = await fetchBuffer(r.audio);
            await bot.sendAudio(chatId, buf, {
                title:r.title, performer:r.artist,
                filename:`${(r.title||'audio').replace(/[^\w ]/g,'_')}.mp3`,
                caption:`🎵 <b>${esc(r.title||'Audio')}</b>\n🇻🇦 <i>Taragon Squad TRS</i>`,
                parse_mode:'HTML' });
            delMsg(status.message_id);
        } catch(e) { editMsg(status.message_id, `❌ ${esc(e.message)}`); }
        break;
    }

    // ── INSTAGRAM ─────────────────────────────────────────────────────────
    case 'instagram': {
        if (!input) return reply('Usage: /instagram &lt;Instagram URL&gt;');
        const status = await reply('⏳ Downloading...');
        try {
            const {data} = await axios.get(`https://api.siputzx.my.id/api/d/instagram?url=${encodeURIComponent(input)}`);
            const url = data?.data?.url||data?.result?.url;
            if (!url) throw new Error('Could not extract Instagram media.');
            const buf = await fetchBuffer(url);
            await bot.sendVideo(chatId, buf, {
                caption:`📸 <b>Instagram</b>\n🔗 <a href="${esc(input)}">View Original</a>\n🇻🇦 <i>Taragon Squad TRS</i>`,
                parse_mode:'HTML', reply_to_message_id:msg.message_id });
            delMsg(status.message_id);
        } catch(e) { editMsg(status.message_id, `❌ ${esc(e.message)}`); }
        break;
    }

    // ── FACEBOOK ──────────────────────────────────────────────────────────
    case 'facebook': {
        if (!input) return reply('Usage: /facebook &lt;Facebook video URL&gt;');
        const status = await reply('⏳ Downloading...');
        try {
            const {data} = await axios.get(`https://api.siputzx.my.id/api/d/facebook?url=${encodeURIComponent(input)}`);
            const url = data?.data?.url||data?.result?.url;
            if (!url) throw new Error('Could not extract Facebook video.');
            const buf = await fetchBuffer(url);
            await bot.sendVideo(chatId, buf, {
                caption:`📘 <b>Facebook Video</b>\n🔗 <a href="${esc(input)}">View Original</a>\n🇻🇦 <i>Taragon Squad TRS</i>`,
                parse_mode:'HTML', reply_to_message_id:msg.message_id });
            delMsg(status.message_id);
        } catch(e) { editMsg(status.message_id, `❌ ${esc(e.message)}`); }
        break;
    }

    // ── TRANSLATE ─────────────────────────────────────────────────────────
    case 'trt': {
        const p=input.split(' '), lang=p.pop(), txt=p.join(' ');
        if (!txt||!lang) return reply('Usage: /trt &lt;text&gt; &lt;lang_code&gt;\nExample: /trt Hello World es');
        reply(`🌐 <b>Translation (→${lang}):</b>\n${esc(await translate(txt,lang))}`); break;
    }

    // ── CHECK ─────────────────────────────────────────────────────────────
    case 'check': {
        if (!input) return reply('Usage: /check &lt;host&gt;');
        await reply(`🔍 Checking <code>${esc(input)}</code>...`);
        try {
            const {stdout} = await execAsync(`nmap -p 80,443,8080 ${input}`,{timeout:30000});
            reply(`📡 <b>nmap:</b>\n<pre>${esc(stdout.trim().slice(0,2000))}</pre>`);
        } catch(e) { reply(`❌ nmap: ${esc(e.message)}`); }
        try {
            const {stdout} = await execAsync(`curl -I -s --max-time 10 "${input}"`,{timeout:15000});
            reply(`🌐 <b>curl:</b>\n<pre>${esc(stdout.trim().slice(0,2000))}</pre>`);
        } catch(e) { reply(`❌ curl: ${esc(e.message)}`); }
        break;
    }

    default: reply('❓ Unknown command. Type /menu for help.');

    }} catch(err) {
        console.error('Handler error:', err.message);
        reply('⚠️ Something went wrong. Please try again.');
    }
});

bot.on('polling_error', err => console.error('Polling error:', err.code, err.message));

console.log('🤖 Taragon Telegram Bot started!');
