import test from 'node:test';
import assert from 'node:assert/strict';
import {exemptions, logViolations, serverCode} from '../default/logs.mjs';

// The findings for a repository of the given files.
const scan = (tree, {repository = 'romaine-life/probe', list = []} = {}) =>
  logViolations(Object.keys(tree), file => tree[file] ?? null, {repository, list}).map(f => `${f.file}:${f.line}`);

test('Go: the log package and its kin are flagged, logline is not', () => {
  assert.deepEqual(scan({
    'main.go': 'package main\n\nimport (\n\t"fmt"\n\t"log"\n)\n\nfunc main() { log.Fatal(fmt.Errorf("x")) }\n',
    'svc.go': 'package main\n\nimport "log/slog"\n\nfunc f() { slog.Info("x") }\n',
    'ok.go': 'package main\n\nimport "github.com/romaine-life/logline"\n\nvar log = logline.Open("x", "X_LOG")\n\nfunc g() { log.Warn("not the log package") }\n',
    'words.go': 'package main\n\nvar names = []string{\n\t"log",\n}\n'
  }), ['main.go:5', 'svc.go:3']);
});

test('Go: a .log file appended to by hand is flagged; one written through logline is not', () => {
  assert.deepEqual(scan({
    'log.go': 'package main\n\nfunc open() {\n\tpath := filepath.Join(dir, "app.log")\n\tos.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)\n}\n',
    'runs.go': 'package main\n\nimport "github.com/romaine-life/logline"\n\nfunc save() {\n\tos.OpenFile("runs.log", os.O_APPEND|os.O_CREATE, 0o644)\n\t_ = logline.Format\n}\n',
    'copy.go': 'package main\n\nfunc write() { os.OpenFile(day, os.O_APPEND, 0o644) }\n'
  }), ['log.go:5']);
});

test('tests are never scanned', () => {
  assert.deepEqual(scan({
    'main_test.go': 'package main\n\nimport "log"\n',
    'tests/smoke.sh': 'echo hi >> "$LOG"\n',
    'Tests/Thing.cs': 'File.AppendAllText("x.log", "y");\n',
    'backend/app.test.js': 'console.log("x")\n'
  }), []);
});

test('Rust: logging crates, backends of its own and hand-written .log files are flagged', () => {
  assert.deepEqual(scan({
    'Cargo.toml': '[package]\nname = "x"\n\n[dependencies]\nlog = "0.4"\ntracing-subscriber = "0.3"\n\n[dev-dependencies]\nenv_logger = "0.11"\n\n[target.\'cfg(windows)\'.dependencies.simplelog]\nversion = "0.12"\n',
    'src/main.rs': 'fn main() {\n    tracing_subscriber::fmt().init();\n}\n',
    'src/log.rs': 'fn w() {\n    let p = dir.join("app.log");\n    OpenOptions::new().append(true).open(p);\n}\nimpl log::Log for Mine {}\n',
    'src/bridge.rs': 'impl log::Log for Bridge {}\nfn f() { logline::Logger::open_file("x.log"); std::fs::File::create("y.log"); }\n',
    'src/layer.rs': 'use bevy::log::tracing_subscriber::Layer;\nimpl<S> tracing_subscriber::Layer<S> for ToLogline { fn on_event(&self) { logline::Logger::open("x", "X_LOG"); } }\n',
    'src/both.rs': 'fn f() { logline::Logger::open("x", "X_LOG"); env_logger::init(); }\n'
  }), ['Cargo.toml:6', 'Cargo.toml:11', 'src/both.rs:1', 'src/log.rs:3', 'src/log.rs:5', 'src/main.rs:2']);
});

