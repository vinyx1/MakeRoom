// Loads server/.env into process.env, if it exists. Variables already set in the environment win.
import { existsSync } from 'node:fs';

const envFile = new URL('../.env', import.meta.url).pathname;
if (existsSync(envFile)) process.loadEnvFile(envFile);
