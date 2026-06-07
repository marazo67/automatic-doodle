// ======================== TARAGON TELEGRAM BOT ========================
// Install: npm install node-telegram-bot-api axios yt-search
// Run:     node bot.js
// ======================================================================

const TelegramBot = require('node-telegram-bot-api');
const axios      = require('axios');
const yts        = require('yt-search');
const fs         = require('fs');
const path       = require('path');
const http       = require('http');
const { exec, execFile } = require('child_process');
const { promisify } = require('util');
const execAsync      = promisify(exec);
const execFileAsync  = promisify(execFile);

// =====================================================================
//  RENDER FIX — bind to a port so Render doesn't kill the process
// =====================================================================
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('🤖 Taragon Bot is alive!');
}).listen(PORT, () => console.log(`✅ Keep-alive server on port ${PORT}`));

// =====================================================================
//  CONFIG
// =====================================================================
const TOKEN = process.env.BOT_TOKEN || '8838166170:AAGzpSpkuSzr01jn7KP5551VrhsS1xF6A9E';
if (!TOKEN) { console.error('❌ No BOT_TOKEN'); process.exit(1); }

const bot = new TelegramBot(TOKEN, { polling: true });
let settings = { mode:'public', chatbotGlobal:true, funMode:true, ownerId:null, admins:[] };
let startTime = Date.now();
const chatMemory = new Map();

