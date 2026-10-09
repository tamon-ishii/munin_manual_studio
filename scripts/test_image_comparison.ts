import assert from 'node:assert/strict';
import { readAnnotationInfo } from '../apps/manual-studio/src/imageComparison';

const chunk = (type: string, body: Buffer) => {
  const length = Buffer.alloc(4); length.writeUInt32BE(body.length);
  return Buffer.concat([length, Buffer.from(type), body, Buffer.alloc(4)]);
};
const png = (scene?: string) => 'data:image/png;base64,' + Buffer.concat([
  Buffer.from([137,80,78,71,13,10,26,10]),
  ...(scene === undefined ? [] : [chunk('tEXt', Buffer.from(`markits:annotations\0${scene}`))]),
  chunk('IEND', Buffer.alloc(0)),
]).toString('base64');

const annotation = {type:'spotlight',target:[12,20,100,50]};
const present = readAnnotationInfo(png(JSON.stringify({annotations:[annotation]})));
assert.equal(present.state,'present'); assert.equal(present.count,1);
assert.deepEqual(JSON.parse(present.value!),[annotation]);
assert.equal(readAnnotationInfo(png(JSON.stringify({annotations:[{target:annotation.target,type:annotation.type}]}))).value,present.value,'JSON field order does not falsely report a changed annotation');
assert.equal(readAnnotationInfo(png('[]')).state,'present','an intentionally empty annotation list remains valid');
assert.equal(readAnnotationInfo(png()).state,'missing');
assert.equal(readAnnotationInfo(png('{broken')).state,'invalid');
assert.equal(readAnnotationInfo(png('{}')).state,'invalid','missing annotation field is not an empty list');
assert.equal(readAnnotationInfo('data:image/png;base64,AA==').state,'invalid');
assert.equal(readAnnotationInfo('https://example.com/image.png').state,'unavailable');
const truncated=Buffer.from(png().split(',')[1],'base64');truncated.writeUInt32BE(10000,8);
assert.equal(readAnnotationInfo('data:image/png;base64,'+truncated.toString('base64')).state,'invalid');
console.log('PNG annotation checks passed: scene, empty list, absent metadata, malformed JSON and truncated chunks.');
