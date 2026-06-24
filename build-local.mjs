import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)));
const envPath = resolve(root, '.env');
const sourcePath = resolve(root, 'script.user.js');
const outputPath = resolve(root, 'script.local.user.js');

function readEnvKey() {
    const env = readFileSync(envPath, 'utf8');
    const match = env.match(/^BASELINKER_API_KEY=(.+)$/m);
    if (!match) {
        throw new Error('Brak BASELINKER_API_KEY w pliku .env');
    }
    return match[1].trim();
}

const apiKey = readEnvKey();
let script = readFileSync(sourcePath, 'utf8');

const bootstrap = `
    (function bootstrapApiToken() {
        const key = ${JSON.stringify(apiKey)};
        if (!GM_getValue('baselinker_api_token', '')) {
            GM_setValue('baselinker_api_token', key);
        }
    })();
`;

script = script.replace(
    "(function () {\n    'use strict';",
    `(function () {\n    'use strict';\n${bootstrap}`
);

writeFileSync(outputPath, script, 'utf8');
console.log(`Wygenerowano ${outputPath}`);
