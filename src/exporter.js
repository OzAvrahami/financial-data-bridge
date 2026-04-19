import { writeFile, mkdir } from 'fs/promises';
import { dirname } from 'path';

export async function exportToJSON(transactions, filePath) {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(transactions, null, 2), 'utf-8');
}
