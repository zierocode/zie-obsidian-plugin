import { Vault, TFile } from 'obsidian';
import { sha256 } from '../utils/hash';

export interface FileChange {
    path: string;
    hash: string;
    modified: number;
}

export async function getLocalFiles(vault: Vault): Promise<Map<string, {hash: string; mtime: number}>> {
    const files = new Map<string, {hash: string; mtime: number}>();
    const markdowns = vault.getMarkdownFiles();

    // Hash in parallel chunks of 5 to avoid overwhelming crypto.subtle
    const chunks: TFile[][] = [];
    for (let i = 0; i < markdowns.length; i += 5) {
        chunks.push(markdowns.slice(i, i + 5));
    }
    for (const chunk of chunks) {
        const results = await Promise.all(
            chunk.map(async (f) => {
                const content = await vault.read(f);
                const hash = await sha256(content);
                return { path: f.path, hash, mtime: f.stat.mtime };
            })
        );
        for (const r of results) {
            files.set(r.path, { hash: r.hash, mtime: r.mtime });
        }
    }
    return files;
}

export function computeDiff(local: Map<string, {hash: string; mtime: number}>,
                              remote: FileChange[]): {toDownload: string[]; toUpload: string[]} {
    const toDownload: string[] = [];
    const toUpload: string[] = [];

    for (const rc of remote) {
        const lf = local.get(rc.path);
        if (!lf || lf.hash !== rc.hash) {
            toDownload.push(rc.path);
        }
    }

    for (const [path] of local) {
        const rf = remote.find(r => r.path === path);
        if (!rf && !path.startsWith('.')) {
            toUpload.push(path);
        }
    }

    return {toDownload, toUpload};
}
