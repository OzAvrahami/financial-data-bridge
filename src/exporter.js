import { writeFile, rename, mkdir } from 'fs/promises';
import { dirname } from 'path';

/**
 * Write transactions to a JSON file.
 *
 * Uses a write-then-rename pattern: data is written to {filePath}.tmp first,
 * then renamed to the final path. If the process dies between write and rename,
 * the .tmp file is left on disk for inspection but the final file is intact.
 */
export async function exportToJSON(transactions, filePath) {
  await mkdir(dirname(filePath), { recursive: true });
  const tmpPath = filePath + '.tmp';
  await writeFile(tmpPath, JSON.stringify(transactions, null, 2), 'utf-8');
  await rename(tmpPath, filePath);
}
