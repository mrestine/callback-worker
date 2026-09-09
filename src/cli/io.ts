import { readFile } from 'node:fs/promises'

export async function readStdin(): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const c of process.stdin) chunks.push(c as Buffer)
  return Buffer.concat(chunks)
}

/** `undefined` / `-` → stdin; anything else → a file path. */
export async function readInput(arg: string | undefined): Promise<Buffer> {
  if (!arg || arg === '-') return readStdin()
  return readFile(arg)
}

/**
 * If the bytes are a Gmail `messages.get?format=raw` response
 * (`{ "raw": "<base64url of the .eml>" }`), decode to the .eml bytes.
 * Otherwise return them unchanged (already raw RFC822).
 */
export function toEml(buf: Buffer): Buffer {
  const s = buf.toString('utf8').trimStart()
  if (s.startsWith('{')) {
    try {
      const obj = JSON.parse(s) as { raw?: string }
      if (typeof obj.raw === 'string') return Buffer.from(obj.raw, 'base64url')
    } catch {
      /* not JSON — treat as raw .eml */
    }
  }
  return buf
}

/** First non-flag argv after the script name, or undefined. */
export function positionalArg(): string | undefined {
  const a = process.argv[2]
  return a && !a.startsWith('-') ? a : undefined
}

export function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i !== -1 ? process.argv[i + 1] : undefined
}

export function has(name: string): boolean {
  return process.argv.includes(name)
}