test('Node: console and logging packages are flagged only in what the image runs', () => {
  const tree = {
    'Dockerfile': 'FROM node:22\nWORKDIR /app\nCOPY . .\nENTRYPOINT ["node", "backend/supervisor.js"]\n',
    'backend/supervisor.js': "import {fork} from 'node:child_process';\nfork(new URL('./server.js', import.meta.url));\n",
    'backend/server.js': "import morgan from 'morgan';\nimport {routes} from './routes/index.js';\nconsole.log('listening');\n",
    'backend/routes/index.js': "export const routes = 1;\n// console.log('a comment');\nconsole.error('route failed');\n",
    'backend/scripts/migrate.mjs': "console.log('a hand-run script reports to its terminal');\n",
    'frontend/src/app.js': "console.log('the browser');\n"
  };
  assert.deepEqual([...serverCode(Object.keys(tree), f => tree[f])].sort(), ['backend/routes/index.js', 'backend/server.js', 'backend/supervisor.js']);
  assert.deepEqual(scan(tree), ['backend/routes/index.js:3', 'backend/server.js:1', 'backend/server.js:3']);
});

test('Node: a TypeScript service is followed from its source', () => {
  assert.deepEqual(scan({
    'Dockerfile': 'ENTRYPOINT ["node", "dist/entry.js"]\n',
    'src/entry.ts': "import {serve} from './server.js';\nserve();\n",
    'src/server.ts': "export function serve() { console.warn('x'); }\n"
  }), ['src/server.ts:1']);
});

test('C#: hand-appended .log files, and Console.Error in a library, are flagged', () => {
  assert.deepEqual(scan({
    'Mod/Mod.csproj': '<Project><PropertyGroup><TargetFramework>net9.0</TargetFramework></PropertyGroup></Project>',
    'Mod/Diag.cs': 'class D { void W(string m) { File.AppendAllText(Path.Combine(dir, "diag.log"), m); Console.Error.WriteLine(m); } }\n',
    'Tool/Tool.csproj': '<Project><PropertyGroup><OutputType>Exe</OutputType></PropertyGroup></Project>',
    'Tool/Program.cs': 'class P { static void Main() { Console.Error.WriteLine("usage"); } }\n'
  }), ['Mod/Diag.cs:1', 'Mod/Diag.cs:1']);
});

test('PowerShell: appends to a log and transcripts are flagged', () => {
  assert.deepEqual(scan({
    'a.ps1': "Add-Content -LiteralPath $LogFile -Value $line\n'x' | Out-File -Append C:\\x\\run.log\n# Add-Content $log 'commented'\nAdd-Content -Path $catalog -Value 1\nSet-Content $log 'overwrites, a report'\nStart-Transcript -Path $p\n'x' >> $env:GITHUB_OUTPUT\n"
  }), ['a.ps1:1', 'a.ps1:2', 'a.ps1:6']);
});

test('bash: appends to a log are flagged, captured output is not', () => {
  assert.deepEqual(scan({
    'nas/backup.sh': 'held 2>>"$LOG"\nrclone sync 2>&1 | tee -a "$LOG"\necho done >> /volume1/x/run.log\ntofu plan > "$W/plan.log" 2>&1\necho ok >> "$GITHUB_OUTPUT"\n'
  }), ['nas/backup.sh:1', 'nas/backup.sh:2', 'nas/backup.sh:3']);
});

test('an exemption covers its paths, or its whole repository, and nothing else', () => {
  const tree = {'main.go': 'package main\n\nimport "log"\n', 'cmd/x/main.go': 'package main\n\nimport "log"\n'};
  const list = [{repo: 'romaine-life/probe', paths: ['cmd/**'], reason: 'r'}, {repo: 'romaine-life/other', reason: 'r'}];
  assert.deepEqual(scan(tree, {list}), ['main.go:3']);
  assert.deepEqual(scan(tree, {repository: 'romaine-life/other', list}), []);
});

test('every exemption says why', () => {
  for (const e of exemptions()) {
    assert.match(e.repo, /^[\w.-]+\/[\w.-]+$/, JSON.stringify(e));
    assert.ok(e.reason && e.reason.length > 20, `${e.repo}: a reason`);
    assert.ok(!e.paths || e.paths.length > 0, `${e.repo}: paths, or none for the whole repository`);
  }
});
