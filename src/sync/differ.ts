export interface FileChange {
    path: string;
    hash: string;
    modified: number;
}

export async function getLocalFiles(vault: any): Promise<Map<string, {hash: string; mtime: number}>> {
    const files = new Map<string, {hash: string; mtime: number}>();
    const markdowns = vault.getMarkdownFiles();
    for (const f of markdowns) {
        const content = await vault.read(f);
        const { sha256 } = await import('../utils/hash');
        const hash = await sha256(content);
        files.set(f.path, {hash, mtime: f.stat.mtime});
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

    for (const [path, _info] of local) {
        const rf = remote.find(r => r.path === path);
        if (!rf && !path.startsWith('.')) {
            toUpload.push(path);
        }
    }

    return {toDownload, toUpload};
}
