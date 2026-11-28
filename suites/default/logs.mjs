import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {readJSON, suites, tracked} from '../lib.mjs';
import {currentRepository} from '../config.mjs';
import {matches, unshipped} from '../input-patterns.mjs';

// The estate's one log line is logline's (AHT-204, at-home-tools docs/app-logs.md): a
// program writes it with the logline library of its language, a script with the logline
// command. This check fails a pull request whose code writes a log another way. What it
// doesn't hold (upstream code in a fork, the standard's own implementation) is listed,
// each entry with its reason, in log-exemptions.json beside it, the one list; a
// repository's own files never exempt themselves.
export const exemptionsFile = path.join(suites, 'default', 'log-exemptions.json');
export const exemptions = (file = exemptionsFile) => readJSON(file).exemptions;

// Tests can't write a shipped log; nor can what's vendored, or the suites' own checkout.
const skipped = [...unshipped, '**/node_modules/**', 'vendor/**', '_ci/**'];
export function exempt(file, repository, list) {
  return list.some(e => e.repo.toLowerCase() === repository.toLowerCase() && (!e.paths || e.paths.some(p => matches(file, p))));
}

const docs = 'see docs/app-logs.md in romaine-life/at-home-tools';
const lineOf = (text, index) => text.slice(0, index).split('\n').length;
// A source's lines without its whole-line comments, kept in place so line numbers hold.
const uncommented = (text, marker) => text.split('\n').map(line => marker.test(line) ? '' : line).join('\n');
// A file that writes through logline (a backend handing the log crate's records to it, a
// run log of logline.Format lines appended in one write) is a bridge to it, not around it.
const usesLogline = {go: /"github\.com\/romaine-life\/logline"/, rust: /\blogline::/, js: /['"]@romaine-life\/logline['"]/};
const logFile = /["'`][^"'`\n]*\.log(?:\.old)?["'`]/;

function goFindings(file, text) {
  const found = [];
  const code = uncommented(text, /^\s*\/\//);
  // The imports come before the first declaration.
  const end = code.search(/^(?:func|type|var|const)\b/m);
  const imports = end < 0 ? code : code.slice(0, end);
  for (const m of imports.matchAll(/^\s*(?:import\s+)?(?:[\w.]+\s+)?"(log|log\/slog|github\.com\/sirupsen\/logrus|go\.uber\.org\/zap|github\.com\/rs\/zerolog)"\s*(?:\/\/.*)?$/gm)) {
    found.push({line: lineOf(code, m.index + m[0].indexOf('"')), what: `imports ${m[1]}: write the line with logline (logline.Open, or logline.New(os.Stdout) for a service); a command's error goes to stderr with fmt`});
  }
  if (logFile.test(code) && !usesLogline.go.test(code)) {
    for (const m of code.matchAll(/\bO_APPEND\b/g)) found.push({line: lineOf(code, m.index), what: 'appends to a .log file by hand: write it with logline.Open or logline.OpenFile'});
  }
  return found;
}

const rustCrates = ['tracing-subscriber', 'env-logger', 'pretty-env-logger', 'simplelog', 'flexi-logger', 'log4rs', 'fern', 'tracing-appender'];
function cargoFindings(file, text) {
  const found = [];
  let section = '';
  text.split('\n').forEach((line, i) => {
    const header = line.match(/^\s*\[([^\]]+)\]/);
    let crate = null;
    if (header) {
      section = header[1].trim();
      crate = section.match(/^(?:target\..+\.)?dependencies\.([\w-]+)$/)?.[1];
    } else if (/^(?:target\..+\.|workspace\.)?dependencies$/.test(section)) {
      // Dev and build dependencies are tests' and build scripts', never a shipped log.
      crate = line.match(/^\s*([\w-]+)\s*=/)?.[1];
    }
    if (crate && rustCrates.includes(crate.replace(/_/g, '-'))) found.push({line: i + 1, what: `depends on ${crate}: write the line with the logline crate (logline::Logger::open)`});
  });
  return found;
}

