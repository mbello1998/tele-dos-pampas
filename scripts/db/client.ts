import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { config } from 'dotenv'
import { Client } from 'pg'

config({ path: resolve(process.cwd(), '.env.local'), quiet: true })

export interface ConnectOptions {
  /** Abandons the TCP/TLS handshake after this long. Default 10s: a dead pooler must not hang callers. */
  connectionTimeoutMillis?: number
  /** Client-side cap per query (rejects, does not cancel the session). Off by default so migrations
   *  and long test transactions are unaffected; request paths opt in. Deliberately not the server's
   *  statement_timeout, which some poolers refuse as a startup parameter. */
  queryTimeoutMillis?: number
}

/** Connects over the Supabase pooler, verifying the certificate against the Supabase CA. */
export async function connect(options: ConnectOptions = {}): Promise<Client> {
  const url = process.env.SUPABASE_DB_URL
  const caPath = process.env.SUPABASE_DB_CA
  if (!url || !caPath) throw new Error('SUPABASE_DB_URL and SUPABASE_DB_CA must be set in .env.local')
  const client = new Client({
    connectionString: url,
    connectionTimeoutMillis: options.connectionTimeoutMillis ?? 10_000,
    ...(options.queryTimeoutMillis ? { query_timeout: options.queryTimeoutMillis } : {}),
    ssl: { ca: readFileSync(resolve(process.cwd(), caPath), 'utf8'), rejectUnauthorized: true },
  })
  await client.connect()
  return client
}
