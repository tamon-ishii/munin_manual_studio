import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,chmod,rm,symlink} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import os from 'node:os';
const execute = promisify(execFile);
const root = await mkdtemp(path.join(os.tmpdir(),'munin-build-input-'));
try {
  await mkdir(path.join(root,'docs/sub'),{recursive:true});
  await mkdir(path.join(root,'media/shots'),{recursive:true});
  await mkdir(path.join(root,'.venv/bin'),{recursive:true});
  const original = '# Guide\n\n[Readme](../../README.md#feature)\n\n![Shot](../../media/shots/shot.png)\n\n![Ref][picture]\n\n[picture]: ../../media/shots/shot.png "Title"\n\n<img src="../../media/shots/shot.png" alt="Raw">\n';
  await writeFile(path.join(root,'docs/sub/index.md'),original);
  await writeFile(path.join(root,'docs/index.md'),'# Home\n\n[Guide](sub/index.md)\n');
  await writeFile(path.join(root,'README.md'),'# Project\n\n![Shot](media/shots/shot.png)\n');
  await writeFile(path.join(root,'media/shots/shot.png'),Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXWQAAAAASUVORK5CYII=','base64'));
  await writeFile(path.join(root,'manual_setting.json'),JSON.stringify({docs:'docs',output:'manual',assets:'media/shots',targets:['docs','README.md']}));
  const report = path.join(root,'report.json');
  const mkdocs = path.join(root,'.venv/bin/mkdocs');
  // Record the exact input handed to MkDocs, without depending on its installation.
  await writeFile(mkdocs,`#!/usr/bin/python3\nimport pathlib,sys,json\ndocs=pathlib.Path.cwd()/'docs'\nfiles={str(p.relative_to(docs)):p.read_text() for p in docs.rglob('*') if p.is_file() and p.suffix=='.md'}\nassets=[str(p.relative_to(docs)) for p in docs.rglob('*.png')]\npathlib.Path(${JSON.stringify(report)}).write_text(json.dumps({'pages':files,'assets':assets}))\nout=pathlib.Path(sys.argv[sys.argv.index('-d')+1]);out.mkdir();(out/'index.html').write_text('<h1>Site</h1>')\n`);
  await chmod(mkdocs,0o755);
  const rpc = async action => execute(path.resolve('target/debug/manualctl'),['--request',JSON.stringify({root,action,options:{draft:true}})]);
  const {stdout} = await rpc('build-mkdocs'); assert.match(stdout,/Site:/);
  const staged = JSON.parse(await readFile(report,'utf8'));
  assert.ok(staged.pages['_external/README.md']);
  assert.ok(staged.assets.includes('_assets/media/shots/shot.png'));
  const guide = staged.pages['sub/index.md'];
  assert.match(guide,/\.\.\/_external\/README.md#feature/);
  assert.equal((guide.match(/\.\.\/_assets\/media\/shots\/shot.png/g)||[]).length,3,'inline, reference and HTML images are rewritten');
  assert.match(staged.pages['_external/README.md'],/\.\.\/_assets\/media\/shots\/shot.png/);
  assert.equal(await readFile(path.join(root,'docs/sub/index.md'),'utf8'),original,'source stays untouched');
  if (process.env.MUNIN_REAL_MKDOCS) {
    await rm(mkdocs); await symlink(process.env.MUNIN_REAL_MKDOCS,mkdocs);
    // The fake site is unmanaged; remove only the test's generated output.
    await rm(path.join(root,'manual'),{recursive:true,force:true});
    const result = await rpc('build-mkdocs'); assert.match(result.stdout,/Site:/);
    assert.match(await readFile(path.join(root,'manual/sub/index.html'),'utf8'), /_assets\/media\/shots\/shot.png/);
    assert.match(await readFile(path.join(root,'manual/_external/index.html'),'utf8'), /_assets\/media\/shots\/shot.png/);
    assert.ok((await readFile(path.join(root,'manual/_assets/media/shots/shot.png'))).length > 0);
    console.log('Real MkDocs Material checks passed: HTML and linked assets exist.');
  }
  console.log('MkDocs input checks passed: targets, external README, custom assets, cross-page links, inline/reference/HTML images.');
} finally { await rm(root,{recursive:true,force:true}); }
