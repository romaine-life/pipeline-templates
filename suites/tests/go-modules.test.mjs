import test from 'node:test';
import assert from 'node:assert/strict';
import {consumers, ownModule, ownRequires, parseGoMod} from '../go/modules.mjs';

const goMod = `module github.com/romaine-life/fzt-terminal // the terminal

go 1.25

require github.com/romaine-life/fzt v0.2.1

require (
\tgithub.com/gdamore/tcell/v2 v2.7.0
\t"github.com/romaine-life/fzt-frontend" v0.1.40
\tgithub.com/romaine-life/auth v0.1.9 // indirect
\t// github.com/romaine-life/commented v0.1.0
)

replace github.com/romaine-life/fzt => ../fzt
`;

test("go.mod's module and every require, single-line and block, indirect included", () => {
  assert.deepEqual(parseGoMod(goMod), {module: 'github.com/romaine-life/fzt-terminal', requires: [
    'github.com/romaine-life/fzt', 'github.com/gdamore/tcell/v2', 'github.com/romaine-life/fzt-frontend', 'github.com/romaine-life/auth']});
  assert.deepEqual(ownRequires(goMod), ['github.com/romaine-life/auth', 'github.com/romaine-life/fzt', 'github.com/romaine-life/fzt-frontend']);
});

test('a repository releases the module its root go.mod names under github.com/romaine-life/', () => {
  assert.equal(ownModule(file => file === 'go.mod' ? goMod : null), 'github.com/romaine-life/fzt-terminal');
  assert.equal(ownModule(() => 'module forgejo.romaine.life/romaine-life/guitar-tabs\n'), null);
  assert.equal(ownModule(() => null), null);
});

test("a module's take-up goes to each other fleet repository with the go suite whose go.mod requires it", async () => {
  const repos = {
    'romaine-life/fzt': {suites: ['go', 'release']},
    'romaine-life/fzt-terminal': {suites: ['go', 'release']},
    'romaine-life/guitar-tabs': {suites: ['go', 'release']},
    'romaine-life/lights': {suites: ['go']},
    'romaine-life/landing-page': {suites: ['web-app']},
    'romaine-life/gone': {suites: ['go']},
    'romaine-life/no-mod': {suites: ['go']},
  };
  const mods = {
    'romaine-life/fzt': 'module github.com/romaine-life/fzt\n',
    'romaine-life/fzt-terminal': goMod,
    'romaine-life/guitar-tabs': 'module forgejo.romaine.life/romaine-life/guitar-tabs\n\nrequire (\n\tgithub.com/romaine-life/fzt v0.2.0 // indirect\n)\n',
    'romaine-life/lights': 'module github.com/romaine-life/lights\n\nrequire github.com/romaine-life/fzt-picker v0.1.0\n',
  };
  const asked = [];
  const saved = globalThis.fetch;
  globalThis.fetch = async url => {
    const {pathname, searchParams} = new URL(url);
    const repo = pathname.match(/^\/api\/v1\/repos\/([^/]+\/[^/]+)/)[1];
    asked.push(repo);
    if (repo === 'romaine-life/gone') return new Response('', {status: 404});
    if (pathname.endsWith(repo)) return new Response(JSON.stringify({default_branch: repo.endsWith('guitar-tabs') ? 'master' : 'main'}));
    assert.ok(pathname.endsWith('/raw/go.mod'));
    assert.equal(searchParams.get('ref'), repo.endsWith('guitar-tabs') ? 'master' : 'main');
    return mods[repo] ? new Response(mods[repo]) : new Response('', {status: 404});
  };
  try {
    assert.deepEqual(await consumers('github.com/romaine-life/fzt', {token: 't', repos, base: 'https://f.example', self: 'romaine-life/fzt'}), [
      {repository: 'romaine-life/fzt-terminal', workflow: 'go/dependencies.yml', branch: 'main'},
      {repository: 'romaine-life/guitar-tabs', workflow: 'go/dependencies.yml', branch: 'master'},
    ]);
    assert.ok(!asked.includes('romaine-life/fzt') && !asked.includes('romaine-life/landing-page'));
  } finally { globalThis.fetch = saved; }
});
