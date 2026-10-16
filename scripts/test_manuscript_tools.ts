import assert from 'node:assert/strict';
import {replaceMatches,moveSection,sameOwner,type OutlineHeading} from '../apps/manual-studio/src/manuscriptTools';

const content='😀 target and target\n![keep](assets/image.png)\n';
assert.equal(replaceMatches(content,[{page:'a',start:3,end:9,text:'target',line:1,column:4,excerpt:''}],'new'),'😀 new and target\n![keep](assets/image.png)\n');
assert.throws(()=>replaceMatches(content,[{page:'a',start:2,end:8,text:'target',line:1,column:3,excerpt:''}],'new'));
assert.throws(()=>replaceMatches('aaaa',[{page:'a',start:0,end:3,text:'aaa',line:1,column:1,excerpt:''},{page:'a',start:1,end:4,text:'aaa',line:1,column:2,excerpt:''}],'x'));
const text='# Root\r\n\r\n## A\r\n![a](a.png)\r\n### Child\r\n```mermaid\r\ngraph TD\r\n```\r\n\r\n## B\r\nlast';
const at=(needle:string)=>text.indexOf(needle);
const heading=(label:string,start:number,end:number,level:number,parent:number|null):OutlineHeading=>({label,start,end,heading_end:start+label.length+level+2,level,parent});
const headings=[heading('Root',0,text.length,1,null),heading('A',at('## A'),at('## B'),2,0),heading('Child',at('### Child'),at('## B'),3,1),heading('B',at('## B'),text.length,2,0)];
const moved=moveSection(text,headings,3,1);
assert.equal(moved.content,text.slice(0,at('## A'))+text.slice(at('## B'))+'\r\n'+text.slice(at('## A'),at('## B')));
assert.ok(moved.content.includes('![a](a.png)\r\n### Child\r\n```mermaid'));
assert.throws(()=>moveSection(text,headings,1,2));
assert.deepEqual(moveSection(text,headings,1,1),{content:text,start:at('## A')});
console.log('Manuscript tools: Unicode match selection, stale/overlapping ranges, sibling sections, CRLF, images, diagrams and trailing newline passed.');

const owner={root:"/project",page:"index.md",session:1,content,revision:"saved"};
assert.equal(sameOwner({...owner},owner),true);
for(const changed of [{root:"/other"},{page:"other.md"},{session:2},{content:content+"draft"}])assert.equal(sameOwner({...owner,...changed},owner),false);
assert.equal(sameOwner(null,owner),false);