function rustFindings(file, text) {
  const found = [];
  const code = uncommented(text, /^\s*\/\//);
  // tracing_subscriber's Layer is the one way to hand tracing's events (Bevy's) to
  // another writer, so a file that writes them through logline is a bridge, as a log
  // backend is; the crates that write lines themselves are flagged wherever they are.
  const bridges = usesLogline.rust.test(code);
  for (const m of code.matchAll(/\b(tracing_subscriber|env_logger|pretty_env_logger|simplelog|flexi_logger|log4rs|fern|tracing_appender)::/g)) {
    if (bridges && m[1] === 'tracing_subscriber') continue;
    found.push({line: lineOf(code, m.index), what: `sets up ${m[1]}: write the line with the logline crate (logline::Logger::open)`});
  }
  for (const m of usesLogline.rust.test(code) ? [] : code.matchAll(/\b(?:log::)?set_(?:boxed_)?logger\s*\(|\bimpl\s+(?:log::)?Log\s+for\b/g)) {
    found.push({line: lineOf(code, m.index), what: 'a log backend of its own: write the line with the logline crate'});
  }
  if (logFile.test(code) && !usesLogline.rust.test(code)) {
    for (const m of code.matchAll(/\.append\(\s*true\s*\)|\bFile::create\s*\(/g)) found.push({line: lineOf(code, m.index), what: 'writes a .log file by hand: write it with the logline crate (logline::Logger::open)'});
  }
  return found;
}

// A Node service's code is what its image runs: the file each Dockerfile starts with node,
// and everything it reaches by a relative import, require or import(), or names as a
// relative script (a supervisor forking server.js).
const jsExtensions = ['', '.js', '.mjs', '.cjs', '.ts', '/index.js', '/index.mjs', '/index.ts'];
export function nodeEntries(files, read) {
  const entries = [];
  for (const dockerfile of files.filter(f => /(?:^|\/)(?:Dockerfile[^/]*|[^/]+\.Dockerfile)$/.test(f))) {
    const text = read(dockerfile) || '';
    for (const m of text.matchAll(/^\s*(?:ENTRYPOINT|CMD)\s*\[\s*"node"\s*,\s*"([^"]+)"/gm)) {
      const named = path.posix.normalize(m[1].replace(/^\.\//, '').replace(/^\/app\//, ''));
      // A TypeScript build runs dist/, compiled from src/.
      const candidates = [named, named.replace(/^dist\//, 'src/').replace(/\.js$/, '.ts'), named.replace(/^dist\//, 'src/')];
      const hit = candidates.find(c => files.includes(c));
      if (hit) entries.push(hit);
    }
  }
  return [...new Set(entries)];
}
function resolveJS(from, spec, files) {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
  for (const ext of jsExtensions) if (files.includes(base + ext)) return base + ext;
  if (/\.js$/.test(base) && files.includes(base.replace(/\.js$/, '.ts'))) return base.replace(/\.js$/, '.ts');
  return null;
}
export function serverCode(files, read) {
  const seen = new Set();
  const queue = nodeEntries(files, read);
  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    const text = read(file) || '';
    const specs = [
      ...[...text.matchAll(/\b(?:from|import|require\s*\(|import\s*\()\s*['"](\.{1,2}\/[^'"]+)['"]/g)].map(m => m[1]),
      ...[...text.matchAll(/['"]((?:\.{1,2}\/)?[\w./-]+\.(?:m?js|cjs|ts))['"]/g)].map(m => m[1].startsWith('.') ? m[1] : `./${m[1]}`)
    ];
    for (const spec of specs) {
      const next = resolveJS(file, spec, files);
      if (next && !skipped.some(p => matches(next, p))) queue.push(next);
    }
  }
  return seen;
}
function jsFindings(file, text, server) {
  const found = [];
  const code = uncommented(text, /^\s*(?:\/\/|\*|\/\*)/);
  if (server) {
    for (const m of code.matchAll(/\bconsole\.(log|error|warn|info|debug|trace)\s*\(/g)) found.push({line: lineOf(code, m.index), what: `console.${m[1]} in the service: write the line with @romaine-life/logline (Logger.stream(process.stdout))`});
    for (const m of code.matchAll(/(?:\bfrom\s+|\brequire\s*\(\s*|\bimport\s*\(\s*)['"](morgan|winston|pino|pino-http|bunyan|log4js)['"]/g)) found.push({line: lineOf(code, m.index), what: `uses ${m[1]}: write the line with @romaine-life/logline`});
  }
  if (logFile.test(code) && !usesLogline.js.test(code)) {
    for (const m of code.matchAll(/\bappendFile(?:Sync)?\s*\(|\bcreateWriteStream\s*\([^)]*flags\s*:\s*['"]a/g)) found.push({line: lineOf(code, m.index), what: 'appends to a .log file by hand: write it with @romaine-life/logline, or the logline command from a script'});
  }
  return found;
}

// A C# library (no OutputType Exe: a mod, a plugin) has no console of its own.
function nearestProject(file, files) {
  for (let dir = path.posix.dirname(file); ; dir = path.posix.dirname(dir)) {
    const project = files.find(f => path.posix.dirname(f) === dir && f.endsWith('.csproj'));
    if (project) return project;
    if (dir === '.' || dir === '/' || dir === '') return null;
  }
}
function csFindings(file, text, files, read) {
  const found = [];
  const code = uncommented(text, /^\s*\/\//);
  if (/"[^"\n]*\.log(?:\.old)?"/.test(code)) {
    for (const m of code.matchAll(/\bFile\.Append(?:AllText|AllLines|Text)\s*\(|\bFileMode\.Append\b|\bnew\s+StreamWriter\s*\([^)]*,\s*true\s*\)/g)) found.push({line: lineOf(code, m.index), what: 'appends to a .log file by hand: write it with logline (Logger.Open or Logger.OpenFile)'});
  }
  const project = nearestProject(file, files);
  if (project && !/<OutputType>\s*(?:Win)?Exe\s*<\/OutputType>/i.test(read(project) || '')) {
    for (const m of code.matchAll(/\bConsole\.Error\.Write(?:Line)?\s*\(/g)) found.push({line: lineOf(code, m.index), what: 'logs to Console.Error from a library, which has no console: write the line with logline (Logger.Open)'});
  }
  return found;
}

// A variable holding a log's path: a word of its name is log, logs, logfile or logpath
// ($LOG, $logFile, $errorLog), never a word that merely ends in it ($catalog).
const logVariable = name => name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[\s_:-]+/).some(w => /^log(?:s|file|path)?$/i.test(w));
function targetIsLog(target) {
  if (/\.log(?:\.old)?\b/.test(target)) return true;
  const variable = target.match(/^["']?\$\{?([\w:]+)\}?/);
  return Boolean(variable && logVariable(variable[1]));
}
function psFindings(file, text) {
  const found = [];
  const code = uncommented(text, /^\s*#/);
  code.split('\n').forEach((line, i) => {
    if (/\bStart-Transcript\b/i.test(line)) found.push({line: i + 1, what: 'Start-Transcript: write each event with the logline command'});
    const writes = [...line.matchAll(/\bAdd-Content\b(?:\s+-(?:Literal)?Path)?\s+(\S+)|>>\s*(\S+)|\[(?:System\.)?IO\.File\]::Append\w*\(\s*(\S+?)\s*,/gi)].map(m => m.slice(1).find(Boolean) || '');
    // Out-File -Append names its file anywhere among its arguments, up to the next pipe.
    for (const m of line.matchAll(/\bOut-File\b([^|]*)/gi)) if (/\s-Append\b/i.test(m[1])) writes.push(...m[1].trim().split(/\s+/));
    if (writes.some(targetIsLog)) found.push({line: i + 1, what: 'appends to a log file by hand: write each line with the logline command (logline --app or --file)'});
  });
  return found;
}
function shFindings(file, text) {
  const found = [];
  const code = uncommented(text, /^\s*#/);
  code.split('\n').forEach((line, i) => {
    const writes = [...line.matchAll(/(?:^|[^>&0-9])(?:[0-9&])?>>\s*(\S+)|\btee\s+(?:-a|--append)\s+(\S+)/g)];
    if (writes.some(m => targetIsLog(m[1] || m[2] || ''))) found.push({line: i + 1, what: 'appends to a log file by hand: write each line with the logline command (logline --file, --lines for a command\'s output)'});
  });
  return found;
}

// Every finding in a repository's files, as {file, line, what}.
export function logViolations(files, read, {repository, list = []} = {}) {
  const scanned = files.filter(f => !skipped.some(p => matches(f, p)) && !exempt(f, repository, list));
  const server = serverCode(files, read);
  const found = [];
  for (const file of scanned) {
    const text = (read(file) || '').replace(/\r\n/g, '\n');
    let hits = [];
    if (file.endsWith('.go')) hits = goFindings(file, text);
    else if (/(?:^|\/)Cargo\.toml$/.test(file)) hits = cargoFindings(file, text);
    else if (file.endsWith('.rs')) hits = rustFindings(file, text);
    else if (/\.(?:m?js|cjs|ts)$/.test(file) && !file.endsWith('.d.ts')) hits = jsFindings(file, text, server.has(file));
    else if (file.endsWith('.cs')) hits = csFindings(file, text, files, read);
    else if (/\.ps(?:m?1)$/.test(file) && !/\.Tests\.ps1$/i.test(file)) hits = psFindings(file, text);
    else if (/\.(?:sh|bash)$/.test(file)) hits = shFindings(file, text);
    for (const hit of hits) found.push({file, ...hit});
  }
  return found.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

export function main() {
  const repository = currentRepository();
  const read = file => fs.existsSync(file) && fs.statSync(file).isFile() ? fs.readFileSync(file, 'utf8') : null;
  const found = logViolations(tracked(), read, {repository, list: exemptions()});
  for (const f of found) console.error(`${f.file}:${f.line}: ${f.what}`);
  if (found.length) throw new Error(`${found.length} log writers outside logline (the estate's one log line, ${docs}); an exemption is an entry in pipeline-templates' suites/default/log-exemptions.json`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
