import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { config } from 'dotenv'
import { Client } from 'pg'

config({ path: resolve(process.cwd(), '.env.local'), quiet: true })

/** Connects over the Supabase pooler, verifying the certificate against the Supabase CA. */
export async function connect(): Promise<Client> {
  const url = process.env.SUPABASE_DB_URL
  const caPath = process.env.SUPABASE_DB_CA
  if (!url || !caPath) throw new Error('SUPABASE_DB_URL and SUPABASE_DB_CA must be set in .env.local')
  const client = new Client({
    connectionString: url,
    ssl: { ca: readFileSync(resolve(process.cwd(), caPath), 'utf8'), rejectUnauthorized: true },
  })
  await client.connect()
  return client
}
