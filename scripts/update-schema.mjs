import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, request } from '../src/core.mjs';

const pluginRoot = fileURLToPath(new URL('..', import.meta.url));
let output = path.join(pluginRoot, 'arcane-openapi.json');
let expectedVersion;

for (let index = 2; index < process.argv.length; index += 1) {
  const argument = process.argv[index];
  if (argument === '--output') {
    const value = process.argv[++index];
    if (!value || value.startsWith('--')) throw new Error('--output requires a path');
    output = path.resolve(value);
  } else if (argument === '--expect-version') {
    expectedVersion = process.argv[++index];
    if (!expectedVersion || expectedVersion.startsWith('--')) throw new Error('--expect-version requires a version');
  }
  else throw new Error(`Unknown argument: ${argument}`);
}

const config = loadConfig();
const schema = await request(config, { op: { method: 'GET' }, route: '/api/openapi.json', schemaDocument: true });

if (!schema.openapi?.startsWith('3.') || typeof schema.info?.version !== 'string' || !schema.paths || typeof schema.paths !== 'object') {
  throw new Error('Arcane returned an invalid OpenAPI document');
}
if (expectedVersion && schema.info.version !== expectedVersion) {
  throw new Error(`Expected Arcane ${expectedVersion}, received ${schema.info.version}`);
}

const operationCount = Object.values(schema.paths).reduce((total, item) => total
  + ['get', 'post', 'put', 'patch', 'delete'].filter(method => item[method]?.operationId).length, 0);
const temporary = `${output}.tmp-${process.pid}`;
try {
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(temporary, JSON.stringify(schema), { mode: 0o644, flag: 'wx' });
  fs.renameSync(temporary, output);
} catch (error) {
  try { fs.unlinkSync(temporary); } catch {}
  throw error;
}

console.log(JSON.stringify({
  output,
  version: schema.info.version,
  pathCount: Object.keys(schema.paths).length,
  operationCount
}));
