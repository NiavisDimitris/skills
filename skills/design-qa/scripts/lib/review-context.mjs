// Local handoff context. Keep paths relative in shared HTML; resolve configuration
// from the report location so the receiving agent need not use the renderer's cwd.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export function readReviewContext(file) {
  if (!existsSync(file)) return {};
  const match = /<script\b[^>]*\bid\s*=\s*["']design-qa-context["'][^>]*>([\s\S]*?)<\/script\s*>/i.exec(readFileSync(file, 'utf8'));
  try {
    const value = JSON.parse(match?.[1] ?? '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

export function resolveReviewConfig(reportFile, { explicit, htmlFile, generatedAt } = {}) {
  if (explicit) return path.resolve(explicit);
  const dir = path.dirname(path.resolve(reportFile));
  const context = readReviewContext(htmlFile ?? path.join(dir, 'report.html'));
  if (context.reportGeneratedAt === generatedAt && typeof context.configFromReport === 'string' && context.configFromReport) {
    return path.resolve(dir, context.configFromReport);
  }
  for (let current = dir; ; current = path.dirname(current)) {
    const file = path.join(current, 'design-qa.config.json');
    if (existsSync(file)) return file;
    if (path.dirname(current) === current) return null;
  }
}

export const shellArg = (value) => /^[A-Za-z0-9_./:@=-]+$/.test(String(value)) ? String(value) : "'" + String(value).replace(/'/g, "'\\''") + "'";
