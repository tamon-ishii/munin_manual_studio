import assert from 'node:assert/strict';
import { PreviewScheduler } from '../apps/manual-studio/src/previewScheduler';
import { ThumbnailCache } from '../apps/manual-studio/src/thumbnailCache';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
let current = 'initial', visible = false;
const requests: {snapshot:string;resolve:(html:string)=>void;reject:(error:Error)=>void}[] = [];
const applied: string[] = [], errors:unknown[] = [];
const preview = new PreviewScheduler({
  snapshot:()=>current, key:value=>value, visible:()=>visible,
  generate:snapshot=>new Promise<string>((resolve,reject)=>requests.push({snapshot,resolve,reject})),
  loading:()=>{}, apply:html=>applied.push(html), error:error=>errors.push(error),
}, 1);
await preview.request(); assert.equal(requests.length,0,'hidden preview does no work');
visible=true;
const first=preview.request(); await tick(); assert.equal(requests.length,1);
void preview.request(); void preview.request();
current='intermediate'; preview.schedule(); current='latest'; preview.schedule();
await tick(); assert.equal(requests.length,1,'typing cannot start concurrent preview requests');
requests[0].resolve('obsolete'); await tick();
assert.deepEqual(applied,[]); assert.equal(requests.length,2); assert.equal(requests[1].snapshot,'latest');
requests[1].resolve('latest html'); await first; assert.deepEqual(applied,['latest html']);
await preview.request(); assert.equal(requests.length,2,'unchanged preview is reused');
current='hidden edit';visible=false;preview.schedule();await tick();assert.equal(requests.length,2);
visible=true;const resumed=preview.request();await tick();requests[2].resolve('resumed');await resumed;
visible=false;const forced=preview.request(true);await tick();requests[3].resolve('forced');await forced;assert.equal(applied.at(-1),'forced');
visible=true;current='failed';const failed=preview.request();await tick();requests[4].reject(new Error('temporary'));await failed;assert.equal(errors.length,1);
current='recovered';const recovered=preview.request();await tick();requests[5].resolve('recovered');await recovered;assert.equal(applied.at(-1),'recovered');

const cache = new ThumbnailCache(2);
let reads=0;
const load=(key:string)=>cache.load(key,async()=>`${key}:${++reads}`);
cache.retain(['root/a:r1','root/b:r1','root/c:r1']);
assert.equal(await load('root/a:r1'),'root/a:r1:1');
cache.retain(['root/a:r1','root/b:r1','root/c:r1']);
assert.equal(await load('root/a:r1'),'root/a:r1:1','refresh reuses unchanged image');
await load('root/b:r1');await load('root/c:r1');await load('root/a:r1');assert.equal(reads,4,'cache has a bounded LRU');
cache.retain(['root/a:r2']);await load('root/a:r2');assert.equal(reads,5,'changed image is regenerated');
cache.retain(['other/a:r2']);await load('other/a:r2');assert.equal(reads,6,'projects cannot share thumbnails');
let finish!:(value:string)=>void;
cache.retain(['pending']);
const pending=cache.load('pending',()=>new Promise(resolve=>{finish=resolve;}));
const duplicate=cache.load('pending',()=>{throw Error('duplicate request');});
cache.retain([]);finish('old');await Promise.all([pending,duplicate]);
cache.retain(['pending']);let fresh=0;await cache.load('pending',async()=>{fresh++;return 'new';});assert.equal(fresh,1,'obsolete in-flight result is not cached');
console.log('Performance checks passed: hidden/latest-only preview, bounded versioned thumbnails, deduplication, failure recovery.');
