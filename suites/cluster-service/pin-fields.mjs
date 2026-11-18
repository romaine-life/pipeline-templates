import YAML from 'yaml';

// The pin file's top-level `release` map, for an app that shows what is deployed, holds pin
// fields named for what they take: the release's tag, its commit, its version (the tag
// without its v), the date the release was pinned (UTC, to the second), or the PR the
// release's commit merged (its number, title and address).
export const sources=['tag','commit','version','date','prNumber','prTitle','prUrl'];
export function updatePin(original,cfg,pin,{tag=process.env.VERSION,commit=process.env.SOURCE_SHA || process.env.GITHUB_SHA,date=new Date(),pr=null}={}) {
  const escaped=cfg.image.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  const pattern=new RegExp(`${escaped}:[\\w.+-]+@sha256:[0-9a-f]{64}`,'g');
  if(!pattern.test(original))throw new Error('pinFile contains no existing image pin');
  const updated=original.replace(pattern,pin);
  const document=YAML.parseDocument(updated);
  if(document.errors.length)throw new Error(`invalid pin YAML: ${document.errors[0].message}`);
  const fields=document.get('release',true);
  if(fields===undefined)return updated;
  if(!YAML.isMap(fields))throw new Error("the pin file's release holds pin fields: a map");
  if(!/^[\w.+-]+$/.test(tag || '') || !/^[0-9a-f]{40,64}$/.test(commit || ''))throw new Error('pin fields require the release tag and source commit');
  const values={tag,commit,version:tag.replace(/^v/,''),date:date.toISOString().replace(/\.\d{3}Z$/,'Z'),
    prNumber:pr?.number ? String(pr.number) : '',prTitle:pr?.title || '',prUrl:pr?.html_url || ''};
  for(const pair of fields.items) {
    const field=YAML.isScalar(pair.key) ? pair.key.value : pair.key;
    if(!sources.includes(field) || !YAML.isScalar(pair.value))throw new Error(`release.${field} is not a pin field: release holds ${sources.join(', ')}`);
    pair.value.value=values[field];
  }
  // No line folding: a folded pin is no longer one string the next release can find.
  return document.toString({lineWidth: 0});
}
