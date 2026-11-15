import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

const here = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(here, '../frontend/dist');
const PORT = Number(process.env.PORT) || 3000;

const app = express();

// API placeholder: nothing is implemented yet.
app.use('/api', (req, res) => {
  res.status(501).json({ error: { code: 'NOT_IMPLEMENTED', message: 'Not implemented' } });
});

// Built frontend (run `npm run build` first).
app.use(express.static(distDir));
app.use((req, res) => {
  res.sendFile(path.join(distDir, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
