import fs from 'node:fs';
import {run, capture, requirePublish} from '../lib.mjs';
import {config} from '../config.mjs';
import {clusterImages} from '../layout.mjs';
import path from 'node:path';
import os from 'node:os';
import {pathToFileURL} from 'node:url';
import crypto from 'node:crypto';
import {goPrivate, gitConfigFile} from '../go/environment.mjs';

// Each image a section builds: its own, then each other one (layout.mjs, images), checked or
// published in turn. A publish leaves their pins in .ci-image-pin, one line each, its own first.
// workflow: the suite workflow whose PR run's image a merge publishes (prior-image.mjs), and
// job, that run's image check (check-image by default; a joined release's is check-package).
// published: the suite's release is the image.txt release.mjs image stages, so a version
// already published delivers the images it names (published.mjs).
// carried: the pin of each image whose inputs are unchanged since the release that built it, by
// image, which a joined release keeps rather than building again (release.mjs, joinedImageChanged).
export async function imageOperation(cfg, mode, login, {workflow, job, published = false, carried = {}} = {}) {
if (!['check', 'publish'].includes(mode)) throw new Error('image.mjs check|publish');
if (mode === 'publish') requirePublish();
const build = cfg.build !== false;
const images = clusterImages(cfg);
// A version already published (a rerun, or a dispatch that finishes a delivery whose pin never
// ran) keeps its images: the release's image.txt goes to .ci-image-pin once the registry still
// serves each digest, nothing is built or pushed, and the steps after this one carry it to its pin.
if (mode === 'publish' && published && build) {
  const {publishedImage} = await import('./published.mjs');
  const released = await publishedImage({images: images.map(section => section.image)});
  if (released) {
    await signedIn(cfg, login, () => {
      for (const pin of released.pins) {
        // <image>:<tag>@sha256:<digest> as <image>@sha256:<digest>.
        const reference = pin.replace(/:[\w.+-]+@/, '@');
        try { run('docker', ['manifest', 'inspect', reference], {stdio: ['ignore', 'ignore', 'inherit']}); }
        catch (error) { throw new Error(`release ${process.env.VERSION} is published with ${pin}, which the registry no longer serves (${error.message}): a new commit releases a new version`); }
      }
    });
    fs.writeFileSync('.ci-image-pin', released.bytes);
    console.log(`${process.env.VERSION} is already published with ${released.pins.join(', ')}; delivering that, nothing is built`);
    return;
  }
}
const prior = await import('./prior-image.mjs');
const pins = [];
try {
  for (const section of images) pins.push(await oneImage(section, mode, login, {workflow, job, carried: carried[section.image], prior, build, cfg}));
} finally {
  if (mode === 'publish') fs.rmSync(prior.kept, {recursive: true, force: true});
}
if (mode === 'publish' && build) fs.writeFileSync('.ci-image-pin', pins.join('\n'));
}

