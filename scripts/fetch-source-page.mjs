import http from "node:http";
import https from "node:https";

// Avoid Undici's process-fatal parser assertion on interrupted agency responses.
export async function fetchSourcePage(url, { headers = {}, timeoutMs = 12000, maxBytes = 10000000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  async function requestPage(address, redirects) {
    const target = new URL(address);
    if (!['http:', 'https:'].includes(target.protocol)) throw new Error('Unsupported source protocol');
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`Timeout ${timeoutMs}ms`);
    const result = await new Promise((resolve, reject) => {
      const request = (target.protocol === 'https:' ? https : http).get(target, {
        agent: false,
        headers: { ...headers, 'Accept-Encoding': 'identity' }
      }, response => {
        response.on('error', reject);
        const status = response.statusCode;
        if ([301, 302, 303, 307, 308].includes(status) && response.headers.location) {
          response.resume();
          resolve({ redirect: new URL(response.headers.location, target).href });
          return;
        }
        if (status < 200 || status >= 300) {
          response.resume();
          reject(new Error(`HTTP ${status}`));
          return;
        }
        const chunks = [];
        let size = 0;
        response.on('data', chunk => {
          size += chunk.length;
          if (size > maxBytes) {
            const error = new Error('Source response too large');
            reject(error);
            request.destroy(error);
          }
          else chunks.push(chunk);
        });
        response.on('aborted', () => reject(new Error('Source response interrupted')));
        response.on('end', () => resolve({ text: Buffer.concat(chunks).toString('utf8'), finalUrl: target.href, status }));
      });
      const timer = setTimeout(() => request.destroy(new Error(`Timeout ${timeoutMs}ms`)), remaining);
      request.on('error', reject);
      request.on('close', () => clearTimeout(timer));
    });
    if (!result.redirect) return result;
    if (redirects >= 5) throw new Error('Too many source redirects');
    return requestPage(result.redirect, redirects + 1);
  }
  return requestPage(url, 0);
}
