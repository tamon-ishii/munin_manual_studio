import {spawnSync} from 'node:child_process';

const steps=[
  [process.execPath,['node_modules/typescript/bin/tsc','-p','apps/manual-studio/tsconfig.json','--noEmit']],
  [process.execPath,['node_modules/vite/bin/vite.js','build','--config','apps/manual-studio/vite.config.ts']],
  ['cargo',['build','-p','manual-studio']],
  [process.execPath,['scripts/test_manual_studio_dialogs_native.mjs']],
  [process.execPath,['scripts/test_manual_studio_proofreading_native.mjs']],
  [process.execPath,['scripts/test_manual_studio_dialog_presentation.mjs']],
  [process.execPath,['scripts/test_manual_studio_proofreading.mjs']],
  [process.execPath,['node_modules/jscpd/bin/jscpd','apps/manual-studio/src','apps/manual-studio/src-tauri/src','crates/manual-core/src','--config','.jscpd.json','--no-gitignore','--reporters','json','--output','ui-coverage-results/jscpd-after','--noTips','--silent']],
];
const skipBuild=process.argv.includes('--skip-build');
for(const [command,args] of skipBuild?steps.slice(3):steps){
  console.log(`\nVerifying: ${args.join(' ')}`);
  const quiet=args[0]==='node_modules/vite/bin/vite.js';
  const result=spawnSync(command,args,{stdio:quiet?'pipe':'inherit',encoding:quiet?'utf8':undefined,windowsHide:true});
  if(quiet)console.log(result.status===0?result.stdout.trim().split('\n').at(-1):result.stdout+result.stderr);
  if(result.error)throw result.error;
  if(result.status!==0)process.exit(result.status??1);
}
console.log('Dialog verification completed.');
