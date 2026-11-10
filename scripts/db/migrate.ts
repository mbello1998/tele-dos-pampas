import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { connect } from './client'

const dir = resolve(process.cwd(), 'supabase/migrations')

async function main() {
  const client = await connect()
  try {
    await client.query(
      `create table if not exists public.schema_migrations (
         filename text primary key,
         applied_at timestamptz not null default now()
       )`,
    )
    await client.query('alter table public.schema_migrations enable row level security')
    const done = new Set(
      (await client.query<{ filename: string }>('select filename from public.schema_migrations')).rows.map(
        (r) => r.filename,
      ),
    )
    const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
    for (const f of files) {
      if (done.has(f)) {
        console.log(`skip   ${f}`)
        continue
      }
      await client.query('begin')
      try {
        await client.query(readFileSync(resolve(dir, f), 'utf8'))
        await client.query('insert into public.schema_migrations (filename) values ($1)', [f])
        await client.query('commit')
        console.log(`apply  ${f}`)
      } catch (e) {
        await client.query('rollback')
        throw new Error(`${f}: ${(e as Error).message}`)
      }
    }
    // seed.sql is idempotent (on conflict / where not exists), so it runs every time.
    await client.query(readFileSync(resolve(process.cwd(), 'supabase/seed.sql'), 'utf8'))
    console.log('seed   supabase/seed.sql')
  } finally {
    await client.end()
  }
}

main().catch((e) => {
  console.error(e.message)
  process.exit(1)
})
