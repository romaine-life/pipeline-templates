import YAML from 'yaml';

// A pin field takes the release's tag, its commit, its version (the tag without its v), or the
// date the release was pinned (UTC, to the second), for an app that shows when it was released.
export function updatePin(original,cfg,pin,{tag=process.env.VERSION,commit=process.env.SOURCE_SHA || process.env.GITHUB_SHA,date=new Date()}={}) {
  const escaped=cfg.image.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  const pattern=new RegExp(`${escaped}:[\\w.+-]+@sha256:[0-9a-f]{64}`,'g');
  if(!pattern.test(original))throw new Error('pinFile contains no existing image pin');
  const updated=original.replace(pattern,pin);
  if(!Object.keys(cfg.pinFields || {}).length)return updated;
  if(!/^[\w.+-]+$/.test(tag || '') || !/^[0-9a-f]{40,64}$/.test(commit || ''))throw new Error('pin fields require the release tag and source commit');
  const values={tag,commit,version:tag.replace(/^v/,''),date:date.toISOString().replace(/\.\d{3}Z$/,'Z')},document=YAML.parseDocument(updated);
  if(document.errors.length)throw new Error(`invalid pin YAML: ${document.errors[0].message}`);
  for(const [field,source] of Object.entries(cfg.pinFields)) {
    const node=document.getIn(field.split('.'),true);
    if(!YAML.isScalar(node) || !Object.hasOwn(values,source))throw new Error(`pin field must name an existing scalar and release value: ${field}`);
    node.value=values[source];
  }
  return document.toString();
}
