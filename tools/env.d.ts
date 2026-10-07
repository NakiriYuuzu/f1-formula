// Minimal ambient declarations so tools/ type-checks without @types/node or bun-types.
declare module 'node:fs/promises' {
  export function readFile(path: string, enc: 'utf8'): Promise<string>;
  export function writeFile(path: string, data: string): Promise<void>;
  export function mkdir(path: string, opts?: { recursive?: boolean }): Promise<string | undefined>;
  export function stat(path: string): Promise<{ mtimeMs: number }>;
  export function utimes(path: string, atime: number, mtime: number): Promise<void>;
}
declare module 'node:crypto' {
  export function createHash(alg: string): { update(s: string): { digest(enc: 'hex'): string } };
}
declare const process: { argv: string[]; exit(code?: number): never; env: Record<string, string | undefined> };
declare const console: { log(...a: unknown[]): void; error(...a: unknown[]): void };
declare function setTimeout(fn: () => void, ms: number): unknown;
declare function fetch(
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
): Promise<{ ok: boolean; status: number; text(): Promise<string> }>;
declare class URLSearchParams {
  constructor(init: Record<string, string>);
  toString(): string;
}
declare class URL {
  constructor(url: string, base?: string);
  pathname: string;
}
interface ImportMeta {
  url: string;
}
