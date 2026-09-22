import { readFile } from 'node:fs/promises';
import { build, type Config } from './app.js';
process.umask(0o077);
const path=process.env.SKIN_CONFIG; if(!path)throw new Error('Set SKIN_CONFIG to a configuration file');
const config=JSON.parse(await readFile(path,'utf8')) as Config;
const app=await build(config);
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>void app.close());
await app.listen({host:config.listen,port:config.port});
