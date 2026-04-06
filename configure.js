#!/usr/bin/env node
/**
 * configure.js — Frontend repo only. Run after editing public/config.js.
 * Patches ALL frontend files so you never edit URLs manually anywhere.
 *
 * Files patched:
 *   vercel.json         — connect-src CSP (backend host)
 *   public/index.html   — canonical, OG, Twitter, JSON-LD
 *   public/robots.txt   — sitemap URL
 *   public/sitemap.xml  — page URL + lastmod
 *
 * Usage:  node configure.js
 *
 * For the backend (Render), set ALLOWED_ORIGINS in the Render dashboard
 * under Environment — no file to edit there.
 */

'use strict';
const fs   = require('fs');
const path = require('path');

// ── Read config.js ────────────────────────────────────────────────────────────
const configSrc = fs.readFileSync(path.join(__dirname, 'public', 'config.js'), 'utf8');
const window = {};
eval(configSrc);
const cfg = window.APP_CONFIG;

if (!cfg || !cfg.BACKEND_URL || !cfg.SITE_URL) {
  console.error('ERROR: BACKEND_URL and SITE_URL must be set in public/config.js');
  process.exit(1);
}

const backendHost = new URL(cfg.BACKEND_URL).host;
const siteUrl     = cfg.SITE_URL.replace(/\/$/, '');  // no trailing slash
const today       = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

console.log('Reading config:');
console.log('  Backend:  ' + cfg.BACKEND_URL);
console.log('  Frontend: ' + siteUrl);
console.log('  App name: ' + cfg.APP_NAME);
console.log('');
console.log('Patching files...');

// ── Helper ────────────────────────────────────────────────────────────────────
function patch(relPath, transform) {
  const fullPath = path.join(__dirname, relPath);
  if (!fs.existsSync(fullPath)) {
    console.log('  (skipped — not found: ' + relPath + ')');
    return;
  }
  const original = fs.readFileSync(fullPath, 'utf8');
  const updated  = transform(original);
  fs.writeFileSync(fullPath, updated);
  const changed = updated !== original;
  console.log((changed ? '\u2713 ' : '  (no change) ') + relPath);
}

// ── vercel.json ───────────────────────────────────────────────────────────────
patch('vercel.json', function(src) {
  const json = JSON.parse(src);
  json.headers.forEach(function(h) {
    h.headers.forEach(function(hdr) {
      if (hdr.key === 'Content-Security-Policy') {
        hdr.value = hdr.value.replace(
          /connect-src[^;]*/,
          "connect-src 'self' wss://" + backendHost + " https://" + backendHost
        );
      }
    });
  });
  return JSON.stringify(json, null, 2) + '\n';
});

// ── public/index.html ─────────────────────────────────────────────────────────
patch('public/index.html', function(src) {
  return src
    .replace(/(<link rel="canonical" href=")[^"]*(")/,    '$1' + siteUrl + '$2')
    .replace(/(property="og:url"\s+content=")[^"]*(")/,   '$1' + siteUrl + '$2')
    .replace(/(property="og:image"\s+content=")[^"]*(")/,  '$1' + siteUrl + '/og-image.png$2')
    .replace(/(name="twitter:image"\s+content=")[^"]*(")/,'$1' + siteUrl + '/og-image.png$2')
    .replace(/"url": "https?:\/\/[^"]*"/,                  '"url": "' + siteUrl + '"');
});

// ── public/robots.txt ─────────────────────────────────────────────────────────
patch('public/robots.txt', function(src) {
  return src.replace(
    /Sitemap: https?:\/\/[^\r\n]+/,
    'Sitemap: ' + siteUrl + '/sitemap.xml'
  );
});

// ── public/sitemap.xml ────────────────────────────────────────────────────────
patch('public/sitemap.xml', function(src) {
  return src
    .replace(/<loc>https?:\/\/[^<]+<\/loc>/g, '<loc>' + siteUrl + '/<\/loc>')
    .replace(/<lastmod>[^<]+<\/lastmod>/g,     '<lastmod>' + today + '<\/lastmod>');
});

// ── Done ──────────────────────────────────────────────────────────────────────
console.log('');
console.log('All done!');
console.log('');
console.log('Reminder: set this in Render dashboard \u2192 Environment:');
console.log('  ALLOWED_ORIGINS = ' + siteUrl);
console.log('');
console.log('Then commit and deploy.');
