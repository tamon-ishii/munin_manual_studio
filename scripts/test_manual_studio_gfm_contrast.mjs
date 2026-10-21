import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {chromium} from 'playwright-core';
const base='http://127.0.0.1:5188';
const root=await mkdtemp(path.join(tmpdir(),'munin-alert-contrast-'));
const markdown=['NOTE','TIP','IMPORTANT','WARNING','CAUTION'].map(kind=>`> [!${kind}]\n> 説明 **強調** text\n`).join('\n');
let server,browser;
try {
  await mkdir(path.join(root,'docs'));await writeFile(path.join(root,'docs/index.md'),markdown);
  server=spawn(process.execPath,['node_modules/vite/bin/vite.js','--config','apps/manual-studio/vite.config.ts','--port','5188','--strictPort'],{stdio:'ignore'});
  for(let i=0;i<100;i++){try{if((await fetch(base)).ok)break;}catch{}await new Promise(resolve=>setTimeout(resolve,100));}
  browser=await chromium.launch({channel:'chrome',headless:true});
  const page=await browser.newPage();page.setDefaultTimeout(30_000);
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/alert-contrast-test',route=>route.fulfill({contentType:'text/html',body:`<meta charset="UTF-8"><div><div class="column-label"></div><textarea id="source"></textarea></div><script type="module">
    import {setupMilkdownEditor} from '/src/milkdownEditor.ts';
    import {setupPreviewTheme} from '/src/themePreview.ts';
    import {applyTheme,themeOptions} from '/src/theme.ts';
    import '/src/style.css';
    window.applyTheme=applyTheme;window.themes=themeOptions;
    const preview=document.createElement('iframe');preview.id='alert-preview';document.body.append(preview);setupPreviewTheme(preview);
    applyTheme('charcoal',false);
    document.querySelector('textarea').value=['NOTE','TIP','IMPORTANT','WARNING','CAUTION'].map(kind=>'> [!'+kind+']\\n> 説明 **強調** text\\n').join('\\n');
    setupMilkdownEditor(document.querySelector('textarea'),message=>{throw Error(message);});
  </script>`}));
  await page.goto(`${base}/alert-contrast-test`);
  await page.waitForFunction(()=>document.querySelectorAll('.ProseMirror [data-gfm-alert]').length===5);
  const response=await page.request.post(`${base}/__manual/rpc`,{headers:{origin:'http://127.0.0.1:5174'},data:{root,action:'editor-preview',options:{page:'docs/index.md',body:markdown}}});
  const result=await response.json();assert.equal(result.error,undefined);
  await page.locator('#alert-preview').evaluate((frame,html)=>{frame.srcdoc=html;},result.output);
  await page.waitForFunction(()=>document.querySelector('#alert-preview').contentDocument?.querySelectorAll('blockquote[class^="markdown-alert-"]').length===5&&document.querySelector('#alert-preview').contentDocument?.getElementById('manual-studio-preview-theme'));
  for(const theme of await page.evaluate(()=>window.themes.map(item=>item.id))){
    const results=await page.evaluate(async theme=>{
      window.applyTheme(theme,false);
      await new Promise(resolve=>requestAnimationFrame(resolve));
      const luminance=color=>{
        const rgb=color.match(/[\d.]+/g).slice(0,3).map(Number).map(c=>{c/=color.startsWith('color(srgb')?1:255;return c<=.04045?c/12.92:((c+.055)/1.055)**2.4;});
        return rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722;
      };
      const alerts=[...document.querySelectorAll('.ProseMirror [data-gfm-alert]'),...document.querySelector('#alert-preview').contentDocument.querySelectorAll('blockquote[class^="markdown-alert-"]')];
      return alerts.map(alert=>{
        const background=getComputedStyle(alert).backgroundColor,bg=luminance(background);
        return {kind:alert.dataset.gfmAlert||`preview ${alert.className}`,background,ratios:[...alert.querySelectorAll('p,strong')].map(node=>{
          const color=getComputedStyle(node).color,fg=luminance(color);
          return {color,ratio:(Math.max(fg,bg)+.05)/(Math.min(fg,bg)+.05)};
        })};
      });
    },theme);
    assert.equal(results.length,10);
    for(const alert of results)for(const text of alert.ratios)assert.ok(text.ratio>=4.5,`${theme} ${alert.kind}: ${text.color} on ${alert.background} contrast ${text.ratio.toFixed(2)}`);
  }
  assert.deepEqual(errors,[]);
  console.log('GitHub alerts: all 5 types retain readable body/emphasis contrast in all 6 themes, in rich editing and actual rendered preview, including live theme changes.');
} finally {await browser?.close();server?.kill();await rm(root,{recursive:true,force:true});}
