import path from 'node:path';
import {capture, readJSON, safePath, templates} from './lib.mjs';

const fields = {
  suites: null, inputs: null,
  go: ['platforms', 'dependencies', 'race'], rust: ['platforms', 'features', 'noDefaultFeatures', 'platformFeatures','lints'],
  release: ['module', 'toolchains', 'prefix', 'prefixFrom', 'suffix', 'assets', 'dispatch', 'goTargets', 'windowsGui', 'goStampPackages', 'rustTargets', 'external', 'homeSync', 'dotnetProjects', 'dependencies', 'archives', 'image','mirror','assetNames','sourceLists','manifest','checksumFiles','checksumManifest'],
  cmake: ['platforms', 'buildPlatform'], dotnet: ['platforms', 'sdk', 'buildPlatform'], python: ['projects', 'version', 'platforms', 'buildPlatform'],
  cluster: ['renders', 'build', 'smoke', 'image', 'baoRole', 'baoSecret', 'pinFile', 'pinFields', 'workPackage'],
  web: ['packages', 'node', 'image', 'pinFile', 'pinFields', 'workPackage', 'containerApp', 'resourceGroup', 'staticApp', 'dependencies', 'history'], tofu: ['version', 'backend'], docs: ['required', 'release'],
  powershell: ['windowsPowerShell'], service: ['postgres', 'manticore', 'greenmail'], greenmail: ['users']
};
export const suiteNames = ['default', 'go', 'rust', 'cmake', 'dotnet', 'python', 'release', 'cluster-service', 'web-app', 'tofu', 'docs', 'powershell'];

export function currentRepository() {
  if (process.env.CI_REPOSITORY) return process.env.CI_REPOSITORY;
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
  const url = capture('git', ['remote', 'get-url', 'origin']).replace(/\.git$/, '');
  return url.split(/[/:]/).slice(-2).join('/');
}

export function fleet(file = process.env.CI_FLEET || path.join(templates, 'fleet.json')) {
  const value = readJSON(file);
  if (!value.repos || Array.isArray(value.repos) || typeof value.repos !== 'object') throw new Error('fleet.json needs a repos map');
  for (const [repo, entry] of Object.entries(value.repos)) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`fleet.json: not an owner/repo name: ${repo}`);
    validate(entry, repo);
  }
  return value.repos;
}

// A repository's settings are its entry in the fleet list; one with none has none.
export function config(repo = currentRepository(), repos = fleet()) {
  return repos[repo] || {suites: []};
}

