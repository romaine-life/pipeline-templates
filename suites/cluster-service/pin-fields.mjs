import YAML from 'yaml';
import {fieldPins, pinPattern} from '../layout.mjs';

// The pin file's top-level `release` map, for an app that shows what is deployed, holds pin
// fields named for what they take: the release's tag, its commit, its version (the tag
// without its v), the date the release was pinned (UTC, to the second), or the PR the
// release's commit merged (its number, title and address).
export const sources=['tag','commit','version','date','prNumber','prTitle','prUrl'];
// A scalar's new text in the style it was written: quoted as it was, else plain when YAML
// still reads it as that string (a tag such as 1.0 would read as a number).
const written=(node,value)=>node.type==='QUOTE_SINGLE' ? `'${value}'`
  : node.type==='PLAIN' && YAML.parse(value)===value ? value : JSON.stringify(value);
export function updatePin(original,cfg,pin,{tag=process.env.VERSION,commit=process.env.SOURCE_SHA || process.env.GITHUB_SHA,date=new Date(),pr=null}={}) {
  const pattern=new RegExp(pinPattern(cfg.image).source,'g');
  const parsed=YAML.parseDocument(original);
  if(parsed.errors.length)throw new Error(`invalid pin YAML: ${parsed.errors[0].message}`);
  // A chart's separate image fields (layout.mjs fieldPins) take the release's tag and digest,
  // written over each value's own text, so its quoting, spacing and comments stay as they were.
  const maps=fieldPins(cfg.image,parsed),parts=pin.match(/:([\w.+-]+)@sha256:([0-9a-f]{64})$/);
  if(maps.length && !parts)throw new Error(`${pin} names no tag and digest for ${cfg.image}'s fields`);
  const edits=maps.flatMap(({map,key})=>[[map.get('tag',true),parts[1]],
    [map.get(key,true),key==='sha256' ? parts[2] : `sha256:${parts[2]}`]]).sort(([a],[b])=>b.range[0]-a.range[0]);
  if(!pattern.test(original) && !edits.length)throw new Error('pinFile contains no existing image pin');
  let updated=original;
  for(const [node,value] of edits)updated=updated.slice(0,node.range[0])+written(node,value)+updated.slice(node.range[1]);
  updated=updated.replace(pattern,pin);
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
