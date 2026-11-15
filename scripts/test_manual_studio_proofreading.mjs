import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {chromium} from 'playwright-core';

const server=spawn(process.execPath,['node_modules/vite/bin/vite.js','--config','apps/manual-studio/vite.config.ts','--host','127.0.0.1','--port','5188'],{stdio:'pipe'});
let browser;
try{
  for(let i=0;i<100;i++){
    try{if((await fetch('http://127.0.0.1:5188')).ok)break;}catch{}
    if(i===99)throw Error('Vite did not start');
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  browser=await chromium.launch({headless:true});
  const page=await browser.newPage({viewport:{width:1440,height:1000}});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/proofreading-test',route=>route.fulfill({contentType:'text/html',body:`<meta charset="utf-8"><link rel="stylesheet" href="/src/style.css"><script type="module">
    import {reviewProofreading,proofreadingOptions} from '/src/proofreading.ts';
    window.options=proofreadingOptions();document.body.append(options.element);
    import {comparisonBlocks} from '/src/proofreadingDiff.ts';
    import {askSelectionAction} from '/src/selectionAi.ts';
    window.askRewrite=()=>{window.action='pending';askSelectionAction('old A\\nkeep\\nold B').then(value=>window.action=value);};
    window.align=comparisonBlocks;
    window.openReview=(original='old A\\nkeep\\nold B',variants=[{id:'yomiyasu',content:'new A\\nkeep\\nold B'},{id:'natural-japanese',content:'old A\\nkeep\\nnew B'},{id:'japanese-tech-writing',error:'generation failed'}])=>{window.result='pending';reviewProofreading(original,variants).then(value=>window.result=value);};
  </script>`}));
  await page.goto('http://127.0.0.1:5188/proofreading-test');
  await page.locator('[data-proofreading-skill]').first().waitFor();
  assert.equal(await page.locator('[data-proofreading-skill]').count(),3);
  assert.equal(await page.evaluate(()=>options.read().enabled),false);
  await page.getByRole('checkbox',{name:'yomiyasu',exact:true}).check();
  assert.equal(await page.evaluate(()=>options.read().enabled),true);
  assert.deepEqual(await page.evaluate(()=>options.read().profiles.map(p=>p.id)),['yomiyasu']);
  await page.getByRole('checkbox',{name:'natural-japanese',exact:true}).check();
  await page.getByRole('checkbox',{name:'yomiyasu',exact:true}).uncheck();
  assert.deepEqual(await page.evaluate(()=>options.read().profiles.map(p=>p.id)),['natural-japanese']);
  // All columns must reconstruct their exact input, including boundary inserts and trailing newlines.
  for(const [original,versions] of [
    ['A\nB\nC',['X\nA\nB\nC','A\nC','A\nB\nC\nY']],
    ['A\nB\n',['A\nZ\nB\n','A\n','Z\n']],
    ['',['new','\n','']],
    ['A\nB\nC',['A\nnew B\nC','A\nC','A\nB\nC']],
  ]){
    assert.deepEqual(await page.evaluate(({original,versions})=>{const blocks=align(original,versions);return [original,...versions].map((_,column)=>blocks.flatMap(b=>b.columns[column]).join('\n'));},{original,versions}),[original,...versions]);
  }
  await page.evaluate(()=>openReview());
  assert.deepEqual(await page.locator('.proofreading-heading').evaluateAll(headings=>headings.map(h=>h.firstChild.textContent)),['原文','yomiyasu','natural-japanese','japanese-tech-writing','最終結果']);
  // The same diff appears in one aligned grid row across every source and the final column.
  const bounds=await page.locator('[data-comparison-row="0"], [data-final-row="0"]').evaluateAll(cells=>cells.map(c=>({y:c.getBoundingClientRect().y,height:c.getBoundingClientRect().height})));
  assert.equal(new Set(bounds.map(b=>b.y)).size,1);assert.equal(new Set(bounds.map(b=>b.height)).size,1);
  await page.getByRole('radio',{name:'差分1：yomiyasuを採用',exact:true}).check();
  await page.getByRole('radio',{name:'差分2：natural-japaneseを採用',exact:true}).check();
  assert.deepEqual(await page.locator('[data-final-row] pre').allTextContents(),['new A','keep','new B']);
  assert.match(await page.locator('.proofreading-error').textContent(),/generation failed/);
  assert.equal(await page.getByRole('button',{name:'japanese-tech-writingをすべて採用',exact:true}).isDisabled(),true);
  await page.getByRole('button',{name:'原文をすべて採用',exact:true}).click();
  assert.deepEqual(await page.locator('[data-final-row] pre').allTextContents(),['old A','keep','old B']);
  await page.getByRole('button',{name:'yomiyasuをすべて採用',exact:true}).click();
  await page.getByRole('radio',{name:'差分2：natural-japaneseを採用',exact:true}).check();
  await page.getByRole('button',{name:'次の差分',exact:true}).click();
  await page.screenshot({path:'ui-coverage-results/proofreading-columns.png'});
  await page.getByRole('button',{name:'最終結果を確定'}).click();
  await page.waitForFunction(()=>window.result!=='pending');
  assert.equal(await page.evaluate(()=>result),'new A\nkeep\nnew B');
  // A single selected skill produces exactly original / skill / final columns, also on small screens.
  await page.setViewportSize({width:600,height:800});
  await page.evaluate(()=>openReview('A\nB',[{id:'natural-japanese',content:'A\nnew B'}]));
  assert.equal(await page.locator('.proofreading-heading').count(),3);
  assert.equal(await page.locator('.proofreading-viewport').evaluate(el=>el.scrollWidth>el.clientWidth),true);
  await page.getByRole('button',{name:'natural-japaneseをすべて採用',exact:true}).click();
  await page.getByRole('button',{name:'最終結果を確定'}).click();
  await page.waitForFunction(()=>window.result==='A\nnew B');
  await page.evaluate(()=>openReview());
  await page.keyboard.press('Escape');
  await page.waitForFunction(()=>window.result===null);
  // Selected-text toolbar carries the selected skills through both rewrite and consultation.
  await page.setViewportSize({width:1100,height:800});
  for(const mode of ['rewrite','consult']){
    await page.evaluate(()=>askRewrite());
    await page.getByRole('combobox',{name:'AI操作',exact:true}).selectOption(mode);
    await page.locator('#selection-ai-action-dialog').getByRole('checkbox',{name:'yomiyasu',exact:true}).check();
    await page.locator('#selection-ai-action-dialog').getByRole('checkbox',{name:'japanese-tech-writing',exact:true}).check();
    await page.getByRole('textbox',{name:'相談内容・指示',exact:true}).fill('短くしてください');
    await page.getByRole('button',{name:'AIに送信',exact:true}).click();
    await page.waitForFunction(()=>window.action!=='pending');
    assert.deepEqual(await page.evaluate(()=>({mode:action.mode,skills:action.proofreading.profiles.map(p=>p.id)})),{mode,skills:['yomiyasu','japanese-tech-writing']});
  }
  // Independent window preserves existing choices, can exceed its opener, and returns the merged result.
  await page.evaluate(()=>openReview('old A\nkeep\nold B',[{id:'AI書き直し',content:'rewrite A\nkeep\nrewrite B'},{id:'yomiyasu',content:'polished A\nkeep\npolished B'}]));
  await page.getByRole('radio',{name:'差分1：AI書き直しを採用',exact:true}).check();
  const popupEvent=page.waitForEvent('popup');
  await page.getByRole('button',{name:'別ウィンドウで開く',exact:true}).click();
  const popup=await popupEvent;
  await popup.locator('#proofreading-dialog').waitFor();
  await popup.setViewportSize({width:1700,height:1000});
  assert.equal(await popup.getByRole('radio',{name:'差分1：AI書き直しを採用',exact:true}).isChecked(),true);
  assert.ok((await popup.locator('#proofreading-dialog').boundingBox()).width>1100);
  await popup.getByRole('radio',{name:'差分2：yomiyasuを採用',exact:true}).check();
  await popup.getByRole('button',{name:'最終結果を確定',exact:true}).click();
  await page.waitForFunction(()=>window.result==='rewrite A\nkeep\npolished B');
  // Closing the child keeps the opener and its existing selection available.
  await page.evaluate(()=>openReview());
  await page.getByRole('radio',{name:'差分1：yomiyasuを採用',exact:true}).check();
  const cancelPopupEvent=page.waitForEvent('popup');
  await page.getByRole('button',{name:'別ウィンドウで開く',exact:true}).click();
  const cancelPopup=await cancelPopupEvent;await cancelPopup.locator('#proofreading-dialog').waitFor();await cancelPopup.close();
  await page.waitForFunction(()=>[...document.querySelectorAll('#proofreading-dialog button')].find(button=>button.textContent==='別ウィンドウで開く')?.disabled===false);
  assert.equal(await page.getByRole('radio',{name:'差分1：yomiyasuを採用',exact:true}).isChecked(),true);
  await page.getByRole('button',{name:'ダイアログを最大化',exact:true}).click();
  assert.equal(await page.locator('#proofreading-dialog').evaluate(el=>el.classList.contains('dialog-expanded')),true);
  await page.keyboard.press('Escape');await page.waitForFunction(()=>window.result===null);
  assert.deepEqual(errors,[]);
  console.log('Proofreading columns: skill selection, alignment, mixed adoption, whole-column adoption, failure, responsive layout and cancellation passed.');
}finally{await browser?.close();server.kill();}
