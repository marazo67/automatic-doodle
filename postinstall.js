// postinstall.js — runs automatically after "npm install"
// Downloads yt-dlp binary to ./bin/ without sudo or apt-get
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const { execSync } = require('child_process');

const BIN_DIR  = path.join(__dirname, 'bin');
const YTDLP    = path.join(BIN_DIR, 'yt-dlp');
const YTDLP_URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';

if (!fs.existsSync(BIN_DIR)) fs.mkdirSync(BIN_DIR, { recursive: true });

if (fs.existsSync(YTDLP)) {
    console.log('✅ yt-dlp already exists at', YTDLP);
    process.exit(0);
}

console.log('⬇️  Downloading yt-dlp binary (no sudo needed)...');

function download(url, dest, redirects=0) {
    if (redirects > 5) return console.error('Too many redirects');
    https.get(url, { headers:{'User-Agent':'node'} }, res => {
        if (res.statusCode === 302 || res.statusCode === 301) {
            return download(res.headers.location, dest, redirects+1);
        }
        if (res.statusCode !== 200) {
            console.error('❌ yt-dlp download failed, HTTP', res.statusCode);
            return;
        }
        const file = fs.createWriteStream(dest);
        res.pipe(file);
        file.on('finish', () => {
            file.close();
            fs.chmodSync(dest, 0o755);
            console.log('✅ yt-dlp installed at', dest);
            try {
                const ver = execSync(`"${dest}" --version`).toString().trim();
                console.log('📌 yt-dlp version:', ver);
            } catch {}
        });
    }).on('error', err => {
        console.error('❌ yt-dlp download error:', err.message);
        try { fs.unlinkSync(dest); } catch {}
    });
}

download(YTDLP_URL, YTDLP);
