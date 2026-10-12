import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fingerprint,treeFingerprint} from './manual_ui_inventory.mjs';

export const sourcePaths=['apps/manual-studio/src','apps/manual-studio/index.html','apps/manual-studio/src-tauri/src','apps/manual-studio/src-tauri/tauri.conf.json','apps/manual-studio/src-tauri/Cargo.toml','crates/manual-core/src','crates/manual-core/Cargo.toml','crates/markits/apps/desktop/src','crates/markits/apps/desktop/src-tauri/src','crates/markits/apps/desktop/src-tauri/Cargo.toml','crates/markits/apps/desktop/package.json','crates/markits/apps/desktop/package-lock.json','crates/markits/src','crates/markits/Cargo.toml','Cargo.toml','Cargo.lock','package.json','package-lock.json','scripts'];
export async function verificationIdentity(root,bin=path.join(root,'target/debug')) {
  const sourceHash=await treeFingerprint(root,sourcePaths);
  const binary=await readFile(path.join(bin,process.platform==='win32'?'manual-studio.exe':'manual-studio'));
  const frontendHash=await treeFingerprint(root,['apps/manual-studio/dist']);
  return {sourceHash,buildHash:fingerprint(Buffer.concat([binary,Buffer.from(frontendHash)])),os:process.platform};
}