export function validate(value, where = 'fleet entry') {
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error(`${where} must be an object`);
  if (!Array.isArray(value.suites) || value.suites.some(s => !suiteNames.includes(s) || s === 'default') || new Set(value.suites).size !== value.suites.length) {
    throw new Error(`${where}: suites must name each suite once (default is always included)`);
  }
  for (const [key, section] of Object.entries(value)) {
    if (!(key in fields)) throw new Error(`${where}: unknown field ${key}`);
    if (fields[key]) {
      if (!section || Array.isArray(section) || typeof section !== 'object') throw new Error(`${where}: ${key} must be an object`);
      for (const field of Object.keys(section)) if (!fields[key].includes(field)) throw new Error(`${where}: unknown field ${key}.${field}`);
    }
  }
  for (const [section, field] of [['go','dependencies'],['go','race'],['rust','features'],['release','assets'],['release','dispatch'],['cluster','renders'],['web','packages'],['web','dependencies'],['docs','required']]) {
    if (value[section]?.[field] !== undefined && !Array.isArray(value[section][field])) throw new Error(`${section}.${field} must be an array`);
  }
  for (const [section, field] of [['release','module'],['rust','noDefaultFeatures'],['cluster','build'],['cluster','smoke'],['docs','release'],['powershell','windowsPowerShell'],['web','history']]) {
    if (value[section]?.[field] !== undefined && typeof value[section][field] !== 'boolean') throw new Error(`${section}.${field} must be boolean`);
  }
  if (value.inputs && (Array.isArray(value.inputs) || typeof value.inputs !== 'object')) throw new Error('inputs must map check names to path arrays');
  if (value.cluster?.renders && !value.cluster.renders.length) throw new Error('cluster.renders must be nonempty');
  if (value.web?.packages && !value.web.packages.length) throw new Error('web.packages must be nonempty');
  for (const tool of ['go', 'rust', 'cmake', 'dotnet', 'python']) {
    const platforms = value[tool]?.platforms || ['ubuntu-latest'];
    if (!Array.isArray(platforms) || !platforms.length || platforms.some(p => !['ubuntu-latest', 'windows-latest'].includes(p)) || new Set(platforms).size !== platforms.length) {
      throw new Error(`${tool}.platforms must be a nonempty unique Linux/Windows runner list`);
    }
  }
  // A Go library that is also a cluster service (fzt-frontend) releases both under one tag.
  if (value.release?.module && (['toolchains', 'external', 'goTargets', 'assets'].some(f => value.release[f] !== undefined) || ![undefined, 'cluster'].includes(value.release.image))) throw new Error('release.module tags a Go library and publishes its source, with at most its cluster image; it builds nothing else');
  const toolchains = value.release?.toolchains || [];
  if (!Array.isArray(toolchains) || new Set(toolchains).size !== toolchains.length || toolchains.some(t=>!['go','rust','npm','python','dotnet','cmake','powershell'].includes(t))) throw new Error('invalid release.toolchains');
  for (const target of value.release?.goTargets || []) {
    if (!target || Object.keys(target).some(k=>!['goos','goarch','packages','buildmode'].includes(k)) || !['windows','linux','darwin','freebsd','js'].includes(target.goos) || !['amd64','arm64','386','arm','wasm'].includes(target.goarch)) throw new Error('release.goTargets need supported GOOS/GOARCH pairs');
    if(target.buildmode && (target.buildmode!=='c-shared' || (target.goos!=='windows' || target.goarch!=='amd64')))throw new Error('c-shared releases need a native Windows Go target');
    if((target.goos==='js')!==(target.goarch==='wasm'))throw new Error('js and wasm are one Go target pair');
    if (target.packages && (!Array.isArray(target.packages) || !target.packages.length)) throw new Error('target.packages must be nonempty');
  }
  for (const name of value.release?.windowsGui || []) if (typeof name !== 'string' || !name) throw new Error('release.windowsGui names Go packages');
  if(value.release?.rustTargets && (!Array.isArray(value.release.rustTargets) || !value.release.rustTargets.length))throw new Error('release.rustTargets must be a nonempty array');
  for (const part of value.release?.rustTargets || []) {
    if (!/^[\w]+-[\w]+-[\w]+(?:-[\w]+)?$/.test(part.target || '') || part.target.includes('apple')) throw new Error('Rust targets need target triples; Apple targets belong in release.external');
    if (Object.keys(part).some(key => !['target', 'features', 'noDefaultFeatures', 'glibc'].includes(key))) throw new Error('release.rustTargets take target, features, noDefaultFeatures and glibc');
    if (part.glibc !== undefined && (!part.target.endsWith('-unknown-linux-gnu') || !/^2\.\d+$/.test(part.glibc))) throw new Error('release.rustTargets glibc is a 2.N floor for a -unknown-linux-gnu target');
    // The Linux runner is x86_64: another architecture links through zig, which a glibc floor selects.
    if (part.target.endsWith('-unknown-linux-gnu') && !part.target.startsWith('x86_64-') && part.glibc === undefined) throw new Error(`${part.target} builds through zig: give it a glibc floor`);
  }
  if (value.release?.image && !['cluster','web'].includes(value.release.image)) throw new Error('release.image must be cluster or web');
  if (value.release?.image && !value[value.release.image]?.image) throw new Error('joined image release needs the corresponding image configuration');
  const externalIds=new Set(),externalAssets=new Set();
  for (const part of value.release?.external || []) {
    if (part.provider && !['github','forgejo'].includes(part.provider)) throw new Error('external release provider must be github or forgejo');
    if (!/^[a-z][a-z0-9-]*$/.test(part.id || '') || (['local','plan'].includes(part.id) || part.id.startsWith('request-')) || externalIds.has(part.id) || !/^(?:romaine-life|nelsong6)\/[\w.-]+$/.test(part.repository || '') || !/^[\w.-]+\.ya?ml$/.test(part.workflow || '') || !Array.isArray(part.assets) || !part.assets.length) throw new Error('external release parts need unique id, repository, workflow and asset names');
    for (const asset of part.assets) if (!/^[\w.+-]+$/.test(asset.replaceAll('{tag}','tag').replaceAll('{version}','version'))) throw new Error('external assets must be plain file names');
    for (const asset of part.assets) {if (externalAssets.has(asset)) throw new Error('external release asset names must be unique across parts');externalAssets.add(asset);}
    externalIds.add(part.id);
  }
  for (const dir of value.python?.projects || ['.']) if (dir !== '.') safePath(dir);
  for (const project of value.release?.dotnetProjects || []) safePath(project);
  for(const name of [...Object.values(value.release?.sourceLists || {}),...(value.release?.checksumFiles || []),...[value.release?.manifest,value.release?.checksumManifest].filter(Boolean)])if(typeof name!=='string' || !/^[\w.*+{}-]+$/.test(name))throw new Error('release metadata names must be plain file names');
  if(value.release?.assetNames && (Array.isArray(value.release.assetNames) || typeof value.release.assetNames!=='object'))throw new Error('release.assetNames must be an object');
  if(value.release?.sourceLists && (Array.isArray(value.release.sourceLists) || typeof value.release.sourceLists!=='object' || Object.keys(value.release.sourceLists).some(part=>!(value.release.rustTargets || [{target:'x86_64-unknown-linux-gnu'}]).some(t=>part===`rust-${t.target}`))))throw new Error('release.sourceLists must name declared Rust parts');
  for(const [part,mapping] of Object.entries(value.release?.assetNames || {})) {
    if(!/^[a-z][a-z0-9_-]*$/.test(part) || !mapping || Array.isArray(mapping) || typeof mapping!=='object')throw new Error('release.assetNames maps part/target IDs to rename maps');
    for(const [source,target] of Object.entries(mapping)) {
      safePath(source);
      if(source.split('*').length>2 || typeof target!=='string' || !/^[\w.*+{}-]+$/.test(target) || target.startsWith('ci-release-') || target.split('*').length>2 || target.replaceAll('{tag}','').replaceAll('{version}','').includes('{'))throw new Error('asset rename needs one optional wildcard and a plain published name with {tag}/{version}');
    }
  }
  const destinations = new Set();
  for (const dependency of value.web?.dependencies || []) {
    if (!value.web.image) throw new Error('web.dependencies are inputs to the web image');
    if (!dependency || Object.keys(dependency).some(k => !['repository', 'asset', 'path', 'destination'].includes(k))) throw new Error('unknown web dependency field');
    if (!/^(?:romaine-life|nelsong6)\/[\w.-]+$/.test(dependency.repository || '')) throw new Error('a web dependency names an owned repository');
    if (Boolean(dependency.asset) === Boolean(dependency.path)) throw new Error('a web dependency is a release asset or a path at the release tag, not both');
    if (dependency.asset && !/^[\w.+-]+$/.test(dependency.asset)) throw new Error('web dependency asset must be a plain file name');
    if (dependency.path) safePath(dependency.path);
    safePath(dependency.destination);
    if (destinations.has(dependency.destination)) throw new Error(`two web dependencies stage ${dependency.destination}`);
    destinations.add(dependency.destination);
  }
  for (const dependency of value.release?.dependencies || []) {
    if(Object.keys(dependency).some(k=>!['toolchain','targets','url','sha256','lock','destination','extract'].includes(k)))throw new Error('unknown release dependency field');
    if(dependency.extract!==undefined)safePath(dependency.extract);
    if(dependency.toolchain && !toolchains.includes(dependency.toolchain))throw new Error('dependency toolchain is not declared');
    safePath(dependency.destination);
    if(dependency.targets && (!Array.isArray(dependency.targets) || !dependency.targets.length || new Set(dependency.targets).size!==dependency.targets.length || dependency.targets.some(t=>!/^[-\w]+$/.test(t))))throw new Error('dependency.targets must be unique target names');
    if (dependency.lock) safePath(dependency.lock);
    if (!dependency.lock && !/^[0-9a-f]{64}$/.test(dependency.sha256 || '')) throw new Error('release dependency needs a lock file or sha256');
    const url=new URL(dependency.url.replace('{tag}','version'));
    if (url.protocol!=='https:' || !['artifacts.home.romaine.life','forgejo.romaine.life'].includes(url.hostname)) throw new Error('release dependencies come from Artifact Keeper or Forgejo');
  }
  for (const archive of value.release?.archives || []) {
    if(Object.keys(archive).some(k=>!['toolchain','targets','name','sources','entries'].includes(k)))throw new Error('unknown archive field');
    if (!/^[\w.-]+\.(?:zip|tar\.gz)$/.test((archive.name || '').replaceAll('{tag}','tag').replaceAll('{version}','version')) || !Array.isArray(archive.sources) || !archive.sources.length) throw new Error('release.archives need a ZIP name and source files');
    for (const file of archive.sources) {safePath(file);if(file==='dist')throw new Error('archive sources must name files or subdirectories, not the output root');}
    if(archive.targets && (!Array.isArray(archive.targets) || !archive.targets.length))throw new Error('archive.targets must be nonempty');
    for(const [source,target] of Object.entries(archive.entries || {})){safePath(source);if(!/^[\w.+-]+$/.test(target))throw new Error('archive entries must name plain files');}
  }
  for (const [job, paths] of Object.entries(value.inputs || {})) {
    if (!/^[a-z-]+\.[a-z-]+$/.test(job) || !Array.isArray(paths) || !paths.length) throw new Error(`invalid input set: ${job}`);
    for (const p of paths) safePath(p);
  }
  for (const p of value.web?.packages || ['.']) if (p !== '.') safePath(p);
  for (const p of value.docs?.required || []) safePath(p);
  if (value.release?.prefix && value.release?.prefixFrom) throw new Error('choose release.prefix or prefixFrom');
  if (value.release?.prefixFrom) safePath(value.release.prefixFrom);
  for (const p of value.release?.assets || []) safePath(p);
  for (const target of value.release?.dispatch || []) {
    if (!/^(?:romaine-life|nelsong6)\/[\w.-]+$/.test(target.repository || '') || Object.keys(target).some(k=>!['repository','workflow'].includes(k))) throw new Error('release.dispatch must name an owned repository and optional workflow');
    if (target.workflow) safePath(target.workflow);
  }
  for (const item of value.cluster?.renders || []) {
    if (!['helm', 'kustomize', 'argocd'].includes(item.kind)) throw new Error('cluster.renders.kind must be helm, kustomize or argocd');
    if (item.kind === 'argocd' && (item.values || item.name)) throw new Error('an argocd render takes its apps from the root Application at path');
    safePath(item.path);
    if (item.values) safePath(item.values);
    for (const key of Object.keys(item)) if (!['kind', 'path', 'values', 'name'].includes(key)) throw new Error(`unknown render field: ${key}`);
  }
  if (value.cluster?.pinFile) safePath(value.cluster.pinFile);
  if (value.web?.pinFile) safePath(value.web.pinFile);
  for(const section of ['cluster','web'])if(value[section]?.pinFields!==undefined) {
    const fields=value[section].pinFields;
    if(!value[section].pinFile || !fields || Array.isArray(fields) || typeof fields!=='object' || !Object.keys(fields).length)throw new Error(`${section}.pinFields needs pinFile and a nonempty field map`);
    for(const [field,source] of Object.entries(fields))if(!/^[A-Za-z_][\w-]*(?:\.[A-Za-z_][\w-]*)*$/.test(field) || field.split('.').some(key=>['__proto__','constructor','prototype'].includes(key)) || !['tag','commit','version','date','prNumber','prTitle','prUrl'].includes(source))throw new Error(`${section}.pinFields maps dotted YAML fields to tag, commit, version, date or the merged PR's prNumber, prTitle or prUrl`);
  }
  for (const [name, image] of Object.entries(value.service || {})) {
    if (typeof image !== 'string' || !/^artifacts\.home\.romaine\.life\/[\w./:-]+@sha256:[0-9a-f]{64}$/.test(image)) throw new Error(`service.${name} must be a digest-pinned Artifact Keeper image`);
  }
  if (value.greenmail && !value.service?.greenmail) throw new Error('greenmail.users needs service.greenmail');
  const users = value.greenmail?.users;
  if (users !== undefined && (!Array.isArray(users) || !users.length || users.some(user => typeof user !== 'string' || !/^[\w.+-]+:[^\s,@:]+@[\w.-]+$/.test(user)))) {
    throw new Error('greenmail.users are login:password@domain, as GreenMail takes them');
  }
  if (value.cluster?.smoke === false && value.cluster?.build !== false) throw new Error('only render-only/upstream services may omit the standard smoke job');
  if (value.cluster?.build === false && value.cluster?.smoke !== false && !/@sha256:[0-9a-f]{64}$/.test(value.cluster.image || '')) throw new Error('upstream cluster.image requires a digest');
  if (value.web?.image && !/^[a-z0-9]+\.azurecr\.io\/[\w./-]+$/.test(value.web.image)) throw new Error('web.image must name an ACR image without a tag');
  if (value.web?.staticApp && (value.web.image || value.web.containerApp || value.web.pinFile || !value.web.resourceGroup || (value.web.packages || ['.']).length!==1)) throw new Error('staticApp needs one package and resourceGroup without an image');
  if (value.web?.containerApp && (value.web.pinFile || !value.web.resourceGroup)) throw new Error('choose a pin PR or a containerApp and resourceGroup');
  return value;
}
