// Turns the single-file build into a page body for publishing as a Claude
// artifact: the host supplies <!doctype>, <html>, <head> and <body> itself.
import { readFileSync, writeFileSync } from 'node:fs';

const html = readFileSync('dist/index.html', 'utf8');
const head = html.match(/<head>([\s\S]*?)<\/head>/)?.[1] ?? '';
const body = html.match(/<body>([\s\S]*?)<\/body>/)?.[1] ?? '';
const headKept = head
  .replace(/<meta charset[^>]*>/i, '')
  .replace(/<meta name="viewport"[^>]*>/i, '')
  .trim();
writeFileSync('dist/glidepath.html', `${headKept}\n${body.trim()}\n`);
console.log('wrote dist/glidepath.html');
