import {capture, tracked} from '../lib.mjs';
const files = tracked().filter(f => f.endsWith('.go'));
for (let i = 0; i < files.length; i += 50) {
  const bad = capture('gofmt', ['-l', ...files.slice(i, i + 50)]);
  if (bad) throw new Error(`gofmt: ${bad}`);
}
