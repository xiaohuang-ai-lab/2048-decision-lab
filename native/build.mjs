import { spawnSync } from 'node:child_process';
import { mkdirSync, renameSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const source=JSON.parse(readFileSync(resolve(root,'vendor/nneonneo-2048-ai/SOURCE.json'),'utf8'));
for (const [file, hash] of Object.entries(source.sha256)) {
  if (createHash('sha256').update(readFileSync(resolve(root,'vendor/nneonneo-2048-ai',file))).digest('hex')!==hash) throw new Error('上游源码校验失败：'+file);
}
mkdirSync(resolve(root,'.build'),{recursive:true});
const output=resolve(root,'.build/nneonneo-2048');
const compiler=process.env.CXX || 'clang++';
const built=spawnSync(compiler,['-O3','-std=c++11','-I',resolve(root,'native'),resolve(root,'native/bridge.cpp'),'-o',output+'.tmp'],{stdio:'inherit'});
if (built.error || built.status!==0) { console.error('本地编译失败；需要已有 C++11 编译器，不会自动安装。'); process.exit(1); }
renameSync(output+'.tmp',output);
console.log('已编译 nneonneo/2048-ai @ '+source.commit+' → '+output);
