/**
 * Turso Database Client
 * Used for member data persistence across serverless invocations
 *
 * Setup:
 * 1. Create account at https://turso.tech
 * 2. Create database: turso db create tvk-members
 * 3. Get URL: turso db show tvk-members --url
 * 4. Create token: turso db tokens create tvk-members
 * 5. Add to Vercel env vars: TURSO_DATABASE_URL, TURSO_AUTH_TOKEN
 */

import { createClient, type Client } from '@libsql/client'

let tursoClient: Client | null = null

// Initialize Turso client
export function getTurso(): Client {
  if (!tursoClient) {
    const url = process.env.TURSO_DATABASE_URL
    const authToken = process.env.TURSO_AUTH_TOKEN

    if (!url || !authToken) {
      throw new Error('TURSO_DATABASE_URL and TURSO_AUTH_TOKEN must be set')
    }

    tursoClient = createClient({ url, authToken })
  }
  return tursoClient
}

// Initialize Turso schema (run once)
export async function initTursoSchema(): Promise<void> {
  const client = getTurso()

  await client.execute(`
    CREATE TABLE IF NOT EXISTS members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      membership_id TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      phone TEXT NOT NULL,
      district TEXT NOT NULL,
      message TEXT,
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'rejected', 'active')),
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `)

  await client.execute(`
    CREATE INDEX IF NOT EXISTS idx_members_email ON members(email)
  `)

  await client.execute(`
    CREATE INDEX IF NOT EXISTS idx_members_status ON members(status)
  `)

  await client.execute(`
    CREATE INDEX IF NOT EXISTS idx_members_district ON members(district)
  `)
}

// ============== MEMBER OPERATIONS (Turso) ==============

export interface MemberRecord {
  id?: number
  membership_id: string
  name: string
  email: string
  phone: string
  district: string
  message?: string | null
  status: string
  created_at?: string
  updated_at?: string
}

export async function insertMemberTurso(member: Omit<MemberRecord, 'id' | 'created_at' | 'updated_at'>): Promise<{ success: boolean; id?: number; error?: string }> {
  const client = getTurso()

  try {
    const result = await client.execute({
      sql: `INSERT INTO members (membership_id, name, email, phone, district, message, status)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [
        member.membership_id,
        member.name,
        member.email,
        member.phone,
        member.district,
        member.message || null,
        member.status
      ]
    })

    return { success: true, id: Number(result.lastInsertRowid) }
  } catch (err: any) {
    if (err.message?.includes('UNIQUE constraint failed')) {
      return { success: false, error: 'Email already registered' }
    }
    console.error('Turso insert error:', err)
    return { success: false, error: err.message }
  }
}

export async function getMemberByEmailTurso(email: string): Promise<MemberRecord | null> {
  const client = getTurso()

  const result = await client.execute({
    sql: 'SELECT * FROM members WHERE email = ?',
    args: [email]
  })

  if (result.rows.length === 0) return null

  const row = result.rows[0]
  return {
    id: row.id as number,
    membership_id: row.membership_id as string,
    name: row.name as string,
    email: row.email as string,
    phone: row.phone as string,
    district: row.district as string,
    message: row.message as string | null,
    status: row.status as string,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  }
}

export async function getMembersTurso(options: {
  limit?: number
  offset?: number
  status?: string
  district?: string
} = {}): Promise<MemberRecord[]> {
  const client = getTurso()
  const { limit = 50, offset = 0, status, district } = options

  let sql = 'SELECT * FROM members WHERE 1=1'
  const args: any[] = []

  if (status) {
    sql += ' AND status = ?'
    args.push(status)
  }
  if (district) {
    sql += ' AND district = ?'
    args.push(district)
  }

  sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?'
  args.push(limit, offset)

  const result = await client.execute({ sql, args })

  return result.rows.map(row => ({
    id: row.id as number,
    membership_id: row.membership_id as string,
    name: row.name as string,
    email: row.email as string,
    phone: row.phone as string,
    district: row.district as string,
    message: row.message as string | null,
    status: row.status as string,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  }))
}

export async function getMemberCountTurso(status?: string): Promise<number> {
  const client = getTurso()

  let sql = 'SELECT COUNT(*) as count FROM members'
  const args: any[] = []

  if (status) {
    sql += ' WHERE status = ?'
    args.push(status)
  }

  const result = await client.execute({ sql, args })
  return result.rows[0].count as number
}

export async function updateMemberStatusTurso(membershipId: string, status: string): Promise<boolean> {
  const client = getTurso()

  try {
    await client.execute({
      sql: `UPDATE members SET status = ?, updated_at = datetime('now') WHERE membership_id = ?`,
      args: [status, membershipId]
    })
    return true
  } catch (err) {
    console.error('Turso update error:', err)
    return false
  }
}
