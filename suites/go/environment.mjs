import fs from 'node:fs';
// Our Go modules (github.com/romaine-life/*) come from Forgejo through git, never through a Go
// proxy: a new tag is on Forgejo the moment it's pushed, while the home proxy (Artifact Keeper,
// whose source is proxy.golang.org reading the GitHub push mirrors) gets it later (PIPT-61).
// For go.mod's text, the variables and git settings that do that, or nothing when it requires
// none of them; with a token, git signs in to Forgejo with it.
export function goPrivate(goMod, token, server = process.env.GITHUB_SERVER_URL || 'https://forgejo.romaine.life') {
  const requirements = goMod.split(/\r?\n/).filter(line => !line.startsWith('module ')).join('\n');
  if (!requirements.includes('github.com/romaine-life/')) return null;
  const base = `${server.replace(/\/$/, '')}/romaine-life/`;
  const git = [[`url.${base}.insteadOf`, 'https://github.com/romaine-life/']];
  if (token) git.push([`http.${base}.extraheader`, `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`]);
  return {env: {GOPRIVATE: 'github.com/romaine-life/*', GONOSUMDB: 'github.com/romaine-life/*'}, git};
}
// The same settings as a git config file, which a Docker build mounts as a secret
// (cluster-service/image.mjs).
export function gitConfigFile(git) {
  const quote = text => text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return git.map(([key, value]) => {
    const section = key.slice(0, key.indexOf('.')), name = key.slice(key.lastIndexOf('.') + 1), sub = key.slice(section.length + 1, key.lastIndexOf('.'));
    return `[${section} "${quote(sub)}"]\n\t${name} = "${quote(value)}"\n`;
  }).join('');
}
export function goEnvironment() {
  const settings = goPrivate(fs.readFileSync('go.mod', 'utf8'), process.env.PRIVATE_GO_TOKEN);
  if (!settings) return;
  const env = {...settings.env, GIT_CONFIG_COUNT: String(settings.git.length)};
  settings.git.forEach(([key, value], i) => Object.assign(env, {[`GIT_CONFIG_KEY_${i}`]: key, [`GIT_CONFIG_VALUE_${i}`]: value}));
  Object.assign(process.env, env);
}