// =====================================================================
//  UTILITIES
// =====================================================================
function escHtml(s) {
    return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
function fmtCount(n) {
    n = parseInt(n); if (!n||isNaN(n)) return null;
    if (n>=1e9) return (n/1e9).toFixed(1).replace(/\.0$/,'')+'B';
    if (n>=1e6) return (n/1e6).toFixed(1).replace(/\.0$/,'')+'M';
    if (n>=1e3) return (n/1e3).toFixed(1).replace(/\.0$/,'')+'K';
    return String(n);
}
function fmtDur(sec) {
    sec = parseInt(sec); if (!sec||isNaN(sec)) return null;
    const h=Math.floor(sec/3600), m=Math.floor((sec%3600)/60), s=sec%60;
    return h>0 ? `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`
               : `${m}:${String(s).padStart(2,'0')}`;
}
function formatUptime() {
    const u=Date.now()-startTime;
    return `${Math.floor(u/3600000)}h ${Math.floor((u%3600000)/60000)}m ${Math.floor((u%60000)/1000)}s`;
}
function buildCaption({ title, artist, duration, views, likes, link, type='song' }) {
    const icon = type==='video' ? '🎬' : '🎵';
    const lines = [`${icon} <b>${escHtml(title||'Unknown')}</b>`];
    if (artist)   lines.push(`👤 <b>Artist:</b> ${escHtml(artist)}`);
    if (duration) lines.push(`⏱ <b>Duration:</b> ${duration}`);
    if (views)    lines.push(`👁 <b>Views:</b> ${views}`);
    if (likes)    lines.push(`❤️ <b>Likes:</b> ${likes}`);
    if (link)     lines.push(`🔗 <a href="${escHtml(link)}">Open on YouTube</a>`);
    lines.push(`\n🇻🇦 <i>Taragon Squad TRS</i>`);
    return lines.join('\n');
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function retry(fn, attempts=3, delay=1500) {
    for (let i=1; i<=attempts; i++) {
        try { return await fn(); }
        catch(e) { if (i<attempts) await sleep(delay*i); else throw e; }
    }
}

const HTTP = { timeout:30000, headers:{'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36','Accept':'application/json'} };

async function downloadBuffer(url) {
    const res = await axios.get(url, { responseType:'arraybuffer', timeout:120000,
        headers:{'User-Agent':'Mozilla/5.0','Accept':'*/*'} });
    return Buffer.from(res.data);
}

// =====================================================================
//  SEARCH — yt-search with YouTube scraping fallback
// =====================================================================
async function searchYT(query) {
    // yt-search
    try {
        const r = await yts(query);
        const v = r?.videos?.[0];
        if (v?.url) return {
            url:       v.url,
            videoId:   v.videoId,
            title:     v.title,
            artist:    v.author?.name,
            duration:  v.timestamp,          // already "3:45"
            views:     fmtCount(v.views),
            thumbnail: v.thumbnail,
            link:      v.url,
        };
    } catch(e) { console.log('yt-search err:', e.message); }

    // Fallback: scrape YouTube search page
    try {
        const res = await axios.get(
            `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`,
            { timeout:15000, headers:{'User-Agent':'Mozilla/5.0','Accept-Language':'en-US'} }
        );
        const match = res.data.match(/"videoId":"([^"]+)","thumbnail".*?"title":\{"runs":\[\{"text":"([^"]+)"/);
        if (match) {
            const videoId = match[1], title = match[2];
            return {
                url: `https://www.youtube.com/watch?v=${videoId}`,
                videoId, title,
                artist:    null, duration: null, views: null,
                thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
                link:      `https://www.youtube.com/watch?v=${videoId}`,
            };
        }
    } catch(e) { console.log('YT scrape err:', e.message); }

    throw new Error('Could not find that song. Try with more specific keywords.');
}

async function getVideoMeta(url) {
    const vidId = url.match(/(?:v=|youtu\.be\/)([A-Za-z0-9_-]{11})/)?.[1];
    try {
        const r = await yts({ videoId: vidId });
        if (r?.title) return {
            title:     r.title,
            artist:    r.author?.name,
            duration:  r.timestamp,
            views:     fmtCount(r.views),
            thumbnail: r.thumbnail,
            link:      url,
        };
    } catch {}
    return { title:'Video', link:url,
             thumbnail: vidId ? `https://i.ytimg.com/vi/${vidId}/hqdefault.jpg` : null };
}

// =====================================================================
//  AUDIO DOWNLOAD — 10 API sources + yt-dlp fallback
// =====================================================================
async function downloadAudio(videoUrl, videoId) {
    const vid = videoId || videoUrl.match(/(?:v=|youtu\.be\/)([A-Za-z0-9_-]{11})/)?.[1];

    // All known working YT→MP3 APIs
    const APIS = [
        // gifted (reliable)
        { name:'gifted',
          get: ()=> axios.get(`https://api.giftedtech.my.id/api/downloader/ytmp3?apikey=gifted&url=${encodeURIComponent(videoUrl)}`, HTTP),
          extract: d => d?.data?.download_url || d?.result?.download_url },

        // siputzx
        { name:'siputzx-mp3',
          get: ()=> axios.get(`https://api.siputzx.my.id/api/d/ytmp3?url=${encodeURIComponent(videoUrl)}`, HTTP),
          extract: d => d?.data?.url || d?.data?.mp3 },

        // okatsu
        { name:'okatsu',
          get: ()=> axios.get(`https://okatsu-rolezapiiz.vercel.app/downloader/ytmp3?url=${encodeURIComponent(videoUrl)}`, HTTP),
          extract: d => d?.data?.dl || d?.result?.dl },

        // yupra
        { name:'yupra',
          get: ()=> axios.get(`https://api.yupra.my.id/api/downloader/ytmp3?url=${encodeURIComponent(videoUrl)}`, HTTP),
          extract: d => d?.data?.data?.download_url || d?.data?.download_url },

        // ryzen
        { name:'ryzen-mp3',
          get: ()=> axios.get(`https://api.ryzendesu.vip/api/downloader/ytmp3?url=${encodeURIComponent(videoUrl)}`, HTTP),
          extract: d => d?.data?.link || d?.audio },

        // zell
        { name:'zell-mp3',
          get: ()=> axios.get(`https://zellapi.autos/downloader/ytmp3?url=${encodeURIComponent(videoUrl)}`, HTTP),
          extract: d => d?.result?.download_url || d?.data?.url },

        // eliteprotech
        { name:'eliteprotech',
          get: ()=> axios.get(`https://eliteprotech-apis.zone.id/ytdown?url=${encodeURIComponent(videoUrl)}&format=mp3`, HTTP),
          extract: d => d?.data?.downloadURL },

        // ndownloader (uses videoId)
        ...(vid ? [{
          name:'ndownloader',
          get: ()=> axios.get(`https://ndownloader.com/api?id=${vid}&type=audio`, HTTP),
          extract: d => d?.url || d?.link
        }] : []),

        // ytdl.autos
        { name:'ytdl-autos',
          get: ()=> axios.post(`https://ytdl.autos/api/json`,
            { url: videoUrl, quality:'mp3' },
            { ...HTTP, headers:{...HTTP.headers,'Content-Type':'application/json'} }),
          extract: d => d?.url || d?.audio },

        // loader.to
        { name:'loader.to',
          get: ()=> axios.get(`https://loader.to/ajax/download.php?format=mp3&url=${encodeURIComponent(videoUrl)}`, HTTP),
          extract: d => d?.download_url || d?.url },
    ];

    for (const api of APIS) {
        try {
            console.log(`[audio] trying ${api.name}...`);
            const res = await retry(() => api.get(), 2, 1000);
            const url = api.extract(res.data);
            if (url && typeof url === 'string' && url.startsWith('http')) {
                console.log(`[audio] ✅ ${api.name} → ${url.substring(0,60)}`);
                const buf = await downloadBuffer(url);
                if (buf.length > 10000) return buf;   // valid audio
                console.log(`[audio] buffer too small (${buf.length}), skipping`);
            }
        } catch(e) { console.log(`[audio] ✗ ${api.name}: ${e.message}`); }
    }

    // Last resort: yt-dlp
    try {
        console.log('[audio] trying yt-dlp...');
        const out = `/tmp/audio_${Date.now()}.mp3`;
        await execAsync(
            `yt-dlp -x --audio-format mp3 --audio-quality 0 -o "${out}" "${videoUrl}"`,
            { timeout:120000 }
        );
        if (fs.existsSync(out)) {
            const buf = fs.readFileSync(out);
            fs.unlinkSync(out);
            console.log('[audio] ✅ yt-dlp');
            return buf;
        }
    } catch(e) { console.log('[audio] yt-dlp failed:', e.message); }

    throw new Error('❌ All download sources failed. YouTube may be blocking requests. Try again in a few minutes.');
}

// =====================================================================
//  VIDEO DOWNLOAD
// =====================================================================
async function downloadVideo(videoUrl, videoId) {
    const vid = videoId || videoUrl.match(/(?:v=|youtu\.be\/)([A-Za-z0-9_-]{11})/)?.[1];

    const APIS = [
        { name:'gifted-mp4',
          get: ()=> axios.get(`https://api.giftedtech.my.id/api/downloader/ytmp4?apikey=gifted&url=${encodeURIComponent(videoUrl)}`, HTTP),
          extract: d => d?.data?.download_url || d?.result?.download_url },

        { name:'yupra-mp4',
          get: ()=> axios.get(`https://api.yupra.my.id/api/downloader/ytmp4?url=${encodeURIComponent(videoUrl)}`, HTTP),
          extract: d => d?.data?.data?.download_url || d?.data?.download_url },

        { name:'okatsu-mp4',
          get: ()=> axios.get(`https://okatsu-rolezapiiz.vercel.app/downloader/ytmp4?url=${encodeURIComponent(videoUrl)}`, HTTP),
          extract: d => d?.result?.mp4 || d?.data?.dl },

        { name:'siputzx-mp4',
          get: ()=> axios.get(`https://api.siputzx.my.id/api/d/ytmp4?url=${encodeURIComponent(videoUrl)}`, HTTP),
          extract: d => d?.data?.url },

        { name:'ryzen-mp4',
          get: ()=> axios.get(`https://api.ryzendesu.vip/api/downloader/ytmp4?url=${encodeURIComponent(videoUrl)}`, HTTP),
          extract: d => d?.data?.link || d?.video },
    ];

    for (const api of APIS) {
        try {
            console.log(`[video] trying ${api.name}...`);
            const res = await retry(() => api.get(), 2, 1000);
            const url = api.extract(res.data);
            if (url && typeof url === 'string' && url.startsWith('http')) {
                console.log(`[video] ✅ ${api.name}`);
                const buf = await downloadBuffer(url);
                if (buf.length > 10000) return buf;
            }
        } catch(e) { console.log(`[video] ✗ ${api.name}: ${e.message}`); }
    }

    try {
        console.log('[video] trying yt-dlp...');
        const out = `/tmp/video_${Date.now()}.mp4`;
        await execAsync(
            `yt-dlp -f "best[ext=mp4][filesize<50M]/bestvideo[ext=mp4]+bestaudio[ext=m4a]/best" -o "${out}" "${videoUrl}"`,
            { timeout:180000 }
        );
        if (fs.existsSync(out)) {
            const buf = fs.readFileSync(out);
            fs.unlinkSync(out);
            return buf;
        }
    } catch(e) { console.log('[video] yt-dlp failed:', e.message); }

    throw new Error('❌ Video download failed. Try a shorter video or different URL.');
}

// =====================================================================
//  TIKTOK DOWNLOAD
// =====================================================================
async function downloadTikTok(url) {
    const APIS = [
        { name:'siputzx',
          get: ()=> axios.get(`https://api.siputzx.my.id/api/d/tiktok?url=${encodeURIComponent(url)}`, HTTP),
          extract: d => {
              const x = d?.data;
              return { videoUrl: x?.urls?.[0]||x?.video_url||x?.url||x?.download_url,
                       title: x?.metadata?.title||'TikTok', author: x?.metadata?.author,
                       views: fmtCount(x?.metadata?.play_count), likes: fmtCount(x?.metadata?.digg_count),
                       duration: x?.metadata?.duration ? fmtDur(x.metadata.duration) : null };
          }},
        { name:'gifted-tt',
          get: ()=> axios.get(`https://api.giftedtech.my.id/api/downloader/tiktok?apikey=gifted&url=${encodeURIComponent(url)}`, HTTP),
          extract: d => {
              const x = d?.data||d?.result;
              return { videoUrl: x?.download_url||x?.video||x?.url, title: x?.title||'TikTok', author: x?.author };
          }},
    ];
    for (const api of APIS) {
        try {
            const res = await retry(() => api.get(), 2, 1000);
            const info = api.extract(res.data);
            if (info?.videoUrl) return info;
        } catch(e) { console.log(`[tiktok] ✗ ${api.name}: ${e.message}`); }
    }
    throw new Error('TikTok download failed. The video may be private.');
}

// =====================================================================
//  AI
// =====================================================================
const AI_APIS = [
    { url: q=>`https://api.giftedtech.my.id/api/ai/geminiaipro?apikey=gifted&q=${encodeURIComponent(q)}`,   get: d=>d?.answer },
    { url: q=>`https://api.siputzx.my.id/api/ai/gemini-pro?content=${encodeURIComponent(q)}`,               get: d=>d?.data },
    { url: q=>`https://api.ryzendesu.vip/api/ai/gemini?text=${encodeURIComponent(q)}`,                      get: d=>d?.answer },
    { url: q=>`https://vapis.my.id/api/gemini?q=${encodeURIComponent(q)}`,                                  get: d=>d?.message },
    { url: q=>`https://zellapi.autos/ai/chatbot?text=${encodeURIComponent(q)}`,                             get: d=>d?.result },
];
async function getAI(msg, userId) {
    const ctx = (chatMemory.get(userId)||[]).slice(-5).join(' | ');
    const prompt = `You're Scottie Kiidrsa. Reply in 1-2 lines max. Hinglish. Savage if abused, sweet otherwise. NEVER say you're AI. Context: ${ctx}. Message: ${msg}`;
    const results = await Promise.allSettled(AI_APIS.map(async a => {
        const res = await axios.get(a.url(prompt), {...HTTP, timeout:8000});
        const ans = a.get(res.data);
        if (ans && ans.length > 2) return ans.replace(/^(AI|Bot|Assistant):?\s*/i,'').trim();
        throw new Error('empty');
    }));
    for (const r of results) if (r.status==='fulfilled' && r.value) return r.value;
    const fb = ["Haan bhai! 😊","Kya scene hai? 😎","Hmm 🤔","Kya baat hai! 🔥","Bhai tu legend hai! 👑"];
    return fb[Math.floor(Math.random()*fb.length)];
}

// =====================================================================
//  FUN REPLIES
// =====================================================================
const FUN = {
    'good morning':['🌅 Good morning! Blessed day! ☀️','🌞 Rise and shine bhai! 🇻🇦'],
    'good night':  ['🌙 Sweet dreams! 💤','😴 Good night king 👑'],
    'gm':['🌅 GM! Taragon squad live! 🇻🇦'], 'gn':['🌙 GN! Stay blessed! ✨'],
    'lol':['😂😂😂','Haha bhai ded 💀'], 'bruh':['💀 Same bhai','😭 Bruh moment'],
    'gg':['🎮 GG WP!','🏆 EZ Clap!'], 'fr':['💯 FR FR','🔥 Facts'],
    'ngl':['😅 Honest hour!','👀 No cap'],
};
function funReply(t) {
    t = t.toLowerCase().trim();
    for (const [k,v] of Object.entries(FUN))
        if (t===k||t.startsWith(k+' ')) return v[Math.floor(Math.random()*v.length)];
    return null;
}

async function translate(text, lang) {
    try {
        const r = await axios.get(`https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${lang}&dt=t&q=${encodeURIComponent(text)}`);
        return r.data[0][0][0];
    } catch { return text; }
}

// =====================================================================
//  MESSAGE HANDLER
// =====================================================================
bot.on('message', async (msg) => {
    if (!msg.text && !msg.caption) return;
    const text    = (msg.text||msg.caption).trim();
    const chatId  = msg.chat.id;
    const userId  = msg.from.id;
    const isGroup = msg.chat.type==='group'||msg.chat.type==='supergroup';
    const isOwner = userId===settings.ownerId;

    if (settings.mode==='private' && !isOwner && text.startsWith('/'))
        if (!/^\/(start|help|menu)/.test(text))
            return bot.sendMessage(chatId,'🔒 Private mode. Owner only.');

    if (!text.startsWith('/') && !isGroup) {
        const m = chatMemory.get(userId)||[];
        m.push(text); if (m.length>20) m.shift();
        chatMemory.set(userId, m);
    }

    // DM chatbot
    if (settings.chatbotGlobal && !text.startsWith('/') && !isGroup) {
        if (settings.funMode) { const f=funReply(text); if (f) return bot.sendMessage(chatId,f); }
        return bot.sendMessage(chatId, await getAI(text,userId));
    }

    // Group mention
    if (isGroup && !text.startsWith('/') && settings.chatbotGlobal && msg.entities) {
        const me = await bot.getMe();
        const mentioned = msg.entities.some(e=>e.type==='mention'&&text.slice(e.offset,e.offset+e.length)===`@${me.username}`);
        if (mentioned) {
            const clean = text.replace(`@${me.username}`,'').trim();
            if (clean) return bot.sendMessage(chatId, await getAI(clean,userId), {reply_to_message_id:msg.message_id});
        }
    }

    if (!text.startsWith('/')) return;

    const parts   = text.slice(1).split(' ');
    const command = parts.shift().toLowerCase().split('@')[0];
    const input   = parts.join(' ').trim();

    const reply = (t, extra={}) => bot.sendMessage(chatId, t,
        { parse_mode:'HTML', reply_to_message_id:msg.message_id, ...extra });

    try { switch (command) {

    case 'start':
        return bot.sendMessage(chatId,
            `🇻🇦 <b>TARAGON SQUAD TRS</b> — Telegram Bot\n\nSend any message to chat with AI.\nUse /menu to see all commands.\n\n👑 Owner: ${settings.ownerId?'Set ✅':'Not set — use /setowner'}`,
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
        bot.editMessageText(`🏓 Pong! ${Date.now()-t0}ms`,{chat_id:chatId,message_id:sent.message_id}); break;
    }
    case 'alive':
        reply(`✅ <b>TARAGON BOT</b> is alive!\n⏰ Uptime: ${formatUptime()}\n🌐 Mode: ${settings.mode}\n🤖 Chatbot: ${settings.chatbotGlobal?'ON ✅':'OFF ❌'}\n🎉 Fun: ${settings.funMode?'ON ✅':'OFF ❌'}`); break;

    case 'owner':
        reply(`👑 Owner: ${settings.ownerId?`<a href="tg://user?id=${settings.ownerId}">${settings.ownerId}</a>`:'Not set'}`); break;

    case 'setowner':
        if (settings.ownerId) return reply('👑 Owner already set.');
        settings.ownerId=userId;
        reply('✅ You are now the bot owner! Use /menu.'); break;

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

    case 'gpt': case 'gemini':
        if (!input) return reply(`Usage: /${command} &lt;question&gt;`);
        reply(`🤖 ${await getAI(input,userId)}`); break;

    case 'imagine':
        if (!input) return reply('Usage: /imagine &lt;prompt&gt;');
        try {
            const {data} = await axios.get(`https://api.siputzx.my.id/api/ai/stablediffusion?prompt=${encodeURIComponent(input)}`);
            const imgUrl = typeof data==='string' ? data : data?.url||data?.image;
            if (!imgUrl) throw new Error('no url');
            const buf = await downloadBuffer(imgUrl);
            await bot.sendPhoto(chatId, buf, {
                caption:`🎨 <b>${escHtml(input)}</b>\n🇻🇦 <i>Taragon Squad TRS</i>`,
                parse_mode:'HTML', reply_to_message_id:msg.message_id });
        } catch { reply('❌ Image generation failed. Try a different prompt.'); }
        break;

    // ---- PLAY / YTMP3 ----
    case 'play': case 'ytmp3': {
        if (!input) return reply('Usage: /play &lt;song name or YouTube URL&gt;');
        const statusMsg = await reply('🔍 Searching...');
        const editStatus = t => bot.editMessageText(t, {chat_id:chatId, message_id:statusMsg.message_id, parse_mode:'HTML'});

        try {
            // 1. Search / resolve video info
            let info;
            if (/youtube\.com|youtu\.be/i.test(input)) {
                await editStatus('⏳ Getting video info...');
                info = await getVideoMeta(input);
                info.url = input;
            } else {
                await editStatus(`🔍 Searching: <i>${escHtml(input)}</i>...`);
                info = await searchYT(input);
            }

            await editStatus(`⬇️ Downloading: <b>${escHtml(info.title||input)}</b>...`);

            // 2. Download audio
            const audioBuf = await downloadAudio(info.url, info.videoId);

            // 3. Send thumbnail with rich caption
            const cap = buildCaption({
                title:    info.title,
                artist:   info.artist,
                duration: info.duration,
                views:    info.views,
                link:     info.link,
                type:     'song',
            });

            if (info.thumbnail) {
                try {
                    await bot.sendPhoto(chatId, info.thumbnail,
                        {caption:cap, parse_mode:'HTML', reply_to_message_id:msg.message_id});
                } catch {}
            }

            // 4. Send audio file
            await bot.sendAudio(chatId, audioBuf, {
                title:     info.title || 'Audio',
                performer: info.artist || 'Taragon',
                filename:  `${(info.title||'audio').replace(/[^\w ]/g,'')}.mp3`,
                caption:   `🎵 <b>${escHtml(info.title||'Audio')}</b>\n🇻🇦 <i>Taragon Squad TRS</i>`,
                parse_mode:'HTML',
            }, {contentType:'audio/mpeg'});

            // clean up status
            bot.deleteMessage(chatId, statusMsg.message_id).catch(()=>{});
        } catch(e) {
            editStatus(`❌ ${escHtml(e.message)}`);
        }
        break;
    }

    // ---- YTMP4 ----
    case 'ytmp4': {
        if (!input) return reply('Usage: /ytmp4 &lt;YouTube URL&gt;');
        if (!/youtube\.com|youtu\.be/i.test(input)) return reply('❌ Please send a valid YouTube URL.');
        const statusMsg = await reply('⏳ Getting video info...');
        const editStatus = t => bot.editMessageText(t, {chat_id:chatId, message_id:statusMsg.message_id, parse_mode:'HTML'});
        try {
            const info = await getVideoMeta(input);
            await editStatus(`⬇️ Downloading: <b>${escHtml(info.title||'Video')}</b>...`);
            const buf = await downloadVideo(input, info.videoId);
            const cap = buildCaption({ title:info.title, artist:info.artist,
                duration:info.duration, views:info.views, link:info.link, type:'video' });
            await bot.sendVideo(chatId, buf, {caption:cap, parse_mode:'HTML', reply_to_message_id:msg.message_id});
            bot.deleteMessage(chatId, statusMsg.message_id).catch(()=>{});
        } catch(e) { editStatus(`❌ ${escHtml(e.message)}`); }
        break;
    }

    // ---- TIKTOK ----
    case 'tiktok': {
        if (!input) return reply('Usage: /tiktok &lt;TikTok URL&gt;');
        const statusMsg = await reply('⏳ Downloading TikTok...');
        const editStatus = t => bot.editMessageText(t, {chat_id:chatId, message_id:statusMsg.message_id, parse_mode:'HTML'});
        try {
            const info = await downloadTikTok(input);
            const buf = await downloadBuffer(info.videoUrl);
            const cap = buildCaption({ title:info.title, artist:info.author,
                duration:info.duration, views:info.views, likes:info.likes,
                link:input, type:'video' });
            await bot.sendVideo(chatId, buf, {caption:cap, parse_mode:'HTML', reply_to_message_id:msg.message_id});
            bot.deleteMessage(chatId, statusMsg.message_id).catch(()=>{});
        } catch(e) { editStatus(`❌ ${escHtml(e.message)}`); }
        break;
    }

    // ---- SPOTIFY ----
    case 'spotify': {
        if (!input) return reply('Usage: /spotify &lt;song name&gt;');
        const statusMsg = await reply('🔍 Searching Spotify...');
        const editStatus = t => bot.editMessageText(t, {chat_id:chatId, message_id:statusMsg.message_id, parse_mode:'HTML'});
        try {
            const {data} = await axios.get(
                `https://okatsu-rolezapiiz.vercel.app/search/spotify?q=${encodeURIComponent(input)}`,{timeout:20000});
            if (!data?.status||!data?.result?.audio) throw new Error('Song not found on Spotify source.');
            const r = data.result;
            const cap = buildCaption({ title:r.title, artist:r.artist,
                duration: r.duration ? fmtDur(r.duration) : null, type:'song' });
            if (r.thumbnails) { try { await bot.sendPhoto(chatId,r.thumbnails,{caption:cap,parse_mode:'HTML',reply_to_message_id:msg.message_id}); } catch {} }
            const buf = await downloadBuffer(r.audio);
            await bot.sendAudio(chatId, buf, {
                title:r.title, performer:r.artist,
                filename:`${(r.title||'audio').replace(/[^\w ]/g,'')}.mp3`,
                caption:`🎵 <b>${escHtml(r.title||'Audio')}</b>\n🇻🇦 <i>Taragon Squad TRS</i>`,
                parse_mode:'HTML' });
            bot.deleteMessage(chatId, statusMsg.message_id).catch(()=>{});
        } catch(e) { editStatus(`❌ ${escHtml(e.message)}`); }
        break;
    }

    // ---- INSTAGRAM ----
    case 'instagram': {
        if (!input) return reply('Usage: /instagram &lt;Instagram URL&gt;');
        const statusMsg = await reply('⏳ Downloading Instagram...');
        const editStatus = t => bot.editMessageText(t, {chat_id:chatId, message_id:statusMsg.message_id, parse_mode:'HTML'});
        try {
            const {data} = await axios.get(`https://api.siputzx.my.id/api/d/instagram?url=${encodeURIComponent(input)}`);
            const url = data?.data?.url || data?.result?.url;
            if (!url) throw new Error('Could not extract Instagram media.');
            const buf = await downloadBuffer(url);
            await bot.sendVideo(chatId, buf, {
                caption:`📸 <b>Instagram</b>\n🔗 <a href="${escHtml(input)}">View Original</a>\n🇻🇦 <i>Taragon Squad TRS</i>`,
                parse_mode:'HTML', reply_to_message_id:msg.message_id });
            bot.deleteMessage(chatId, statusMsg.message_id).catch(()=>{});
        } catch(e) { editStatus(`❌ ${escHtml(e.message)}`); }
        break;
    }

    // ---- FACEBOOK ----
    case 'facebook': {
        if (!input) return reply('Usage: /facebook &lt;Facebook video URL&gt;');
        const statusMsg = await reply('⏳ Downloading Facebook video...');
        const editStatus = t => bot.editMessageText(t, {chat_id:chatId, message_id:statusMsg.message_id, parse_mode:'HTML'});
        try {
            const {data} = await axios.get(`https://api.siputzx.my.id/api/d/facebook?url=${encodeURIComponent(input)}`);
            const url = data?.data?.url || data?.result?.url;
            if (!url) throw new Error('Could not extract Facebook video.');
            const buf = await downloadBuffer(url);
            await bot.sendVideo(chatId, buf, {
                caption:`📘 <b>Facebook Video</b>\n🔗 <a href="${escHtml(input)}">View Original</a>\n🇻🇦 <i>Taragon Squad TRS</i>`,
                parse_mode:'HTML', reply_to_message_id:msg.message_id });
            bot.deleteMessage(chatId, statusMsg.message_id).catch(()=>{});
        } catch(e) { editStatus(`❌ ${escHtml(e.message)}`); }
        break;
    }

    // ---- TRT ----
    case 'trt': {
        const p = input.split(' '); const lang = p.pop(); const txt = p.join(' ');
        if (!txt||!lang) return reply('Usage: /trt &lt;text&gt; &lt;lang_code&gt;\nExample: /trt Hello World es');
        const out = await translate(txt, lang);
        reply(`🌐 <b>Translation (→${lang}):</b>\n${escHtml(out)}`); break;
    }

    // ---- CHECK ----
    case 'check': {
        if (!input) return reply('Usage: /check &lt;host&gt;');
        const host = input.trim();
        await reply(`🔍 Checking <code>${escHtml(host)}</code>...`);
        try {
            const {stdout} = await execFileAsync('nmap',['-p','80,443,8080',host],{timeout:30000});
            reply(`📡 <b>nmap:</b>\n<pre>${escHtml(stdout.trim().substring(0,2000))}</pre>`);
        } catch(e) { reply(`❌ nmap: ${escHtml(e.message)}`); }
        try {
            const {stdout} = await execAsync(`curl -I -s --max-time 10 "${host}"`,{timeout:15000});
            reply(`🌐 <b>curl:</b>\n<pre>${escHtml(stdout.trim().substring(0,2000))}</pre>`);
        } catch(e) { reply(`❌ curl: ${escHtml(e.message)}`); }
        break;
    }

    default: reply('❓ Unknown command. Type /menu for help.');

    }} catch(err) {
        console.error('Handler error:', err);
        reply('⚠️ Something went wrong. Please try again.');
    }
});

bot.on('polling_error', err => console.error('Polling error:', err.code, err.message));

function formatUptime() {
    const u=Date.now()-startTime;
    return `${Math.floor(u/3600000)}h ${Math.floor((u%3600000)/60000)}m ${Math.floor((u%60000)/1000)}s`;
}

console.log('🤖 Taragon Telegram Bot started!');
console.log('📩 Send /start to your bot to begin.');