// One image: built (or its PR's build loaded), self-tested and kept on a check; pushed under the
// version on a publish, which returns its pin.
async function oneImage(section, mode, login, {workflow, job, carried, prior, build, cfg}) {
if (mode === 'publish' && carried) {
  console.log(`${section.image}'s inputs are unchanged; the release keeps ${carried}`);
  return carried;
}
const repo = (process.env.GITHUB_REPOSITORY || path.basename(process.cwd())).replace(/[^\w.-]/g, '-');
// Its own name, since two jobs of one run can build the same commit on one runner; the job
// removes what it tagged when it ends, so images don't pile up in the runner's Docker.
let image = `ci-${repo}${section.name ? `-${section.name}` : ''}:${process.env.GITHUB_SHA || capture('git', ['rev-parse', 'HEAD'])}-${crypto.randomBytes(4).toString('hex')}`;
const kept = prior.keptFor(section);
const tagged = [];
let pin = null;
// A merge whose PR built this image, at this version from these inputs, publishes that image.
let reused = null;
if (mode === 'publish' && build && workflow && prior.reusable(section, process.env.VERSION)) {
  try {
    const found = await prior.findPriorImage({workflow, job, fingerprint: prior.imageFingerprint({section, version: process.env.VERSION})});
    if (found) {
      const record = await prior.download(found, {image: section.name});
      run('docker', ['load', '-i', path.join(kept, 'image.tar')]);
      tagged.push(record.name);
      const id = capture('docker', ['image', 'inspect', '--format', '{{.Id}}', record.name]);
      if (id !== record.id) throw new Error(`run ${found.run}'s image loaded as ${id}, not the ${record.id} it built`);
      reused = {...found, ...record};
      image = record.name;
    }
  } catch (error) {
    console.log(`::warning::Publishing the pull request's image ${section.image} failed, so the release builds it: ${error.message}`);
    reused = null;
    fs.rmSync(prior.kept, {recursive: true, force: true});
  }
}
try {
if (build && !reused) {
  // The release version (on a PR, the tag its merge would take) and commit, for an image that
  // shows them.
  const args = ['--build-arg', `SOURCE_SHA=${process.env.GITHUB_SHA || capture('git', ['rev-parse', 'HEAD']).trim()}`,
    ...(process.env.VERSION ? ['--build-arg', `APP_VERSION=${process.env.VERSION}`] : []),
    // The job's sign-in for npm packages on Forgejo (packages.mjs), which a Dockerfile's
    // `RUN --mount=type=secret,id=FORGEJO_PACKAGES_TOKEN,env=FORGEJO_PACKAGES_TOKEN` reads.
    ...(process.env.FORGEJO_PACKAGES_TOKEN ? ['--secret', 'id=FORGEJO_PACKAGES_TOKEN,env=FORGEJO_PACKAGES_TOKEN'] : [])];
  const context = section.context || '.';
  // Our Go modules from Forgejo, as every suite Go step takes them (go/environment.mjs): their
  // GOPRIVATE and GONOSUMDB as build arguments, and the git settings that fetch them from
  // Forgejo, signed in with PRIVATE_GO_TOKEN, as the secret file go-private-git, which a
  // Dockerfile mounts for its `go mod download` alone (PIPT-61).
  const goMod = path.join(context, 'go.mod');
  const go = fs.existsSync(goMod) ? goPrivate(fs.readFileSync(goMod, 'utf8'), process.env.PRIVATE_GO_TOKEN) : null;
  const goEnv = {};
  if (go) {
    args.push(...Object.entries(go.env).flatMap(([key, value]) => ['--build-arg', `${key}=${value}`]), '--secret', 'id=go-private-git,env=GO_PRIVATE_GIT');
    goEnv.GO_PRIVATE_GIT = gitConfigFile(go.git);
  }
  run('docker', ['build', '--network', 'host', ...args, '-f', path.posix.join(context, 'Dockerfile'), '-t', image, context], {env: {...process.env, ...goEnv, DOCKER_BUILDKIT: '1'}});
  tagged.push(image);
} else if (!build && !section.image) throw new Error('upstream service requires cluster.image pinned by digest');
if (mode === 'check') {
  // The application self-test must exit, including database migrations and sign-in assertions.
  // A joined release's assembled files are at /ci/dist in a layer only the check runs, so an
  // image that runs a release binary it doesn't hold (spt's session) runs that binary there.
  // A layer, not a bind mount: the job's own folder isn't a path on the Docker host.
  let tested = build ? image : section.image;
  if (fs.existsSync('dist')) {
    run('docker', ['build', '-t', `${image}-dist`, '-f', '-', 'dist'], {input: `FROM ${tested}\nCOPY . /ci/dist/\n`,
      stdio: ['pipe', 'inherit', 'inherit'], env: {...process.env, DOCKER_BUILDKIT: '1'}});
    tested = `${image}-dist`;
    tagged.push(tested);
  }
  run('docker', ['run', '--rm', '--network', process.env.CI_SERVICE_NETWORK || 'host', '--read-only',
    ...['DATABASE_URL','MANTICORE_URL','SMTP_HOST','SMTP_PORT','IMAP_HOST','IMAP_PORT'].filter(k=>process.env[k]).flatMap(k=>['-e',k]), tested, '--self-test']);
  // The image as built, kept for the merge that reserves the version it stamps (the job's
  // upload step keeps prior.kept as the run's artifact).
  if (workflow && prior.reusable(section, process.env.VERSION)) {
    const id = capture('docker', ['image', 'inspect', '--format', '{{.Id}}', image]);
    fs.mkdirSync(kept, {recursive: true});
    run('docker', ['save', '-o', path.join(kept, 'image.tar'), image]);
    fs.writeFileSync(path.join(kept, 'image.json'), JSON.stringify({name: image, id, version: process.env.VERSION}));
    console.log(`Built ${section.image} as ${id}, stamped ${process.env.VERSION}: kept for the merge that takes that tag to publish`);
  }
} else if (build) {
  await signedIn(cfg, login, () => {
    const remote = `${section.image}:${process.env.VERSION}`;
    if (!section.image || !/^(?:forgejo\.romaine\.life|[a-z0-9]+\.azurecr\.io)\/[\w./-]+$/.test(section.image)) throw new Error('image must name the Forgejo registry or ACR repository');
    run('docker', ['tag', image, remote]);
    tagged.push(remote);
    run('docker', ['push', remote]);
    const digest = JSON.parse(capture('docker', ['image', 'inspect', remote, '--format', '{{json .RepoDigests}}']));
    const found = digest.find(d => d.startsWith(`${section.image}@`));
    if (!found || !/@sha256:[0-9a-f]{64}$/.test(found)) throw new Error('push produced no registry digest');
    if (reused && found.split('@')[1] !== reused.id) throw new Error(`pushed ${found}, not the ${reused.id} pull request #${reused.pull}'s run ${reused.run} built`);
    pin = `${section.image}:${process.env.VERSION}@${found.split('@')[1]}`;
    if (reused) console.log(`Published ${pin}, the image pull request #${reused.pull}'s run ${reused.run} built; nothing was built here`);
  });
}
} finally {
  if (tagged.length) run('docker', ['image', 'rm', ...tagged]);
}
return pin;
}
// The registry signed in for one action, in a Docker config of its own that the action leaves
// behind it.
async function signedIn(cfg, login, action) {
  const {registryLogin} = await import('./registry.mjs');
  const temp = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'registry-'));
  const old = process.env.DOCKER_CONFIG;
  process.env.DOCKER_CONFIG = temp;
  try {
    await (login || registryLogin)(cfg);
    return await action();
  } finally {
    if (old === undefined) delete process.env.DOCKER_CONFIG; else process.env.DOCKER_CONFIG = old;
    fs.rmSync(temp, {recursive: true, force: true});
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await imageOperation(config().cluster || {}, process.argv[2], undefined, {workflow: 'cluster-service/ci.yml', published: true});
