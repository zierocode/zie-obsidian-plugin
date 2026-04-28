import esbuild from 'esbuild';

const prod = process.argv[2] === 'production';

esbuild.build({
    entryPoints: ['src/main.ts'],
    bundle: true,
    outfile: 'main.js',
    platform: 'browser',
    target: 'es2022',
    format: 'cjs',
    external: ['obsidian', 'electron'],
    sourcemap: prod ? false : 'inline',
    minify: prod,
    treeShaking: true,
}).catch(() => process.exit(1));
