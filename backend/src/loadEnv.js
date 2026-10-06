import { config } from 'dotenv';

// Load .env before any module reads process.env. dotenv logs every load to stderr
// by default; quiet keeps the startup log clean.
config({ quiet: true });
