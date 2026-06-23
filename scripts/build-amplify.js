const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const out = path.join(root, '.amplify-hosting');
const staticOut = path.join(out, 'static');
const computeOut = path.join(out, 'compute', 'default');

const staticExtensions = new Set([
    '.html',
    '.png',
    '.jpg',
    '.jpeg',
    '.svg',
    '.xml',
    '.ico',
    '.txt',
    '.webmanifest',
]);

function copyFile(src, dest) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
}

function removeIfExists(target) {
    if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
}

function copyStaticFiles(destRoot) {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const ext = path.extname(entry.name).toLowerCase();
        if (!staticExtensions.has(ext)) continue;
        copyFile(path.join(root, entry.name), path.join(destRoot, entry.name));
    }
}

removeIfExists(out);
fs.mkdirSync(staticOut, { recursive: true });
fs.mkdirSync(computeOut, { recursive: true });

copyStaticFiles(staticOut);
copyStaticFiles(path.join(computeOut, 'static'));

for (const file of ['server.js', 'package.json', 'package-lock.json']) {
    const src = path.join(root, file);
    if (fs.existsSync(src)) copyFile(src, path.join(computeOut, file));
}

const nodeModules = path.join(root, 'node_modules');
if (!fs.existsSync(nodeModules)) {
    throw new Error('node_modules is required. Run npm ci or npm install before build:amplify.');
}
fs.cpSync(nodeModules, path.join(computeOut, 'node_modules'), { recursive: true });

const manifest = {
    version: 1,
    routes: [
        {
            path: '/api/*',
            target: { kind: 'Compute', src: 'default' },
        },
        {
            path: '/admin',
            target: { kind: 'Compute', src: 'default' },
        },
        {
            path: '/admin/*',
            target: { kind: 'Compute', src: 'default' },
        },
        {
            path: '/*.*',
            target: { kind: 'Static' },
            fallback: { kind: 'Compute', src: 'default' },
        },
        {
            path: '/*',
            target: { kind: 'Static' },
            fallback: { kind: 'Compute', src: 'default' },
        },
    ],
    computeResources: [
        {
            name: 'default',
            runtime: 'nodejs22.x',
            entrypoint: 'server.js',
        },
    ],
    framework: {
        name: 'express',
        version: '4',
    },
};

fs.writeFileSync(
    path.join(out, 'deploy-manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n',
);

console.log(`Amplify bundle created at ${path.relative(root, out)}`);
