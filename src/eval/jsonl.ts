import * as fs from "node:fs";
import * as path from "node:path";

export function readJsonl(filePath: string): unknown[] {
  const raw = fs.readFileSync(filePath, "utf8");
  const rows: unknown[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    rows.push(JSON.parse(trimmed));
  }
  return rows;
}

export function writeJsonl<T>(filePath: string, rows: readonly T[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const body = rows.map((r) => JSON.stringify(r)).join("\n");
  fs.writeFileSync(filePath, rows.length > 0 ? body + "\n" : "");
}

export function appendJsonl<T>(filePath: string, row: T): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, JSON.stringify(row) + "\n");
}
