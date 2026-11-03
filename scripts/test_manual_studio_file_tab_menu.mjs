import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {chromium} from 'playwright-core';
const bundle=await build({stdin:{contents:`import {setupFileTabMenu} from './apps/manual-studio/src/fileTabMenu';window.setupFileTabMenu=setupFileTabMenu;`,resolveDir:process.cwd()},bundle:true,write:false,format:'iife',platform:'browser'});
const browser=await chromium.launch({headless:true});
try{
  const page=await browser.newPage();
  await page.setContent('<div id="document-tabs"><div class="document-tab"><button role="tab" data-document-page="a.md">A</button></div><div class="document-tab"><button role="tab" data-document-page="b.md">B</button></div><div class="document-tab"><button role="tab" data-image-page="image.png">Image</button></div></div>');
  await page.addScriptTag({content:bundle.outputFiles[0].text});
  await page.evaluate(()=>{window.closedTabs=[];window.blocked=false;setupFileTabMenu({tabs:()=>[{kind:'document',path:'a.md'},{kind:'document',path:'b.md'},{kind:'image',path:'image.png'}],busy:()=>blocked,close:async targets=>{closedTabs.push(targets);},report:error=>{throw error;}});});
  const menu=page.locator('#file-tab-context-menu');const middle=page.locator('[data-document-page="b.md"]');
  for(const [label,paths] of [['このタブを閉じる',['b.md']],['このタブ以外を閉じる',['a.md','image.png']],['左側のタブを閉じる',['a.md']],['右側のタブを閉じる',['image.png']],['すべてのタブを閉じる',['a.md','b.md','image.png']]]){
    await middle.click({button:'right'});await menu.getByRole('menuitem',{name:label,exact:true}).click();assert.deepEqual(await page.evaluate(()=>closedTabs.at(-1).map(tab=>tab.path)),paths);
  }
  await page.locator('[data-document-page="a.md"]').click({button:'right'});assert.equal(await menu.getByRole('menuitem',{name:'左側のタブを閉じる'}).isDisabled(),true);
  await page.keyboard.press('Escape');assert.equal(await menu.isHidden(),true);
  await middle.focus();await page.keyboard.press('Shift+F10');assert.equal(await menu.isHidden(),false);await page.keyboard.press('ArrowDown');assert.equal(await page.evaluate(()=>document.activeElement.textContent),'このタブ以外を閉じる');await page.keyboard.press('Escape');
  await page.evaluate(()=>{blocked=true;});await middle.click({button:'right'});assert.equal(await menu.isHidden(),true);
  console.log('File tab menu: target ranges, image tabs, disabled actions, keyboard and busy state passed.');
}finally{await browser.close();}
