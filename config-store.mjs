import { mkdirSync, lstatSync, readFileSync, chmodSync } from 'node:fs';
import { open, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { updateProvider } from './providers.mjs';

// Private local configuration, separate from experiment evidence and public files.
export function createConfigStore(file, config) {
  const dir = dirname(file);
  let saved = {};
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (!lstatSync(dir).isDirectory() || lstatSync(dir).isSymbolicLink()) throw new Error();
    chmodSync(dir, 0o700);
    try {
      const stat = lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32000) throw new Error();
      chmodSync(file, 0o600);
      const data = JSON.parse(readFileSync(file, 'utf8'));
      if (data.version !== 1 || !data.providers || typeof data.providers !== 'object') throw new Error();
      for (const mode of Object.keys(data.providers)) {
        if (!['llm', 'jev'].includes(mode)) throw new Error();
        const value = data.providers[mode];
        // Empty saved keys deliberately override environment keys after clearing.
        const updated = updateProvider({ ...config, [mode]: { ...config[mode], key: '' } }, { ...value, mode, clear: false });
        saved[mode] = { base: updated.base, model: updated.model, key: updated.key };
        config[mode] = updated;
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  } catch { throw new Error('无法读取本地模型配置，请检查 .local/config.json 的格式和权限；原文件未覆盖。'); }
  return {
    has: mode => Object.hasOwn(saved, mode),
    async save(mode, provider) {
      const next = { ...saved, [mode]: { base: provider.base, model: provider.model, key: provider.key } };
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        const handle = await open(temporary, 'wx', 0o600);
        try { await handle.writeFile(JSON.stringify({ version: 1, providers: next }, null, 2) + '\n'); await handle.sync(); }
        finally { await handle.close(); }
        await rename(temporary, file);
        saved = next;
      } finally { await rm(temporary, { force: true }); }
    }
  };
}
