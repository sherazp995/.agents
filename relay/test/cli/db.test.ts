import { describe, expect, it, vi } from 'vitest'
import { runDbCreate, type DbCreateDependencies } from '../../src/cli/db.js'

const PASSWORD = "s3cr'et"
const URL_LOCAL = `postgres://relay_app:${encodeURIComponent(PASSWORD)}@localhost:5433/relay_db`

function deps(url: string, connects: boolean[], platform: NodeJS.Platform = 'linux') {
  const runPsql = vi.fn<NonNullable<DbCreateDependencies['runPsql']>>(async () => 0)
  const connect = vi.fn<NonNullable<DbCreateDependencies['connect']>>(async () => {
    if (connects.shift() === true) return { user: 'relay_app', database: 'relay_db' }
    throw new Error('role "relay_app" does not exist')
  })
  return { runPsql, connect, deps: { resolveUrl: async () => url, connect, runPsql, platform } satisfies DbCreateDependencies }
}

describe('runDbCreate', () => {
  it('does nothing when database.url already connects', async () => {
    const fake = deps(URL_LOCAL, [true])

    const result = await runDbCreate({ configPath: 'unused' }, fake.deps)

    expect(result).toEqual({ report: 'database.url already connects as relay_app to relay_db; nothing to do.', exitCode: 0 })
    expect(fake.runPsql).not.toHaveBeenCalled()
  })

  it('on linux runs sudo -u postgres psql with the SQL on stdin and no password in argv, then reconnects', async () => {
    const fake = deps(URL_LOCAL, [false, true])

    const result = await runDbCreate({ configPath: 'unused' }, fake.deps)

    expect(result.exitCode).toBe(0)
    expect(result.report).not.toContain('s3cr')
    const [command, args, sql] = fake.runPsql.mock.calls[0] ?? []
    expect(command).toBe('sudo')
    expect(args).toEqual(['-u', 'postgres', 'psql', '-v', 'ON_ERROR_STOP=1', '-p', '5433', '-d', 'postgres'])
    expect(args?.join(' ')).not.toContain('s3cr')
    expect(sql).toContain(`CREATE ROLE "relay_app" LOGIN PASSWORD 's3cr''et'`)
    expect(sql).toContain(`ALTER ROLE "relay_app" LOGIN PASSWORD 's3cr''et'`)
    expect(sql).toContain(`'CREATE DATABASE "relay_db" OWNER "relay_app"'`)
    expect(sql).toContain('\\gexec')
    expect(fake.connect).toHaveBeenCalledTimes(2)
  })

  it('on darwin runs psql directly as the operator', async () => {
    const fake = deps(URL_LOCAL, [false, true], 'darwin')

    await runDbCreate({ configPath: 'unused' }, fake.deps)

    expect(fake.runPsql.mock.calls[0]?.slice(0, 2)).toEqual(['psql', ['-h', 'localhost', '-v', 'ON_ERROR_STOP=1', '-p', '5433', '-d', 'postgres']])
  })

  it('refuses a host that is not this machine and prints the SQL without the password', async () => {
    const fake = deps(`postgres://relay_app:${encodeURIComponent(PASSWORD)}@db.example.com/relay_db`, [false])

    const result = await runDbCreate({ configPath: 'unused' }, fake.deps)

    expect(result.exitCode).toBe(1)
    expect(result.report).toContain('db.example.com is not this machine')
    expect(result.report).toContain('CREATE ROLE "relay_app"')
    expect(result.report).not.toContain('s3cr')
    expect(fake.runPsql).not.toHaveBeenCalled()
  })
})
