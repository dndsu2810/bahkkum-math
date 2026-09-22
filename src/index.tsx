import { Hono } from 'hono'

import { cors } from 'hono/cors'

import { serveStatic } from 'hono/cloudflare-workers'



type Bindings = {

  DB: D1Database

  KAKAOWORK_WEBHOOK_MATH: string     // 수학 카카오워크 웹훅 URL

  KAKAOWORK_WEBHOOK_ENGLISH: string  // 영어 카카오워크 웹훅 URL

  SLACK_BOT_TOKEN: string
  SLACK_WEBHOOK_ORDER: string        // (선택) 주문·환불 알림 슬랙 Incoming Webhook. 없으면 수학 카카오워크

  SLACK_CHANNEL_ID: string

  NOTION_API_KEY: string

  NOTION_DATABASE_ID: string

  ADMIN_PASSWORD: string

  EXTERNAL_POINTS_KEY: string     // 쏘이지(soez) → 키오스크 포인트 적립 연동용 서비스키

  SOEZ_BASE_URL: string           // (선택) 쏘이지 수학야구 API 베이스 URL — 설정 시 띵똥이 PULL
  SOEZ_READ_TOKEN: string         // (선택) 쏘이지 키오스크 전용 읽기 토큰

}



const app = new Hono<{ Bindings: Bindings }>()

app.use('/static/*', serveStatic({ root: './' }))

app.use('/api/*', cors({
  origin: ['https://bakuum-kiosk.pages.dev'],
  allowMethods: ['GET', 'POST', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'X-Admin-Password'],
}))



// ── 관리자 인증 미들웨어 ──────────────────────────────────────────────────────

app.use('/api/admin/*', async (c, next) => {

  const pw = c.req.header('X-Admin-Password') || ''

  const correct = c.env.ADMIN_PASSWORD || '1234'

  if (pw !== correct) return c.json({ success: false, error: '인증 실패' }, 401)

  await next()

})



// ══════════════════════════════════════════════════════════════════════════════

//  API: 공개

// ══════════════════════════════════════════════════════════════════════════════



// 키오스크 설정 조회 (DB 우선, 없으면 DEFAULT_CONFIG)
app.get('/api/config', async (c) => {

  try {

    const row = await c.env.DB.prepare(

      "SELECT value FROM app_config WHERE key='kiosk_config'"

    ).first() as any

    if (row?.value) {

      return c.json(JSON.parse(row.value))

    }

  } catch (_) {}

  return c.json(DEFAULT_CONFIG)

})






// ── 특정 키만 원자적으로 업데이트 (레이스 컨디션 방지) ─────────────────────────
app.post('/api/admin/config-key', async (c) => {

  try {

    const body = await c.req.json()
    const { key, value } = body

    if (!key) return c.json({ success: false, error: 'key 필요' }, 400)

    // 현재 config 읽기
    const row = await c.env.DB.prepare(
      "SELECT value FROM app_config WHERE key='kiosk_config'"
    ).first() as any

    const cfg = row?.value ? JSON.parse(row.value) : {}

    // 해당 키만 업데이트
    cfg[key] = value

    await c.env.DB.prepare(
      "INSERT INTO app_config (key, value, updated_at) VALUES ('kiosk_config', ?, CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP"
    ).bind(JSON.stringify(cfg)).run()

    return c.json({ success: true })

  } catch (e: any) {

    return c.json({ success: false, error: e.message }, 500)

  }

})


// 관리자 설정 저장 (DB에 저장 → 모든 기기에서 즉시 반영)
app.post('/api/admin/config', async (c) => {

  try {

    const body = await c.req.json()

    // 기존 config 읽어서 mogak 데이터 보존 (병합 저장)
    const row = await c.env.DB.prepare(
      "SELECT value FROM app_config WHERE key='kiosk_config'"
    ).first() as any

    const existing = row?.value ? JSON.parse(row.value) : {}

    // mogak 관련 키는 body에 없어도 보존
    const PRESERVE_KEYS = [
      'mogak_students', 'mogak_nicknames', 'kiosk_cats',
      'mogakgong_pending', 'mogakgong_done',
    ]
    const merged: any = { ...body }
    for (const key of PRESERVE_KEYS) {
      if (existing[key] !== undefined && merged[key] === undefined) {
        merged[key] = existing[key]
      }
    }
    // mogakgong_ 날짜 키도 보존 (done, mission 데이터)
    for (const key of Object.keys(existing)) {
      if (key.startsWith('mogakgong_') && merged[key] === undefined) {
        merged[key] = existing[key]
      }
    }

    await c.env.DB.prepare(
      "INSERT INTO app_config (key, value, updated_at) VALUES ('kiosk_config', ?, CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP"
    ).bind(JSON.stringify(merged)).run()

    return c.json({ success: true })

  } catch (e: any) {

    return c.json({ success: false, error: e.message }, 500)

  }

})



// ── 상점 잠금 상태 조회 (키오스크용) ──────────────────────────────────────────
// 시간 범위 체크 헬퍼
function checkSlots(slots: any[], dayName: string, hhmm: number): boolean {
  for (const slot of slots) {
    if ((slot.day || '') !== dayName) continue
    const [sh, sm] = (slot.start || '00:00').split(':').map(Number)
    const [eh, em] = (slot.end || '00:00').split(':').map(Number)
    if (hhmm >= sh * 100 + sm && hhmm < eh * 100 + em) return true
  }
  return false
}

function parseSlots(value: string): any[] {
  try {
    const parsed = JSON.parse(value)
    if (Array.isArray(parsed)) return parsed
    if (Array.isArray(parsed.schedule)) return parsed.schedule
    if (Array.isArray(parsed.slots)) return parsed.slots
  } catch (_) {}
  return []
}

app.get('/api/shop/status', async (c) => {

  try {
    // student_id 쿼리 파라미터 (있으면 학생별 스케줄 우선, 없으면 전체 스케줄)
    const studentId = c.req.query('student_id')

    const DAYS_KO = ['일','월','화','수','목','금','토']
    const now = new Date(Date.now() + 9 * 3600 * 1000)
    const dayName = DAYS_KO[now.getUTCDay()]
    const hhmm = now.getUTCHours() * 100 + now.getUTCMinutes()

    let isClassTime = false

    if (studentId) {
      // 1순위: 학생 개인 시간표
      const stuSched = await c.env.DB.prepare(
        'SELECT schedule_json FROM student_schedules WHERE student_id=?'
      ).bind(studentId).first() as any

      if (stuSched?.schedule_json) {
        const slots = parseSlots(stuSched.schedule_json)
        if (slots.length > 0) {
          isClassTime = checkSlots(slots, dayName, hhmm)
        } else {
          // 개인 시간표가 비어있으면 전체 시간표 fallback
          const globalSched = await c.env.DB.prepare(
            "SELECT value FROM app_config WHERE key='class_schedule'"
          ).first() as any
          if (globalSched?.value) isClassTime = checkSlots(parseSlots(globalSched.value), dayName, hhmm)
        }
      } else {
        // 개인 시간표 없으면 전체 시간표
        const globalSched = await c.env.DB.prepare(
          "SELECT value FROM app_config WHERE key='class_schedule'"
        ).first() as any
        if (globalSched?.value) isClassTime = checkSlots(parseSlots(globalSched.value), dayName, hhmm)
      }
    } else {
      // student_id 없으면 전체 시간표
      const schedRow = await c.env.DB.prepare(
        "SELECT value FROM app_config WHERE key='class_schedule'"
      ).first() as any
      if (schedRow?.value) isClassTime = checkSlots(parseSlots(schedRow.value), dayName, hhmm)
    }

    // 잠금해제 요청: student_id가 있으면 해당 학생 것만 확인
    let unlockQuery = "SELECT * FROM shop_unlock_requests WHERE status='approved' AND expires_at > datetime('now')"
    let unlockRow: any
    if (studentId) {
      unlockRow = await c.env.DB.prepare(unlockQuery + ' AND student_id=? ORDER BY expires_at DESC LIMIT 1')
        .bind(studentId).first() as any
      // 학생 id 매칭 안 되면 전체 승인도 확인
      if (!unlockRow) {
        unlockRow = await c.env.DB.prepare(unlockQuery + ' AND student_id IS NULL ORDER BY expires_at DESC LIMIT 1')
          .first() as any
      }
    } else {
      unlockRow = await c.env.DB.prepare(unlockQuery + ' ORDER BY expires_at DESC LIMIT 1').first() as any
    }

    const unlocked = !!unlockRow
    const expiresAt = unlockRow?.expires_at || null

    // 강제 잠금 상태 확인
    const forceLockRow = await c.env.DB.prepare(
      "SELECT value FROM app_config WHERE key='force_lock'"
    ).first() as any
    const forceLocked = forceLockRow?.value === '1'

    // 완전 오픈 상태 확인 (관리자가 시간 제한 없이 열어둔 경우)
    const forceOpenRow = await c.env.DB.prepare(
      "SELECT value FROM app_config WHERE key='force_open'"
    ).first() as any
    const forceOpen = forceOpenRow?.value === '1'

    // 잠금 여부 계산
    // force_open이면 무조건 열림
    // forceLocked 또는 수업시간이면 잠김 (단, unlocked 승인이 있으면 열림)
    const locked = !forceOpen && (forceLocked || isClassTime) && !unlocked

    return c.json({ success: true, isClassTime, forceLocked, forceOpen, locked, unlocked, expiresAt })

  } catch (e: any) {

    return c.json({ success: true, isClassTime: false, locked: false, unlocked: false, expiresAt: null })

  }

})



// ── 상점 잠금해제 요청 (키오스크) ─────────────────────────────────────────────
app.post('/api/shop/request-unlock', async (c) => {

  try {

    const { studentName, studentId } = await c.req.json()

    if (!studentName) return c.json({ success: false, error: '학생 이름 필요' }, 400)

    const existing = await c.env.DB.prepare(
      "SELECT id FROM shop_unlock_requests WHERE status='pending' AND student_name=? AND requested_at > datetime('now','-5 minutes')"
    ).bind(studentName).first() as any

    if (existing) return c.json({ success: true, requestId: existing.id, alreadyPending: true })

    const result = await c.env.DB.prepare(
      "INSERT INTO shop_unlock_requests (student_name, student_id, status) VALUES (?, ?, 'pending')"
    ).bind(studentName, studentId || null).run() as any

    try { await sendShopUnlockSlack(c.env, studentName) } catch (_) {}

    return c.json({ success: true, requestId: result.meta?.last_row_id })

  } catch (e: any) {

    return c.json({ success: false, error: e.message }, 500)

  }

})



// ── 관리자: 잠금해제 승인 ─────────────────────────────────────────────────────
app.post('/api/admin/shop/unlock', async (c) => {

  try {

    const { requestId, minutes } = await c.req.json()

    const mins = minutes || 10

    await c.env.DB.prepare(
      `UPDATE shop_unlock_requests SET status='approved', unlocked_at=datetime('now'), expires_at=datetime('now','+${mins} minutes') WHERE id=?`
    ).bind(requestId).run()

    return c.json({ success: true, minutes: mins })

  } catch (e: any) {

    return c.json({ success: false, error: e.message }, 500)

  }

})



// ── 관리자: 상점 즉시 잠금 ────────────────────────────────────────────────────
// ── 관리자: 상점 직접 열기 (승인 요청 없이) ───────────────────────────────────
app.post('/api/admin/shop/direct-unlock', async (c) => {
  try {
    const { minutes = 10, mode = 'timed' } = await c.req.json()
    // force_lock 해제
    await c.env.DB.prepare(
      "INSERT INTO app_config (key, value, updated_at) VALUES ('force_lock', '0', CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value='0', updated_at=CURRENT_TIMESTAMP"
    ).run()
    // 기존 승인된 것 만료 처리
    await c.env.DB.prepare(
      "UPDATE shop_unlock_requests SET status='expired' WHERE status='approved'"
    ).run()
if (mode === 'schedule') {
      // 시간표 모드: 강제 잠금/오픈 모두 해제 → 시간표가 자동 운영
      await c.env.DB.prepare(
        "INSERT INTO app_config (key, value, updated_at) VALUES ('force_lock', '0', CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value='0', updated_at=CURRENT_TIMESTAMP"
      ).run()
      await c.env.DB.prepare(
        "INSERT INTO app_config (key, value, updated_at) VALUES ('force_open', '0', CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value='0', updated_at=CURRENT_TIMESTAMP"
      ).run()
      await c.env.DB.prepare(
        "UPDATE shop_unlock_requests SET status='expired' WHERE status='approved'"
      ).run()
      return c.json({ success: true, mode: 'schedule' })
    }
    if (mode === 'permanent') {
      // 완전 오픈: force_open=1 저장 (시간 제한 없음)
      await c.env.DB.prepare(
        "INSERT INTO app_config (key, value, updated_at) VALUES ('force_open', '1', CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value='1', updated_at=CURRENT_TIMESTAMP"
      ).run()
    } else {
      // 시간 제한 열기
      const mins = Math.max(1, Math.min(480, parseInt(minutes) || 10))
      await c.env.DB.prepare(
        "INSERT INTO app_config (key, value, updated_at) VALUES ('force_open', '0', CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value='0', updated_at=CURRENT_TIMESTAMP"
      ).run()
      await c.env.DB.prepare(
        `INSERT INTO shop_unlock_requests (student_name, student_id, status, unlocked_at, expires_at) VALUES ('관리자 직접 열기', NULL, 'approved', datetime('now'), datetime('now','+${mins} minutes'))`
      ).run()
    }
    return c.json({ success: true, mode })
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500)
  }
})

app.post('/api/admin/shop/lock', async (c) => {
  try {
    // 강제 잠금 ON + force_open OFF
    await c.env.DB.prepare(
      "INSERT INTO app_config (key, value, updated_at) VALUES ('force_lock', '1', CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value='1', updated_at=CURRENT_TIMESTAMP"
    ).run()
    await c.env.DB.prepare(
      "INSERT INTO app_config (key, value, updated_at) VALUES ('force_open', '0', CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value='0', updated_at=CURRENT_TIMESTAMP"
    ).run()
    // 열려있는 잠금해제 요청도 모두 만료
    await c.env.DB.prepare(
      "UPDATE shop_unlock_requests SET status='expired' WHERE status='approved'"
    ).run()
    return c.json({ success: true })
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500)
  }
})



// ── 관리자: 잠금해제 요청 목록 ────────────────────────────────────────────────
app.get('/api/admin/shop/requests', async (c) => {

  try {

    const rows = await c.env.DB.prepare(
      "SELECT * FROM shop_unlock_requests ORDER BY requested_at DESC LIMIT 50"
    ).all()

    return c.json({ success: true, requests: rows.results })

  } catch (e: any) {

    return c.json({ success: false, error: e.message }, 500)

  }

})



// ── 관리자: 수업 시간표 저장 ──────────────────────────────────────────────────
// ── 수업 시간표 조회 ──────────────────────────────────────────────────────────
app.get('/api/admin/shop/schedule', async (c) => {
  try {
    const row = await c.env.DB.prepare(
      "SELECT value FROM app_config WHERE key='class_schedule'"
    ).first<{ value: string }>()
    if (!row) return c.json({ success: true, schedule: [] })
    const parsed = JSON.parse(row.value)
    // body가 {schedule:[...]} 형태이거나 그냥 배열인 경우 모두 처리
    const schedule = Array.isArray(parsed) ? parsed : (parsed.schedule || [])
    return c.json({ success: true, schedule })
  } catch (e: any) {
    return c.json({ success: false, schedule: [], error: e.message })
  }
})

app.post('/api/admin/shop/schedule', async (c) => {

  try {

    const body = await c.req.json()

    await c.env.DB.prepare(
      "INSERT INTO app_config (key, value, updated_at) VALUES ('class_schedule', ?, CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP"
    ).bind(JSON.stringify(body)).run()

    return c.json({ success: true })

  } catch (e: any) {

    return c.json({ success: false, error: e.message }, 500)

  }

})



// ── 상점 잠금해제 Slack 알림 ──────────────────────────────────────────────────
async function sendShopUnlockSlack(env: Bindings, studentName: string) {
  const now = new Date(Date.now() + 9*3600*1000)
  const ts = String(now.getUTCHours()).padStart(2,'0') + ':' + String(now.getUTCMinutes()).padStart(2,'0')
  await sendKW(kwMath(env), '[상점 잠금해제] ' + studentName + '\n관리자 페이지에서 승인해주세요 · ' + ts)
}

// 상점 남은 재고 조회 (키오스크용)
app.get('/api/shop/stock', async (c) => {
  try {
    const today = getKSTDate()
    const monthKey = today.slice(0, 7)
    const rows = await c.env.DB.prepare(
      "SELECT item_id, remaining_stock, initial_stock FROM shop_stock WHERE month_key=?"
    ).bind(monthKey).all()
    const stock: Record<string, { remaining: number; initial: number }> = {}
    for (const row of (rows.results as any[])) {
      stock[row.item_id] = { remaining: Number(row.remaining_stock), initial: Number(row.initial_stock) }
    }
    return c.json({ success: true, stock, monthKey })
  } catch (e: any) {
    return c.json({ success: false, stock: {}, error: e.message })
  }
})
 
// 이번 달 재고 채우기 (관리자용)
app.post('/api/admin/shop/restock', async (c) => {
  try {
    const today = getKSTDate()
    const monthKey = today.slice(0, 7)
    const configRow = await c.env.DB.prepare(
      "SELECT value FROM app_config WHERE key='kiosk_config'"
    ).first() as any
    if (!configRow?.value) return c.json({ success: false, error: '설정 없음' }, 400)
    const config = JSON.parse(configRow.value)
    const shopItems: any[] = config.menu?.shop || []
    let count = 0
    for (const item of shopItems) {
      if ((item.monthlyStock || 0) > 0) {
        await c.env.DB.prepare(
          `INSERT INTO shop_stock (item_id, month_key, initial_stock, remaining_stock, updated_at)
           VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
           ON CONFLICT(item_id, month_key) DO UPDATE SET
           initial_stock = excluded.initial_stock,
           remaining_stock = excluded.remaining_stock,
           updated_at = CURRENT_TIMESTAMP`
        ).bind(item.id, monthKey, item.monthlyStock, item.monthlyStock).run()
        count++
      }
    }
    return c.json({ success: true, monthKey, itemsRestocked: count })
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500)
  }
})





// 학생 목록 (포인트 + 벌금 유형별 집계 포함)

app.get('/api/students', async (c) => {
  try {
    // 수업관리 앱과 공유하는 과목 정보 테이블 (없으면 생성 — 명단이 항상 뜨도록 하는 안전장치)
    await c.env.DB.prepare("CREATE TABLE IF NOT EXISTS class_student_meta (student_id TEXT PRIMARY KEY, online_id TEXT NOT NULL DEFAULT '', subjects TEXT NOT NULL DEFAULT '', english_band TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL DEFAULT 0)").run()
    // 수학 학생만 표시: 과목 정보가 없거나(=기존 수학생) 'math'를 포함하면 표시, '영어 전용'만 제외
    const rows = await c.env.DB.prepare(`
      SELECT s.id, s.name, s.photo_url, s.points,
        COALESCE(SUM(CASE WHEN f.paid=0 THEN f.amount ELSE 0 END),0) AS unpaid_fines,
        COUNT(CASE WHEN f.paid=0 THEN 1 END) AS fine_count,
        COALESCE(SUM(CASE WHEN f.paid=0 AND f.fine_type='time' THEN f.amount ELSE 0 END),0) AS fine_time,
        COALESCE(SUM(CASE WHEN f.paid=0 AND f.fine_type='sheet' THEN f.amount ELSE 0 END),0) AS fine_sheet,
        COALESCE(SUM(CASE WHEN f.paid=0 AND f.fine_type='point' THEN f.amount ELSE 0 END),0) AS fine_point
      FROM students s
      LEFT JOIN fines f ON f.student_id = s.id
      LEFT JOIN class_student_meta m ON m.student_id = CAST(s.id AS TEXT)
      WHERE (m.subjects IS NULL OR m.subjects = '' OR m.subjects = '[]' OR m.subjects LIKE '%math%')
      GROUP BY s.id ORDER BY s.name
    `).all()
    return c.json({ success: true, students: rows.results })
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500)
  }
})



// 학생 상세 (포인트 이력 + 벌금 내역)

app.get('/api/students/:id', async (c) => {

  const id = c.req.param('id')

  try {

    const stu = await c.env.DB.prepare('SELECT * FROM students WHERE id=?').bind(id).first()

    if (!stu) return c.json({ success: false, error: '학생 없음' }, 404)

    const history = await c.env.DB.prepare(

      'SELECT * FROM point_history WHERE student_id=? ORDER BY created_at DESC LIMIT 30'

    ).bind(id).all()

    const fines = await c.env.DB.prepare(

      'SELECT * FROM fines WHERE student_id=? ORDER BY created_at DESC'

    ).bind(id).all()

    // 벌금 유형별 미납 합계

    const fineStats = await c.env.DB.prepare(`

      SELECT

        COALESCE(SUM(CASE WHEN fine_type='time' AND paid=0 THEN amount ELSE 0 END),0) AS fine_time,

        COALESCE(SUM(CASE WHEN fine_type='sheet' AND paid=0 THEN amount ELSE 0 END),0) AS fine_sheet,

        COALESCE(SUM(CASE WHEN fine_type='point' AND paid=0 THEN amount ELSE 0 END),0) AS fine_point

      FROM fines WHERE student_id=?

    `).bind(id).first()

    return c.json({ success: true, student: stu, history: history.results, fines: fines.results, fineStats })

  } catch (e: any) {

    return c.json({ success: false, error: e.message }, 500)

  }

})



// 키오스크 제출 (포인트 자동 반영)

// ── 쏘이지(soez) → 키오스크 포인트 미러링 ────────────────────────────────────
// 쏘이지에서 수학 학생 적립/감점(+/-)이 발생하면 같은 금액을 키오스크에도 반영.
// 인증: X-Service-Key 헤더 == EXTERNAL_POINTS_KEY. 이름으로 학생을 찾고,
// 키오스크 로스터(=수학 학생)에 없는 이름은 무시(no-op). eventId로 멱등 처리(재전송 중복 방지).
// 키오스크의 사용(상점·벌금 차감)은 쏘이지로 보내지 않음(단방향).
app.post('/api/points/external', async (c) => {

  try {

    const key = c.req.header('X-Service-Key') || ''

    if (!c.env.EXTERNAL_POINTS_KEY || key !== c.env.EXTERNAL_POINTS_KEY) {
      return c.json({ success: false, error: 'unauthorized' }, 401)
    }

    const body = await c.req.json()
    const name = (body.name || '').toString().trim()
    const delta = Number(body.delta) || 0
    const reason = (body.reason || '쏘이지 적립').toString().slice(0, 60)
    const eventId = (body.eventId || '').toString().trim()

    if (!name || !delta) return c.json({ success: false, error: '필수 값 누락' }, 400)

    await c.env.DB.prepare(
      'CREATE TABLE IF NOT EXISTS point_sync_seen (event_id TEXT PRIMARY KEY, created_at TEXT DEFAULT CURRENT_TIMESTAMP)'
    ).run()

    if (eventId) {
      const seen = await c.env.DB.prepare('SELECT event_id FROM point_sync_seen WHERE event_id=?').bind(eventId).first()
      if (seen) return c.json({ success: true, matched: true, duplicate: true })
    }

    const stu = await c.env.DB.prepare('SELECT id FROM students WHERE name=?').bind(name).first() as any

    if (!stu) {
      if (eventId) await c.env.DB.prepare('INSERT OR IGNORE INTO point_sync_seen (event_id) VALUES (?)').bind(eventId).run()
      return c.json({ success: true, matched: false })
    }

    const stmts = [
      c.env.DB.prepare('UPDATE students SET points = points + ? WHERE id=?').bind(delta, stu.id),
      c.env.DB.prepare(
        'INSERT INTO point_history (student_id, delta, reason, category, created_at) VALUES (?,?,?,?,?)'
      ).bind(stu.id, delta, reason, 'soez', getKSTTimestamp()),
    ]
    if (eventId) {
      stmts.push(c.env.DB.prepare('INSERT OR IGNORE INTO point_sync_seen (event_id) VALUES (?)').bind(eventId))
    }
    await c.env.DB.batch(stmts)

    return c.json({ success: true, matched: true })

  } catch (e: any) {

    return c.json({ success: false, error: e.message }, 500)

  }

})


// ══════════════════════════════════════════════════════════════════════════════
//  수학 전광판 (수학야구) — 쏘이지(soez) → 띵똥 키오스크 표시 전용
//  · 점수 계산·저장은 쏘이지가 함. 키오스크는 읽어서 보여주기만 함(단방향).
//  · 쓰기: POST /api/math-board/external  (X-Service-Key == EXTERNAL_POINTS_KEY)
//  · 읽기: GET  /api/math-board?name=학생이름  (키오스크 학생 화면)
// ══════════════════════════════════════════════════════════════════════════════

let mathBoardReady = false
async function ensureMathBoardTable(db: D1Database) {
  if (mathBoardReady) return
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS math_board (
       student_name   TEXT PRIMARY KEY,
       strike         INTEGER NOT NULL DEFAULT 0,
       ball           INTEGER NOT NULL DEFAULT 0,
       out_count      INTEGER NOT NULL DEFAULT 0,
       goal           TEXT    NOT NULL DEFAULT '',
       supplement     INTEGER NOT NULL DEFAULT 0,
       class_label    TEXT    NOT NULL DEFAULT '',
       records_json   TEXT    NOT NULL DEFAULT '[]',
       active         INTEGER NOT NULL DEFAULT 1,
       updated_at     TEXT    DEFAULT CURRENT_TIMESTAMP,
       student_id     TEXT    NOT NULL DEFAULT '',
       penalty_rounds INTEGER NOT NULL DEFAULT 0,
       pending_makeup INTEGER NOT NULL DEFAULT 0,
       honey          INTEGER NOT NULL DEFAULT 0,
       status         TEXT    NOT NULL DEFAULT '',
       month_label    TEXT    NOT NULL DEFAULT '',
       history_json   TEXT    NOT NULL DEFAULT '[]',
       photo          TEXT    NOT NULL DEFAULT ''
     )`
  ).run()
  // 기존 설치본에 새 컬럼 추가 (이미 있으면 에러 무시)
  const adds = [
    "ALTER TABLE math_board ADD COLUMN student_id TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE math_board ADD COLUMN penalty_rounds INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE math_board ADD COLUMN pending_makeup INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE math_board ADD COLUMN honey INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE math_board ADD COLUMN status TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE math_board ADD COLUMN month_label TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE math_board ADD COLUMN history_json TEXT NOT NULL DEFAULT '[]'",
    "ALTER TABLE math_board ADD COLUMN photo TEXT NOT NULL DEFAULT ''",
  ]
  for (const sql of adds) { try { await db.prepare(sql).run() } catch (_) {} }
  mathBoardReady = true
}

// math_board 한 줄 → 연동요청서의 board 응답 형태로 변환
function rowToBoard(row: any) {
  let recent: any[] = [], history: any[] = []
  try { recent = JSON.parse(row.records_json || '[]') } catch (_) {}
  try { history = JSON.parse(row.history_json || '[]') } catch (_) {}
  const S = Number(row.strike) || 0, B = Number(row.ball) || 0, O = Number(row.out_count) || 0
  const penaltyRounds = Number(row.penalty_rounds) || 0
  const pendingMakeup = !!row.pending_makeup || !!row.supplement
  let status = (row.status || '').toString()
  if (!status) status = pendingMakeup ? 'makeup' : (O >= 1 || S >= 2) ? 'warn' : (B > 0) ? 'good' : 'clean'
  return {
    studentId: (row.student_id || '').toString(),
    name: row.student_name,
    S, B, O,
    penaltyRounds,
    round: penaltyRounds + 1,           // 현재 회차 = penaltyRounds + 1
    pendingMakeup,
    honey: Number(row.honey) || 0,
    status,
    monthLabel: (row.month_label || '').toString(),
    classLabel: (row.class_label || '').toString(),
    goal: (row.goal || '').toString(),
    recent, history,
  }
}

// 로컬 저장본에서 학생 이름으로 board 가져오기 (없으면 null)
async function localBoardByName(db: D1Database, name: string) {
  await ensureMathBoardTable(db)
  const row = await db.prepare('SELECT * FROM math_board WHERE student_name=?').bind(name).first() as any
  if (!row || row.active === 0) return null
  return { board: rowToBoard(row), photo: (row.photo || '').toString(), updatedAt: row.updated_at }
}

// student_id(=띵똥 students.id, 쏘이지 로스터ID와 공유) → 학생 이름
async function nameForStudentId(db: D1Database, studentId: string) {
  try {
    const r = await db.prepare('SELECT name FROM students WHERE id=?').bind(studentId).first() as any
    return r?.name || ''
  } catch (_) { return '' }
}

// (선택) 쏘이지 PULL 프록시 — env 설정 시 쏘이지 API를 서버에서 대신 호출
async function fetchSoezBoard(env: Bindings, studentId: string) {
  if (!env.SOEZ_BASE_URL || !env.SOEZ_READ_TOKEN) return null
  try {
    const base = env.SOEZ_BASE_URL.replace(/\/+$/, '')
    const url = base + '/api/baseball/board?student_id=' + encodeURIComponent(studentId)
    const r = await fetch(url, { headers: { 'X-Read-Token': env.SOEZ_READ_TOKEN, 'Accept': 'application/json' } })
    if (!r.ok) return { error: 'soez ' + r.status }
    return await r.json()   // 기대 형태: { board, photo }
  } catch (e: any) {
    return { error: String(e?.message || e) }
  }
}

// 들어오는 쏘이지 요청을 기록하는 진단 로그 (최근 50건만 보관)
async function ensureMathBoardLog(db: D1Database) {
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS math_board_log (
       id     INTEGER PRIMARY KEY AUTOINCREMENT,
       at     TEXT DEFAULT CURRENT_TIMESTAMP,
       status INTEGER,        -- 200 / 401 / 400 / 500
       auth   INTEGER,        -- 1=키 정상, 0=키 틀림/없음
       name   TEXT,
       note   TEXT,           -- 결과/오류 메모
       body   TEXT            -- 받은 본문(최대 600자)
     )`
  ).run()
}
async function logMB(db: D1Database, e: { status: number, auth: number, name: string, note: string, body: string }) {
  try {
    await ensureMathBoardLog(db)
    await db.prepare(
      'INSERT INTO math_board_log (status, auth, name, note, body) VALUES (?,?,?,?,?)'
    ).bind(e.status, e.auth, (e.name || '').slice(0, 60), (e.note || '').slice(0, 200), (e.body || '').slice(0, 600)).run()
    // 오래된 것 정리 (최근 50건만)
    await db.prepare(
      'DELETE FROM math_board_log WHERE id NOT IN (SELECT id FROM math_board_log ORDER BY id DESC LIMIT 50)'
    ).run()
  } catch (_) {}
}

// 쏘이지 → 전광판 점수 입력/갱신 (한 학생의 현재 스트라이크·볼·아웃을 통째로 덮어씀)
app.post('/api/math-board/external', async (c) => {
  // 본문은 먼저 raw 로 읽어둔다 (인증 실패·파싱 실패도 진단 로그에 남기기 위해)
  let raw = ''
  try { raw = await c.req.text() } catch (_) {}

  try {
    const key = c.req.header('X-Service-Key') || ''
    const authOk = !!c.env.EXTERNAL_POINTS_KEY && key === c.env.EXTERNAL_POINTS_KEY
    if (!authOk) {
      const note = !c.env.EXTERNAL_POINTS_KEY ? '서버에 EXTERNAL_POINTS_KEY 미설정' : (key ? '키 불일치' : 'X-Service-Key 헤더 없음')
      await logMB(c.env.DB, { status: 401, auth: 0, name: '', note, body: raw })
      return c.json({ success: false, error: 'unauthorized', hint: note }, 401)
    }

    let body: any
    try { body = JSON.parse(raw || '{}') } catch (_) {
      await logMB(c.env.DB, { status: 400, auth: 1, name: '', note: 'JSON 파싱 실패', body: raw })
      return c.json({ success: false, error: 'invalid JSON' }, 400)
    }
    const name = (body.name || '').toString().trim()
    if (!name) {
      await logMB(c.env.DB, { status: 400, auth: 1, name: '', note: 'name 필드 없음', body: raw })
      return c.json({ success: false, error: 'name 필요' }, 400)
    }

    const clamp = (v: any, max: number) => Math.max(0, Math.min(max, Math.floor(Number(v) || 0)))
    const pick = (...vs: any[]) => vs.find(v => v !== undefined && v !== null)
    // 연동요청서 응답키(S/B/O)와 기존 키(strike/ball/out) 둘 다 허용
    const strike = clamp(pick(body.strike, body.S), 3)                          // 스트라이크 3 → 아웃
    const ball   = clamp(pick(body.ball, body.B), 4)                            // 볼 4 → 아웃 1 삭제
    const out    = clamp(pick(body.out, body.O, body.out_count), 3)             // 아웃 3 → 보충
    const goal   = (pick(body.goal, '') || '').toString().slice(0, 160)
    const truthy = (v: any) => v === true || v === 1 || v === '1' || v === 'true'
    const pendingMakeup = truthy(pick(body.pendingMakeup, body.supplement)) ? 1 : 0
    const penaltyRounds = clamp(pick(body.penaltyRounds, body.penalty_rounds, 0), 999)
    const honey = clamp(pick(body.honey, 0), 999)
    const status = (pick(body.status, '') || '').toString().slice(0, 16)
    const monthLabel = (pick(body.monthLabel, body.month_label, '') || '').toString().slice(0, 16)
    const classLabel = (pick(body.classLabel, body.class_label, '') || '').toString().slice(0, 60)
    const studentId = (pick(body.studentId, body.student_id, '') || '').toString().slice(0, 40)
    const photo = (pick(body.photo, '') || '').toString().slice(0, 500)
    const active = (body.active === false || body.active === 0 || body.active === '0') ? 0 : 1

    // 기록 정규화: 연동요청서 형태 {date,tone,label,delta,round} 우선, 기존 {type,label,date}도 허용
    const normRec = (arr: any[], cap: number) => (Array.isArray(arr) ? arr : []).slice(0, cap).map((r: any) => ({
      date:  (pick(r.date, '') || '').toString().slice(0, 20),
      tone:  (pick(r.tone, r.type, '') || '').toString().slice(0, 10),  // strike|ball|minus|makeup|honey
      label: (pick(r.label, '') || '').toString().slice(0, 60),
      delta: (pick(r.delta, '') || '').toString().slice(0, 40),
      round: Number(pick(r.round, 0)) || 0,
    }))
    const recent  = normRec(pick(body.recent, body.records), 12)
    const history = normRec(pick(body.history, body.recent, body.records), 120)

    await ensureMathBoardTable(c.env.DB)
    await c.env.DB.prepare(
      `INSERT INTO math_board (student_name, strike, ball, out_count, goal, supplement, class_label, records_json, active, updated_at,
                               student_id, penalty_rounds, pending_makeup, honey, status, month_label, history_json, photo)
       VALUES (?,?,?,?,?,?,?,?,?, CURRENT_TIMESTAMP, ?,?,?,?,?,?,?,?)
       ON CONFLICT(student_name) DO UPDATE SET
         strike=excluded.strike, ball=excluded.ball, out_count=excluded.out_count,
         goal=excluded.goal, supplement=excluded.supplement, class_label=excluded.class_label,
         records_json=excluded.records_json, active=excluded.active, updated_at=CURRENT_TIMESTAMP,
         student_id=excluded.student_id, penalty_rounds=excluded.penalty_rounds, pending_makeup=excluded.pending_makeup,
         honey=excluded.honey, status=excluded.status, month_label=excluded.month_label,
         history_json=excluded.history_json, photo=excluded.photo`
    ).bind(name, strike, ball, out, goal, pendingMakeup, classLabel, JSON.stringify(recent), active,
           studentId, penaltyRounds, pendingMakeup, honey, status, monthLabel, JSON.stringify(history), photo).run()

    await logMB(c.env.DB, { status: 200, auth: 1, name, note: `저장됨 S${strike} B${ball} O${out} ${penaltyRounds + 1}회${pendingMakeup ? ' 보충대상' : ''}${active ? '' : ' (active=false→칩숨김)'}`, body: raw })
    return c.json({ success: true })

  } catch (e: any) {
    await logMB(c.env.DB, { status: 500, auth: 1, name: '', note: 'DB 오류: ' + e.message, body: raw })
    return c.json({ success: false, error: e.message }, 500)
  }
})

// 진단: 쏘이지가 보낸 최근 요청 보기 (브라우저로 열기)
//   GET /api/math-board/debug?key=<EXTERNAL_POINTS_KEY>
app.get('/api/math-board/debug', async (c) => {
  const key = c.req.query('key') || c.req.header('X-Service-Key') || ''
  if (!c.env.EXTERNAL_POINTS_KEY || key !== c.env.EXTERNAL_POINTS_KEY) {
    return c.json({ success: false, error: 'unauthorized', hint: 'URL 뒤에 ?key=서비스키 를 붙여주세요' }, 401)
  }
  try {
    await ensureMathBoardLog(c.env.DB)
    const logs = await c.env.DB.prepare(
      'SELECT at, status, auth, name, note, body FROM math_board_log ORDER BY id DESC LIMIT 50'
    ).all()
    const boards = await c.env.DB.prepare(
      'SELECT student_name, strike, ball, out_count, active, updated_at FROM math_board ORDER BY updated_at DESC LIMIT 50'
    ).all().catch(() => ({ results: [] }))
    return c.json({
      success: true,
      now: getKSTTimestamp() + ' (KST)',
      받은요청_최근: logs.results,
      현재저장된전광판: (boards as any).results,
      안내: '받은요청이 비어있으면 쏘이지가 전송 자체를 안 한 것. status 401이면 키, 400이면 본문/이름 문제.',
    })
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500)
  }
})

// 키오스크 → 전광판 읽기 (연동요청서 계약: GET /api/baseball/board?student_id=)
//  · SOEZ_BASE_URL/SOEZ_READ_TOKEN 설정 시 → 쏘이지에서 PULL (프록시)
//  · 미설정 시 → 로컬 저장본(쏘이지가 push 해둔 값)으로 같은 형태 응답
//  · student_id(=띵똥 students.id) 또는 name 으로 조회
app.get('/api/baseball/board', async (c) => {
  try {
    const studentId = (c.req.query('student_id') || '').trim()
    let name = (c.req.query('name') || '').trim()

    // 1) 쏘이지 PULL 우선 (설정돼 있을 때만)
    if (studentId && c.env.SOEZ_BASE_URL && c.env.SOEZ_READ_TOKEN) {
      const pulled: any = await fetchSoezBoard(c.env, studentId)
      if (pulled && !pulled.error) {
        const board = pulled.board || null
        // 상벌점 항목 안내: rules/cfg 가 top-level 또는 board 안에 올 수 있어 둘 다 챙겨서 board 에 붙임
        const rules = pulled.rules || (board && board.rules) || []
        const cfg = pulled.cfg || (board && board.cfg) || null
        if (board) { board.rules = rules; board.cfg = cfg }
        return c.json({ success: true, exists: !!board, source: 'soez', board, photo: pulled.photo || '', rules, cfg })
      }
      // 쏘이지 호출 실패 시 로컬로 폴백
    }

    // 2) 로컬 저장본
    if (!name && studentId) name = await nameForStudentId(c.env.DB, studentId)
    if (!name) return c.json({ success: true, exists: false, source: 'local' })

    const local = await localBoardByName(c.env.DB, name)
    if (!local) return c.json({ success: true, exists: false, source: 'local' })
    return c.json({ success: true, exists: true, source: 'local', board: local.board, photo: local.photo, updatedAt: local.updatedAt })

  } catch (e: any) {
    // 표시 전용이므로 실패해도 200 + exists:false (학생 화면이 깨지지 않게)
    return c.json({ success: true, exists: false, error: e.message })
  }
})

// 하위호환 별칭 (기존 ?name= 호출도 같은 형태로 응답)
app.get('/api/math-board', async (c) => {
  try {
    const name = (c.req.query('name') || '').trim()
    if (!name) return c.json({ success: true, exists: false })
    const local = await localBoardByName(c.env.DB, name)
    if (!local) return c.json({ success: true, exists: false })
    return c.json({ success: true, exists: true, board: local.board, photo: local.photo, updatedAt: local.updatedAt })
  } catch (e: any) {
    return c.json({ success: true, exists: false, error: e.message })
  }
})


app.post('/api/submit', async (c) => {

  try {

    const body = await c.req.json()

    const { name, items, totalCost, currency, category, timestamp, photoBase64, comment } = body

    if (!name || !items) return c.json({ success: false, error: '필수 값 누락' }, 400)



    // D1: 학생 찾기

    // 상점 구매 시 한도/재고 체크
    if (category === 'shop') {
      const today = getKSTDate()
      const monthKey = today.slice(0, 7)
      try {
        const configRow = await c.env.DB.prepare(
          "SELECT value FROM app_config WHERE key='kiosk_config'"
        ).first() as any
        if (configRow?.value) {
          const config = JSON.parse(configRow.value)
          const maxPerOrder = Number(config.shopMaxPerOrder || 0)
          if (maxPerOrder > 0) {
            const totalQty = items.reduce((a: number, x: any) => a + Number(x.qty || 0), 0)
            if (totalQty > maxPerOrder) {
              return c.json({ success: false, error: `한 번에 ${maxPerOrder}개까지 담을 수 있어요` }, 400)
            }
          }
          const shopItems: any[] = config.menu?.shop || []
          for (const item of items) {
            const menuItem = shopItems.find((s: any) => s.id === item.id)
            if (!menuItem) continue
            if ((menuItem.dailyLimit || 0) > 0) {
              const logRow = await c.env.DB.prepare(
                "SELECT COALESCE(SUM(qty),0) as total FROM shop_purchase_log WHERE item_id=? AND purchase_date=? AND student_name=?"
              ).bind(item.id, today, name).first() as any
              const used = Number(logRow?.total || 0)
              if (used + item.qty > menuItem.dailyLimit) {
                return c.json({ success: false, error: `${item.label}: 오늘 구매 한도(하루 ${menuItem.dailyLimit}개)를 초과했어요` }, 400)
              }
            }
            if ((menuItem.monthlyStock || 0) > 0) {
              const stockRow = await c.env.DB.prepare(
                "SELECT remaining_stock FROM shop_stock WHERE item_id=? AND month_key=?"
              ).bind(item.id, monthKey).first() as any
              if (stockRow !== null && stockRow !== undefined) {
                if (Number(stockRow.remaining_stock) < item.qty) {
                  return c.json({ success: false, error: `${item.label}: 이번 달 재고가 부족해요 (남은 수량: ${stockRow.remaining_stock}개)` }, 400)
                }
              }
            }
          }
        }
      } catch (_) {}
    }
    const stu = await c.env.DB.prepare('SELECT * FROM students WHERE name=?').bind(name).first() as any

    // 상점 구매: 포인트 잔액 부족이면 차단 (벌점/학습은 음수 허용이라 제외)
    if (category === 'shop' && stu && totalCost > 0 && Number(stu.points) < totalCost) {
      return c.json({ success: false, error: '포인트가 부족해요', code: 'insufficient_points', shortfall: totalCost - Number(stu.points), balance: Number(stu.points) }, 400)
    }

    if (stu) {

      const delta = -(totalCost) // totalCost가 음수면 획득, 양수면 차감

      await c.env.DB.prepare('UPDATE students SET points = points + ? WHERE id=?').bind(delta, stu.id).run()

      const reason = items.map((x) => `${x.icon}${x.label}×${x.qty}`).join(', ')

      await c.env.DB.prepare(

        'INSERT INTO point_history (student_id, delta, reason, category, created_at) VALUES (?,?,?,?,?)'

      ).bind(stu.id, delta, reason, category, getKSTTimestamp()).run()

      if (category === 'fine') {

        for (const item of items) {

          // item.fineType: 'point'|'time'|'sheet' (항목별 화폐 유형)
          const fineType = item.fineType || 'point'
          const unitLabel = item.unit || currency

          await c.env.DB.prepare(

            'INSERT INTO fines (student_id, label, amount, unit, fine_type) VALUES (?,?,?,?,?)'

          ).bind(stu.id, `${item.icon} ${item.label}`, item.qty, unitLabel, fineType).run()

        }

      }

    }
 // 상점 구매 로그 기록 (한도 체크 & 재고 차감)
      if (category === 'shop') {
        const today = getKSTDate()
        const monthKey = today.slice(0, 7)
        for (const item of items) {
          try {
            await c.env.DB.prepare(
              "INSERT INTO shop_purchase_log (item_id, student_id, student_name, qty, purchase_date) VALUES (?,?,?,?,?)"
            ).bind(item.id || item.label, stu.id, name, item.qty, today).run()
            await c.env.DB.prepare(
              "UPDATE shop_stock SET remaining_stock = MAX(0, remaining_stock - ?), updated_at = CURRENT_TIMESTAMP WHERE item_id=? AND month_key=?"
            ).bind(item.qty, item.id || item.label, monthKey).run()
          } catch (_) {}
        }
      }


    const [slackR, notionR] = await Promise.allSettled([

      sendSlack(c.env, { name, items, totalCost, currency, category, timestamp, photoBase64, comment }),

      saveNotion(c.env, { name, items, totalCost, currency, category, timestamp, photoBase64, comment }),

    ])

    const slackOk = slackR.status === 'fulfilled' && slackR.value

    const notionOk = notionR.status === 'fulfilled' && notionR.value



    // orders 테이블 저장

    try {

      await c.env.DB.prepare(

        'INSERT INTO orders (student_name,items_json,total_cost,currency,category,comment,has_photo,slack_ok,notion_ok) VALUES (?,?,?,?,?,?,?,?,?)'

      ).bind(name, JSON.stringify(items), totalCost, currency, category, comment||null, photoBase64?1:0, slackOk?1:0, notionOk?1:0).run()

    } catch(_) {}



    return c.json({ success: true, slack: slackOk, notion: notionOk })

  } catch (err: any) {

    return c.json({ success: false, error: err.message }, 500)

  }

})



// ── 포인트 교환 대출 (상점 포인트 부족 시) ─────────────────────────────────────
// 부족분만큼 포인트를 빌려주고, 10포인트=1분(올림)으로 당일 추가 보충수업 의무를 만든다.
// 미상환(repaid_at NULL) 대출이 3건이면 거부. 상환 처리는 키오스크 관리자에서 수동.
async function ensurePointLoans(db: D1Database) {
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS point_loans (
       id           INTEGER PRIMARY KEY AUTOINCREMENT,
       student_id   INTEGER,
       student_name TEXT NOT NULL,
       points       INTEGER NOT NULL,
       minutes      INTEGER NOT NULL,
       created_at   TEXT DEFAULT CURRENT_TIMESTAMP,
       repaid_at    TEXT
     )`
  ).run()
}

// 쏘이지 '수학 보충수업(class_supplement)'에 대출을 기록 (best-effort, 공유 서비스키).
async function pushSoezSupplement(env: Bindings, d: { name: string, points: number, minutes: number, eventId: string }) {
  if (!env.SOEZ_BASE_URL || !env.EXTERNAL_POINTS_KEY) return { ok: false, reason: 'not_configured' }
  try {
    const base = env.SOEZ_BASE_URL.replace(/\/+$/, '')
    const r = await fetch(base + '/api/kiosk/supplement', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Service-Key': env.EXTERNAL_POINTS_KEY },
      body: JSON.stringify({ name: d.name, points: d.points, minutes: d.minutes, reason: '포인트 교환', eventId: d.eventId }),
    })
    const j: any = await r.json().catch(() => ({}))
    return { ok: r.ok && j.ok !== false, status: r.status, body: j }
  } catch (e: any) { return { ok: false, reason: String(e?.message || e) } }
}

app.post('/api/loan', async (c) => {
  try {
    const { name, need } = await c.req.json()
    if (!name) return c.json({ success: false, error: '이름 필요' }, 400)
    const stu = await c.env.DB.prepare('SELECT * FROM students WHERE name=?').bind(name).first() as any
    if (!stu) return c.json({ success: false, error: '학생을 찾을 수 없어요' }, 404)

    await ensurePointLoans(c.env.DB)
    const openRow = await c.env.DB.prepare(
      'SELECT COUNT(*) as cnt FROM point_loans WHERE student_id=? AND repaid_at IS NULL'
    ).bind(stu.id).first() as any
    if (Number(openRow?.cnt || 0) >= 3) {
      return c.json({ success: false, code: 'loan_limit', error: '미상환 대출이 3건이라 더 빌릴 수 없어요. 보충수업을 먼저 끝내주세요.' }, 400)
    }

    const points = Number(stu.points) || 0
    const shortfall = Math.max(0, Math.ceil(Number(need) || 0) - points)
    if (shortfall <= 0) return c.json({ success: true, credited: 0, balance: points }) // 이미 충분

    const minutes = Math.ceil(shortfall / 10)
    // 1) 포인트 크레딧 (부족분)
    await c.env.DB.prepare('UPDATE students SET points = points + ? WHERE id=?').bind(shortfall, stu.id).run()
    await c.env.DB.prepare(
      'INSERT INTO point_history (student_id, delta, reason, category, created_at) VALUES (?,?,?,?,?)'
    ).bind(stu.id, shortfall, `포인트 교환 대출(${minutes}분 당일보충)`, 'loan', getKSTTimestamp()).run()
    // 2) 대출 기록 (미상환)
    const ins = await c.env.DB.prepare(
      'INSERT INTO point_loans (student_id, student_name, points, minutes) VALUES (?,?,?,?)'
    ).bind(stu.id, name, shortfall, minutes).run()
    const loanId = (ins as any).meta?.last_row_id
    // 3) 쏘이지 수학 보충수업에 기록 (사유: 포인트 교환)
    const soez = await pushSoezSupplement(c.env, { name, points: shortfall, minutes, eventId: 'loan_' + loanId })
    // 4) 수학 카카오워크 알림
    const ts = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })
    await sendKW(kwMath(c.env), `[포인트 교환 대출] ${name}\n${shortfall}P 대출 → 오늘 ${minutes}분 추가 보충수업\n사유: 포인트 교환 · ${ts}`)

    return c.json({ success: true, credited: shortfall, minutes, balance: points + shortfall, soez: soez.ok === true })
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500)
  }
})

// 관리자: 대출 현황 조회 (미상환 먼저)
app.get('/api/admin/loans', async (c) => {
  await ensurePointLoans(c.env.DB)
  const rows = await c.env.DB.prepare(
    'SELECT * FROM point_loans ORDER BY (repaid_at IS NOT NULL), created_at DESC LIMIT 100'
  ).all()
  return c.json({ success: true, loans: rows.results })
})

// 관리자: 대출 상환 처리 (보충수업 완료 후)
app.post('/api/admin/loans/:id/repay', async (c) => {
  const id = c.req.param('id')
  await ensurePointLoans(c.env.DB)
  await c.env.DB.prepare(
    'UPDATE point_loans SET repaid_at=? WHERE id=? AND repaid_at IS NULL'
  ).bind(getKSTTimestamp(), id).run()
  return c.json({ success: true })
})



// KST(한국시간) 날짜/타임스탬프 헬퍼
function getKSTDate() {
  const n = new Date(Date.now() + 9 * 3600 * 1000)
  return n.toISOString().slice(0, 10)
}
function getKSTTimestamp() {
  const n = new Date(Date.now() + 9 * 3600 * 1000)
  return n.toISOString().slice(0, 19).replace('T', ' ')
}

app.post('/api/queue/draw', async (c) => {

  try {

    const { studentName } = await c.req.json()

    if (!studentName) return c.json({ success: false, error: '이름 필요' }, 400)

    const today = getKSTDate()



    // 오늘 이미 번호표 뽑았는지 (완료 상태면 재발급 허용)

    const existing = await c.env.DB.prepare(

      "SELECT * FROM queue WHERE student_name=? AND date=? ORDER BY created_at DESC LIMIT 1"

    ).bind(studentName, today).first() as any



    if (existing && existing.status !== 'done') {

      return c.json({ success: false, error: 'already_drawn', message: '오늘 이미 번호표를 뽑았어요 선생님이 완료 처리 후 재발급 가능해요.' })

    }



    // 직전 번호표 발급자 체크 (연속 발급 방지, 완료된 경우 제외)

    const lastTicket = await c.env.DB.prepare(

      "SELECT * FROM queue WHERE date=? AND status != 'done' ORDER BY created_at DESC LIMIT 1"

    ).bind(today).first() as any



    if (lastTicket && lastTicket.student_name === studentName) {

      return c.json({ success: false, error: 'consecutive', message: '방금 전에도 내가 뽑았어요 친구에게 양보해요' })

    }



    // 오늘 마지막 번호 조회

    const maxRow = await c.env.DB.prepare(

      'SELECT MAX(number) as maxNum FROM queue WHERE date=?'

    ).bind(today).first() as any

    const nextNum = (maxRow?.maxNum || 0) + 1



    // 번호표 발급

    await c.env.DB.prepare(

      "INSERT INTO queue (number, student_name, date, status) VALUES (?,?,?,'waiting')"

    ).bind(nextNum, studentName, today).run()



    // 대기 인원 (내 앞, waiting/answering 상태만)

    const waitingRow = await c.env.DB.prepare(

      "SELECT COUNT(*) as cnt FROM queue WHERE date=? AND number < ? AND status IN ('waiting','answering')"

    ).bind(today, nextNum).first() as any

    const waiting = waitingRow?.cnt || 0



    // 슬랙 알림

    const ts = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })

    await sendSlackQueue(c.env, { studentName, number: nextNum, waiting, date: today, ts })



    return c.json({ success: true, number: nextNum, waiting, date: today })

  } catch (e: any) {

    return c.json({ success: false, error: e.message }, 500)

  }

})



// 번호표 현황 조회

app.get('/api/queue/status', async (c) => {

  try {

    const today = getKSTDate()

    const rows = await c.env.DB.prepare(

      'SELECT * FROM queue WHERE date=? ORDER BY number ASC'

    ).bind(today).all()

    const tickets = rows.results as any[]

    const waiting = tickets.filter((r) => r.status === 'waiting').length

    const answering = tickets.filter((r) => r.status === 'answering').length

    const done = tickets.filter((r) => r.status === 'done').length

    return c.json({ success: true, total: tickets.length, waiting, answering, done, tickets })

  } catch (e: any) {

    return c.json({ success: false, error: e.message }, 500)

  }

})



// 번호표 상태 변경 (관리자) - waiting→answering→done

app.post('/api/admin/queue/:id/status', async (c) => {

  try {

    const id = c.req.param('id')

    const { status } = await c.req.json()

    if (!['waiting','answering','done'].includes(status))

      return c.json({ success: false, error: '잘못된 상태값' }, 400)

    await c.env.DB.prepare('UPDATE queue SET status=?, called=? WHERE id=?')

      .bind(status, status === 'done' ? 2 : status === 'answering' ? 1 : 0, id).run()

    // 호출(answering)로 바뀌면 키오스크 음성 방송 큐에 "(이름) 차례입니다" 추가
    if (status === 'answering') {
      try {
        const row = await c.env.DB.prepare('SELECT student_name FROM queue WHERE id=?').bind(id).first() as any
        if (row?.student_name) await pushAnnounce(c.env.DB, row.student_name + ' 학생 차례입니다.')
      } catch (_) {}
    }

    return c.json({ success: true })

  } catch (e: any) {

    return c.json({ success: false, error: e.message }, 500)

  }

})


// ══════════════════════════════════════════════════════════════════════════════
//  키오스크 음성 방송 (관리자 호출 → 키오스크에서 음성 출력)
//  · 관리자가 호출/방송하면 announcements 에 문구 적재
//  · 키오스크가 짧은 주기로 폴링해서 새 문구를 브라우저 음성합성으로 읽음
// ══════════════════════════════════════════════════════════════════════════════
let announceReady = false
async function ensureAnnounceTable(db: D1Database) {
  if (announceReady) return
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS announcements (
       id         INTEGER PRIMARY KEY AUTOINCREMENT,
       text       TEXT NOT NULL,
       kind       TEXT NOT NULL DEFAULT 'call',
       created_at TEXT DEFAULT CURRENT_TIMESTAMP
     )`
  ).run()
  try { await db.prepare("ALTER TABLE announcements ADD COLUMN kind TEXT NOT NULL DEFAULT 'call'").run() } catch (_) {}
  announceReady = true
}
// kind: 'call'(번호표 호출-잠깐), 'board'(칠판-유지), 'clear'(칠판 지우기)
async function pushAnnounce(db: D1Database, text: string, kind: string = 'call') {
  const t = (text || '').toString().trim().slice(0, 300)
  if (!t && kind !== 'clear') return 0
  await ensureAnnounceTable(db)
  const r = await db.prepare('INSERT INTO announcements (text, kind) VALUES (?,?)').bind(t, kind).run() as any
  // 최근 100건만 보관
  try {
    await db.prepare('DELETE FROM announcements WHERE id NOT IN (SELECT id FROM announcements ORDER BY id DESC LIMIT 100)').run()
  } catch (_) {}
  // 칠판 상태 저장(유지/지우기) — 키오스크 재접속 시 복원용
  if (kind === 'board' || kind === 'clear') {
    try {
      await db.prepare(
        "INSERT INTO app_config (key, value, updated_at) VALUES ('current_board', ?, CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP"
      ).bind(kind === 'clear' ? '' : t).run()
    } catch (_) {}
  }
  return r.meta?.last_row_id || 0
}

// 관리자: 칠판에 쓰기(board) / 임의 방송 / 지우기(clear)
app.post('/api/admin/announce', async (c) => {
  try {
    const body = await c.req.json()
    const kind = (body.kind || 'board').toString()   // 관리자 패널 기본은 칠판(board)
    const t = (body.text || '').toString().trim()
    if (kind !== 'clear' && !t) return c.json({ success: false, error: '문구를 입력하세요' }, 400)
    const id = await pushAnnounce(c.env.DB, t, kind)
    return c.json({ success: true, id })
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500)
  }
})

// 키오스크: 새 방송 폴링. since 미지정/'init' 이면 백로그 재생 없이 현재 maxId만 반환.
// 2분 지난 문구는 보내지 않음(재접속/새로고침 시 오래된 호출 재생 방지).
app.get('/api/announce/poll', async (c) => {
  try {
    await ensureAnnounceTable(c.env.DB)
    const maxRow = await c.env.DB.prepare('SELECT COALESCE(MAX(id),0) AS m FROM announcements').first() as any
    const maxId = Number(maxRow?.m || 0)
    const sinceRaw = c.req.query('since')
    if (sinceRaw === undefined || sinceRaw === '' || sinceRaw === 'init') {
      // 첫 폴: 현재 칠판 내용도 함께 반환(재접속 복원, 무음)
      let board = ''
      try {
        const b = await c.env.DB.prepare("SELECT value FROM app_config WHERE key='current_board'").first() as any
        board = b?.value || ''
      } catch (_) {}
      return c.json({ success: true, items: [], maxId, board })
    }
    const since = Math.max(0, parseInt(sinceRaw) || 0)
    const rows = await c.env.DB.prepare(
      "SELECT id, text, kind FROM announcements WHERE id > ? AND created_at > datetime('now','-2 minutes') ORDER BY id ASC LIMIT 20"
    ).bind(since).all()
    return c.json({ success: true, items: rows.results, maxId })
  } catch (e: any) {
    return c.json({ success: true, items: [], maxId: 0, error: e.message })
  }
})

// TTS 프록시: 한국어 텍스트 → MP3 (브라우저 speechSynthesis 멈춤 버그 회피용, 실제 음성 파일)
app.get('/api/tts', async (c) => {
  const text = (c.req.query('text') || '').toString().slice(0, 200)
  if (!text) return c.text('no text', 400)
  const url = 'https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=ko&q=' + encodeURIComponent(text)
  try {
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
        'Referer': 'https://translate.google.com/',
        'Accept': 'audio/mpeg,*/*',
      },
    })
    if (!r.ok) return c.text('tts upstream ' + r.status, 502)
    return new Response(r.body, {
      headers: {
        'Content-Type': 'audio/mpeg',
        'Cache-Control': 'public, max-age=86400',
        'Access-Control-Allow-Origin': '*',
      },
    })
  } catch (e: any) {
    return c.text('tts error', 502)
  }
})



// 번호표 전체 목록 (관리자, 날짜 파라미터 가능)

app.get('/api/admin/queue', async (c) => {

  try {

    const date = c.req.query('date') || getKSTDate()

    const rows = await c.env.DB.prepare(

      'SELECT * FROM queue WHERE date=? ORDER BY number ASC'

    ).bind(date).all()

    return c.json({ success: true, tickets: rows.results, date })

  } catch (e: any) {

    return c.json({ success: false, error: e.message }, 500)

  }

})



// ── 요청사항 관리자 API ─────────────────────────────────────────────────────



// 요청사항 목록 (관리자)

app.get('/api/admin/orders', async (c) => {

  try {

    const student = c.req.query('student') || ''

    const category = c.req.query('category') || ''

    let sql = 'SELECT * FROM orders'

    const params: any[] = []

    const wheres: string[] = []

    if (student) { wheres.push('student_name LIKE ?'); params.push('%'+student+'%') }

    if (category) { wheres.push('category=?'); params.push(category) }

    if (wheres.length) sql += ' WHERE ' + wheres.join(' AND ')

    sql += ' ORDER BY created_at DESC LIMIT 200'

    const stmt = c.env.DB.prepare(sql)

    const rows = params.length ? await stmt.bind(...params).all() : await stmt.all()

    return c.json({ success: true, orders: rows.results })

  } catch (e: any) {

    return c.json({ success: false, error: e.message }, 500)

  }

})

// 상점 주문 부분 환불: body.refunds=[{idx, qty}] (idx=items_json 위치). 환불 수량은 items[i].refunded에 누적
app.post('/api/admin/orders/:id/refund', async (c) => {
  const id = c.req.param('id')
  const { refunds } = await c.req.json().catch(() => ({})) as any
  const order = await c.env.DB.prepare('SELECT * FROM orders WHERE id=?').bind(id).first() as any
  if (!order) return c.json({ success: false, error: '주문을 찾을 수 없어요' }, 404)
  if (order.category !== 'shop') return c.json({ success: false, error: '상점 주문만 환불할 수 있어요' }, 400)
  const items: any[] = JSON.parse(order.items_json || '[]')
  const picked: { item: any, qty: number }[] = []
  for (const r of Array.isArray(refunds) ? refunds : []) {
    const item = items[Number(r.idx)]
    const qty = Math.floor(Number(r.qty))
    if (!item || !(qty > 0)) continue
    if (qty > Number(item.qty) - Number(item.refunded || 0)) return c.json({ success: false, error: `${item.label}: 환불 가능한 수량을 넘었어요` }, 400)
    item.refunded = Number(item.refunded || 0) + qty
    picked.push({ item, qty })
  }
  if (!picked.length) return c.json({ success: false, error: '환불할 항목을 골라 주세요' }, 400)
  const amount = picked.reduce((a, p) => a + Number(p.item.cost || 0) * p.qty, 0)

  // 같은 주문을 두 번 환불하지 않도록 items_json이 그대로일 때만 갱신
  const upd = await c.env.DB.prepare('UPDATE orders SET items_json=? WHERE id=? AND items_json=?')
    .bind(JSON.stringify(items), id, order.items_json).run()
  if (!upd.meta.changes) return c.json({ success: false, error: '다른 곳에서 먼저 처리됐어요. 새로고침해 주세요' }, 409)

  // 주문 시각(UTC) → KST 날짜: 일한도 로그·월재고를 그 날짜/달 기준으로 되돌림
  const orderDate = new Date(new Date(String(order.created_at).replace(' ', 'T') + 'Z').getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10)
  const reason = '환불: ' + picked.map(p => `${p.item.label}×${p.qty}`).join(', ')
  const stu = await c.env.DB.prepare('SELECT id FROM students WHERE name=?').bind(order.student_name).first() as any
  const stmts: D1PreparedStatement[] = []
  if (stu && amount > 0) {
    stmts.push(c.env.DB.prepare('UPDATE students SET points = points + ? WHERE id=?').bind(amount, stu.id))
    stmts.push(c.env.DB.prepare('INSERT INTO point_history (student_id, delta, reason, category, created_at) VALUES (?,?,?,?,?)')
      .bind(stu.id, amount, reason, 'shop', getKSTTimestamp()))
  }
  for (const p of picked) {
    const itemId = p.item.id || p.item.label
    stmts.push(c.env.DB.prepare('INSERT INTO shop_purchase_log (item_id, student_id, student_name, qty, purchase_date) VALUES (?,?,?,?,?)')
      .bind(itemId, stu?.id ?? null, order.student_name, -p.qty, orderDate))
    stmts.push(c.env.DB.prepare('UPDATE shop_stock SET remaining_stock = remaining_stock + ?, updated_at = CURRENT_TIMESTAMP WHERE item_id=? AND month_key=?')
      .bind(p.qty, itemId, orderDate.slice(0, 7)))
  }
  await c.env.DB.batch(stmts)
  try { await sendKW(orderHook(c.env), `[환불] ${order.student_name}\n` + picked.map(p => `- ${p.item.label} × ${p.qty}`).join('\n') + `\n+${amount} ${order.currency} 돌려줌\n${getKSTTimestamp()}`) } catch (_) {}
  return c.json({ success: true, amount, items })
})



app.get('/api/health', (c) => c.json({

  status: 'ok',

  slack: !!c.env.SLACK_WEBHOOK_ORDER,

  notion: !!(c.env.NOTION_API_KEY && c.env.NOTION_DATABASE_ID),

  kakaowork_math: !!c.env.KAKAOWORK_WEBHOOK_MATH,

  kakaowork_english: !!c.env.KAKAOWORK_WEBHOOK_ENGLISH,

  db: !!c.env.DB,

  ts: new Date().toISOString()

}))





// ══════════════════════════════════════════════════════════════════════════════

//  API: 관리자 전용

// ══════════════════════════════════════════════════════════════════════════════



// 관리자 인증 확인용 엔드포인트 (로그인 검증)

app.get('/api/admin/auth', (c) => c.json({ success: true, message: '인증 성공' }))



app.post('/api/admin/students', async (c) => {

  const { name } = await c.req.json()

  if (!name) return c.json({ success: false, error: '이름 필요' }, 400)

  await c.env.DB.prepare('INSERT OR IGNORE INTO students (name) VALUES (?)').bind(name).run()

  return c.json({ success: true })

})



app.delete('/api/admin/students/:id', async (c) => {

  const id = c.req.param('id')

  await c.env.DB.prepare('DELETE FROM point_history WHERE student_id=?').bind(id).run()

  await c.env.DB.prepare('DELETE FROM fines WHERE student_id=?').bind(id).run()

  await c.env.DB.prepare('DELETE FROM students WHERE id=?').bind(id).run()

  return c.json({ success: true })

})



app.post('/api/admin/students/:id/photo', async (c) => {

  const id = c.req.param('id')

  const { photoBase64 } = await c.req.json()

  await c.env.DB.prepare('UPDATE students SET photo_url=? WHERE id=?').bind(photoBase64, id).run()

  return c.json({ success: true })

})



app.post('/api/admin/students/:id/points', async (c) => {

  const id = c.req.param('id')

  const { delta, reason } = await c.req.json()

  await c.env.DB.prepare('UPDATE students SET points = points + ? WHERE id=?').bind(delta, id).run()

  await c.env.DB.prepare(

    'INSERT INTO point_history (student_id, delta, reason, category, created_at) VALUES (?,?,?,?,?)'

  ).bind(id, delta, reason || '관리자 조정', 'admin', getKSTTimestamp()).run()

  return c.json({ success: true })

})



// ── 학생별 시간표 조회/저장 ─────────────────────────────────────────────────
app.get('/api/admin/students/:id/schedule', async (c) => {
  const id = c.req.param('id')
  try {
    const row = await c.env.DB.prepare(
      'SELECT schedule_json FROM student_schedules WHERE student_id=?'
    ).bind(id).first() as any
    const schedule = row?.schedule_json ? parseSlots(row.schedule_json) : []
    return c.json({ success: true, schedule })
  } catch (e: any) {
    return c.json({ success: false, schedule: [], error: e.message })
  }
})

app.post('/api/admin/students/:id/schedule', async (c) => {
  const id = c.req.param('id')
  try {
    const { schedule } = await c.req.json()
    const json = JSON.stringify(Array.isArray(schedule) ? schedule : [])
    await c.env.DB.prepare(
      'INSERT INTO student_schedules (student_id, schedule_json, updated_at) VALUES (?,?,CURRENT_TIMESTAMP) ON CONFLICT(student_id) DO UPDATE SET schedule_json=excluded.schedule_json, updated_at=CURRENT_TIMESTAMP'
    ).bind(id, json).run()
    return c.json({ success: true })
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500)
  }
})

async function sendMogakKW(env: Bindings, d: { name: string, cat: string, missions: any[] }) {
  const webhook = kwCat(env, d.cat)
  if (!webhook) return
  const icon = d.cat.includes('영어') ? '📘' : '📐'
  const now = new Date(Date.now() + 9*3600*1000)
  const ts = String(now.getUTCHours()).padStart(2,'0') + ':' + String(now.getUTCMinutes()).padStart(2,'0')
  const mList = d.missions.length > 0 ? d.missions.map((m:any) => '- ' + (m.text||String(m))).join('\n') : '- 없음'
  const text = ['[모각공 완료] ' + d.name + ' · ' + d.cat, '완료한 미션:', mList, ts + ' · 어드민 현황보기에서 확인 후 포인트 적립'].join('\n')
  await sendKW(webhook, text)
}

async function sendKW(url: string, text: string) {
  if (!url) { console.error('KakaoWork: 웹훅 URL 미설정'); return { ok: false, reason: 'no-url' } }
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) })
    if (!r.ok) {
      const body = await r.text().catch(() => '')
      console.error('KakaoWork 응답 오류:', r.status, body.slice(0, 300))
      return { ok: false, status: r.status, body: body.slice(0, 300) }
    }
    return { ok: true, status: r.status }
  } catch(e: any) { console.error('KakaoWork 전송 오류:', e); return { ok: false, reason: String(e) } }
}

function kwMath(env: Bindings)    { return env.KAKAOWORK_WEBHOOK_MATH || '' }
function orderHook(env: Bindings) { return env.SLACK_WEBHOOK_ORDER || kwMath(env) }
function kwEnglish(env: Bindings) { return env.KAKAOWORK_WEBHOOK_ENGLISH || env.KAKAOWORK_WEBHOOK_MATH || '' }
function kwCat(env: Bindings, cat: string) { return cat.includes('영어') ? kwEnglish(env) : kwMath(env) }

// ── 기존 Slack 함수 (슬랙 대신 카카오워크로 전송) ────────────────────────────

async function sendSlackQueue(env: Bindings, d: any) {

  const waitText = d.waiting === 0 ? '없음 (즉시 가능)' : d.waiting + '명 대기 중'
  const text = '[번호표] ' + d.studentName + ' · ' + d.number + '번\n대기: ' + waitText + ' · ' + d.ts
  await sendKW(kwMath(env), text)
  return true

}



// ── Slack ──────────────────────────────────────────────────────────────────────

async function sendMogakSlack(env: Bindings, d: { name: string, cat: string, missions: any[] }) {
  // sendMogakKW 로 위임
  await sendMogakKW(env, d)
}

async function sendSlack(env: Bindings, d: any) {

  const catLabel: Record<string, string> = { learn: '학습 활동', fine: '벌금', shop: '보상 교환' }
  const itemListKW = d.items.map((x: any) => '- ' + x.label + ' × ' + x.qty).join('\n')
  const costTextKW = d.totalCost === 0 ? '무료' : d.totalCost < 0
    ? '+' + Math.abs(d.totalCost) + ' ' + d.currency + ' 획득'
    : '-' + d.totalCost + ' ' + d.currency + ' 차감'
  const kwLines = [
    '[' + (catLabel[d.category] || d.category) + '] ' + d.name,
    itemListKW,
    '합계: ' + costTextKW,
  ]
  if (d.comment) kwLines.push('코멘트: ' + d.comment)
  kwLines.push(d.timestamp)

  // 슬랙 주문 웹훅(없으면 카카오워크) — 둘 다 {text} 평문이라 전송기는 같다
  await sendKW(orderHook(env), kwLines.join('\n'))

  return true

  // Bot Token이 있으면 인증사진도 Slack에 업로드
  if (d.photoBase64 && env.SLACK_BOT_TOKEN && env.SLACK_CHANNEL_ID) {

    try {

      const imgData = d.photoBase64.replace(/^data:image\/\w+;base64,/, '')

      const mimeMatch = d.photoBase64.match(/^data:(image\/\w+);base64,/)

      const mime = mimeMatch ? mimeMatch[1] : 'image/jpeg'

      const ext = mime.split('/')[1] || 'jpg'

      const binStr = atob(imgData)

      const binArr = new Uint8Array(binStr.length)

      for (let i = 0; i < binStr.length; i++) binArr[i] = binStr.charCodeAt(i)

      const form = new FormData()

      form.append('channels', env.SLACK_CHANNEL_ID)

      form.append('filename', `cert_${d.name}_${Date.now()}.${ext}`)

      form.append('initial_comment', `📸 ${d.name} 학생의 인증 사진`)

      form.append('file', new Blob([binArr], { type: mime }), `photo.${ext}`)

      await fetch('https://slack.com/api/files.upload', {

        method: 'POST',

        headers: { Authorization: `Bearer ${env.SLACK_BOT_TOKEN}` },

        body: form,

      })

    } catch (_) {}

  }

  return true

}



// ── Notion ─────────────────────────────────────────────────────────────────────

async function saveNotion(env: Bindings, d: any) {

  if (!env.NOTION_API_KEY || !env.NOTION_DATABASE_ID) return false

  const catLabel: Record<string, string> = { learn: '학습 활동', fine: '벌금', shop: '보상 교환' }

  const itemList = d.items.map((x) => `${x.icon} ${x.label} × ${x.qty}${x.comment ? ' ('+x.comment+')' : ''}`).join(', ')

  const costText = d.totalCost === 0 ? '무료' : d.totalCost < 0

    ? `+${Math.abs(d.totalCost)} ${d.currency}`

    : `-${d.totalCost} ${d.currency}`



  // 페이지 본문 블록: 코멘트 + 이미지

  const children: any[] = []

  if (d.comment) {

    children.push({

      object: 'block', type: 'callout',

      callout: {

        rich_text: [{ type: 'text', text: { content: `💬 ${d.comment}` } }],

        icon: { emoji: '💬' }, color: 'blue_background'

      }

    })

  }

  if (d.photoBase64) {

    // base64 이미지는 Notion external URL로 직접 삽입 불가 → 단락에 텍스트로 안내

    // 실제 이미지: file_upload API 또는 외부 URL 필요

    // → base64 자체를 data URI로 파일 블록에 넣으면 Notion이 거부하므로

    //   대신 이미지가 첨부됐다는 안내 + items 각각의 comment에서 사진 정보 표시

    children.push({

      object: 'block', type: 'callout',

      callout: {

        rich_text: [{ type: 'text', text: { content: '📸 인증 사진이 첨부되었습니다 (키오스크 제출)' } }],

        icon: { emoji: '📸' }, color: 'yellow_background'

      }

    })

    // Notion File Upload API로 실제 이미지 업로드 시도

    try {

      const imgData = d.photoBase64.replace(/^data:image\/\w+;base64,/, '')

      const mimeMatch = d.photoBase64.match(/^data:(image\/\w+);base64,/)

      const mime = mimeMatch ? mimeMatch[1] : 'image/jpeg'

      const ext = mime.split('/')[1] || 'jpg'

      // Step1: 업로드 URL 발급

      const uploadRes = await fetch('https://api.notion.com/v1/file_uploads', {

        method: 'POST',

        headers: { Authorization: `Bearer ${env.NOTION_API_KEY}`, 'Content-Type': 'application/json', 'Notion-Version': '2022-06-28' },

        body: JSON.stringify({ name: `photo.${ext}`, content_type: mime })

      })

      if (uploadRes.ok) {

        const uploadData = await uploadRes.json() as any

        const uploadUrl = uploadData.upload_url

        const fileId = uploadData.id

        // Step2: 이미지 바이너리 업로드

        const binStr = atob(imgData)

        const binArr = new Uint8Array(binStr.length)

        for (let i = 0; i < binStr.length; i++) binArr[i] = binStr.charCodeAt(i)

        const uploadBinRes = await fetch(uploadUrl, {

          method: 'PUT',

          headers: { 'Content-Type': mime },

          body: binArr

        })

        if (uploadBinRes.ok) {

          // Step3: 업로드된 파일 ID로 이미지 블록 추가

          children.push({

            object: 'block', type: 'image',

            image: { type: 'file_upload', file_upload: { id: fileId } }

          })

          // 안내 블록은 제거 (이미지 성공)

          children.splice(children.findIndex((b) => b.callout?.icon?.emoji === '📸'), 1)

        }

      }

    } catch (_) { /* 실패시 안내 텍스트만 남김 */ }

  }



  const payload: any = {

    parent: { database_id: env.NOTION_DATABASE_ID },

    properties: {

      '학생 이름': { title: [{ text: { content: d.name } }] },

      '항목': { rich_text: [{ text: { content: itemList } }] },

      '금액': { rich_text: [{ text: { content: costText } }] },

      '구분': { multi_select: [{ name: catLabel[d.category] || d.category }] },

      '접수 일시': { date: { start: new Date().toISOString() } },

      '상태': { select: { name: '접수 완료' } },

    },

  }

  if (children.length > 0) payload.children = children



  const res = await fetch('https://api.notion.com/v1/pages', {

    method: 'POST',

    headers: { Authorization: `Bearer ${env.NOTION_API_KEY}`, 'Content-Type': 'application/json', 'Notion-Version': '2022-06-28' },

    body: JSON.stringify(payload),

  })

  if (!res.ok) { const t = await res.text(); throw new Error(`Notion ${res.status}: ${t}`) }

  return true

}



// ── 요청사항 Slack ─────────────────────────────────────────────────────────────

const DEFAULT_CONFIG = {

  currency: { unit: '포인트', symbol: 'star', desc: '포인트를 모아 간식과 바꿔요' },

  menu: {

    learn: [],

    fine: [],

    shop: [

      { id: 'choco',      icon: 'choco', label: '초콜릿(달달구리)', cost: 3, reward: 0, requirePhoto: false, soldOut: false },

      { id: 'jelly',      icon: 'jelly', label: '젤리',             cost: 2, reward: 0, requirePhoto: false, soldOut: false },

      { id: 'candy',      icon: 'candy', label: '사탕',             cost: 2, reward: 0, requirePhoto: false, soldOut: false },

      { id: 'snack',      icon: 'snack', label: '과자',             cost: 3, reward: 0, requirePhoto: false, soldOut: false },

      { id: 'saekkomdal', icon: 'saekkomdal', label: '새콤달콤',         cost: 2, reward: 0, requirePhoto: false, soldOut: false },

      { id: 'vitaminc',   icon: 'vitaminc', label: '비타민C',          cost: 2, reward: 0, requirePhoto: false, soldOut: false },

    ],

  },

}



app.get('/', (c) => c.html(MAIN_HTML))

app.get('/admin', (c) => c.html(ADMIN_HTML))

// ── PWA: 앱 설치(홈 화면에 추가)용 매니페스트 / 서비스워커 ──
const PWA_MANIFEST = {
  name: '바꿈수학 띵똥',
  short_name: '띵똥',
  description: '바꿈수학 수학 키오스크 — 잘하면 띵똥! 포인트가 쌓여요',
  lang: 'ko',
  start_url: '/',
  scope: '/',
  display: 'standalone',
  orientation: 'portrait',
  background_color: '#EEF3EE',
  theme_color: '#11998A',
  icons: [
    { src: '/static/logo_square.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/static/logo_square.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: '/static/logo_square.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
  ]
}

app.get('/manifest.webmanifest', (c) => {
  c.header('Content-Type', 'application/manifest+json; charset=utf-8')
  c.header('Cache-Control', 'public, max-age=86400')
  return c.body(JSON.stringify(PWA_MANIFEST))
})

const SW_JS = `// 띵똥 키오스크 서비스워커
const CACHE='ddong-v1';
const SHELL=['/','/static/logo_square.png','/static/logo_horizontal.png'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(CACHE).then(c=>c.addAll(SHELL).catch(()=>{})));self.skipWaiting();});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));});
self.addEventListener('fetch',e=>{
  const req=e.request;
  if(req.method!=='GET'){return;}
  const url=new URL(req.url);
  // API는 항상 네트워크 (캐시 금지)
  if(url.pathname.startsWith('/api/')){return;}
  // 페이지 이동: 네트워크 우선, 실패 시 캐시된 / 제공
  if(req.mode==='navigate'){
    e.respondWith(fetch(req).then(r=>{const cp=r.clone();caches.open(CACHE).then(c=>c.put('/',cp));return r;}).catch(()=>caches.match('/')));
    return;
  }
  // 그 외(정적/폰트): 캐시 우선, 없으면 네트워크 후 캐시
  e.respondWith(caches.match(req).then(hit=>hit||fetch(req).then(r=>{if(r.ok&&(url.origin===location.origin||url.host.includes('jsdelivr')||url.host.includes('gstatic'))){const cp=r.clone();caches.open(CACHE).then(c=>c.put(req,cp));}return r;}).catch(()=>hit)));
});`

app.get('/sw.js', (c) => {
  c.header('Content-Type', 'application/javascript; charset=utf-8')
  c.header('Service-Worker-Allowed', '/')
  c.header('Cache-Control', 'no-cache')
  return c.body(SW_JS)
})



// ══════════════════════════════════════════════════════════════════════════════

//  메인 키오스크 HTML

// ══════════════════════════════════════════════════════════════════════════════

const MAIN_HTML = `<!DOCTYPE html>

<html lang="ko">

<head>

  <meta charset="UTF-8"/>

  <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover"/>

  <title>바꿈수학 띵똥</title>

  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%2311998A' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M6 9a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6Z'/><path d='M10.5 19a1.5 1.5 0 0 0 3 0'/></svg>"/>

  <!-- PWA: 홈 화면에 앱으로 설치 -->
  <link rel="manifest" href="/manifest.webmanifest"/>
  <meta name="theme-color" content="#11998A"/>
  <meta name="mobile-web-app-capable" content="yes"/>
  <meta name="apple-mobile-web-app-capable" content="yes"/>
  <meta name="apple-mobile-web-app-status-bar-style" content="default"/>
  <meta name="apple-mobile-web-app-title" content="띵똥"/>
  <link rel="apple-touch-icon" href="/static/logo_square.png"/>

  <link rel="preconnect" href="https://fonts.googleapis.com"/>
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
  <link href="https://fonts.googleapis.com/css2?family=Black+Han+Sans&family=Gaegu:wght@400;700&display=swap" rel="stylesheet"/>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/static/pretendard.css"/>

  <style>
    :root{
      /* 종이 / 잉크 */
      --paper:#EEF3EE; --paper-2:#E4EDE3;
      --ink:#1E261F; --ink-soft:#6B5E45; --ink-faint:#8A7A5C; --line:#E0D2B2;
      --white:#ffffff; --sky:#E4EDE3;
      /* 액센트 (플랫) */
      --cobalt:#11998A; --persimmon:#F2724B; --butter:#F4B62B; --moss:#4C8A3A; --clay:#C0473A; --lilac:#7A5CD0;
      /* 틴트 배경 (아이콘 타일) */
      --t-moss:#E6F1E5; --t-cobalt:#E2F1EF; --t-butter:#FCF3DC; --t-clay:#FCEAE6; --t-choco:#FBEFD6; --t-jelly:#FCE7E2;
      /* ── 호환용 별칭(기존 클래스/인라인 스타일이 참조) ── */
      --blue:#11998A; --blue-d:#0E8275; --blue-dd:#0B6B60; --blue-soft:#E2F1EF; --blue-mid:#7FC9C0;
      --g50:#F6F8F5; --g100:#E4EDE3; --g200:#D8C9A8; --g300:#C9BA98; --g400:#8A7A5C; --g500:#6B5E45; --g600:#6B5E45; --g800:#1E261F;
      --yellow:#F4B62B; --yellow-d:#D99A12; --yellow-s:#FCF3DC;
      --green:#4C8A3A; --green-s:#E6F1E5;
      --red:#C0473A; --red-s:#FCE7E2;
      --purple:#7A5CD0; --purple-s:#EFEAFB;
      --orange:#F2724B; --orange-s:#FCEAE6;
      --r-xl:30px; --r-lg:18px; --r-md:14px; --r-sm:12px;
      --shadow:5px 5px 0 var(--ink);
    }
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}
    html{font-size:16px;}
    body{font-family:'Pretendard',sans-serif;background:#EEF3EE;background-image:radial-gradient(#DBE6DB 1.3px, transparent 1.5px);background-size:22px 22px;color:var(--ink);min-height:100vh;overflow-x:hidden;-webkit-tap-highlight-color:transparent;user-select:none;}

    @keyframes ddring{0%,72%,100%{transform:rotate(0)}78%{transform:rotate(11deg)}84%{transform:rotate(-9deg)}90%{transform:rotate(6deg)}96%{transform:rotate(-3deg)}}

    /* 헤더 */
    .hdr{position:relative;z-index:20;background:var(--paper);border-bottom:2px solid var(--ink);padding:0 clamp(14px,3vw,32px);height:clamp(56px,7vw,68px);display:flex;align-items:center;justify-content:space-between;}
    .hdr-logo{display:flex;align-items:center;gap:8px;color:var(--cobalt);}
    .hdr-logo svg{width:clamp(22px,3vw,28px);height:clamp(22px,3vw,28px);display:block;}
    .hdr-wordmark{font-family:'Black Han Sans';font-size:clamp(20px,2.8vw,26px);color:var(--ink);letter-spacing:.5px;line-height:1;}
    .hdr-r{display:flex;align-items:center;gap:8px;}
    .clock{display:flex;align-items:center;gap:5px;font-size:clamp(11px,1.5vw,14px);font-weight:800;color:var(--ink);background:var(--white);border:2px solid var(--ink);padding:5px 12px;border-radius:100px;font-variant-numeric:tabular-nums;}
    .home-btn{display:flex;align-items:center;gap:5px;background:var(--white);border:2px solid var(--ink);color:var(--ink);font-family:inherit;font-size:clamp(11px,1.4vw,13px);font-weight:800;padding:6px 14px;border-radius:100px;cursor:pointer;transition:all .15s;}
    .home-btn:hover{background:var(--paper-2);}

    /* 화면 */
    .screen{display:none;position:relative;z-index:5;}
    .screen.active{display:block;}

    /* ── 스플래시 ── */
    #splash{min-height:calc(100vh - clamp(56px,7vw,68px));display:none;flex-direction:column;align-items:center;justify-content:center;padding:clamp(20px,4vw,48px) 20px;gap:clamp(12px,2.5vw,18px);cursor:pointer;text-align:center;}
    #splash.active{display:flex;}
    .sp-logo{width:clamp(96px,16vw,124px);height:clamp(96px,16vw,124px);border-radius:34px;border:2px solid var(--ink);background:var(--cobalt);box-shadow:6px 6px 0 var(--ink);display:flex;align-items:center;justify-content:center;color:var(--butter);}
    .sp-logo svg{width:54%;height:54%;transform-origin:50% 18%;animation:ddring 3.4s ease-in-out infinite;}
    .sp-kicker{font-weight:800;font-size:clamp(11px,1.8vw,14px);letter-spacing:.22em;color:var(--ink-faint);}
    .sp-title{font-family:'Black Han Sans';font-size:clamp(46px,11vw,82px);font-weight:400;color:var(--ink);letter-spacing:1px;line-height:.92;}
    .sp-desc{font-weight:700;font-size:clamp(13px,1.8vw,16px);color:var(--cobalt);}
    .sp-badge{display:inline-flex;align-items:center;gap:8px;background:var(--white);border:2px solid var(--ink);color:var(--ink);font-weight:700;font-size:clamp(12px,1.7vw,14px);padding:10px 16px;border-radius:var(--r-sm);}
    .sp-badge svg{flex:none;}
    .tap-btn{margin-top:6px;background:var(--persimmon);color:#fff;font-size:clamp(15px,2.2vw,21px);font-weight:800;padding:clamp(15px,2vw,20px) clamp(28px,5vw,52px);border-radius:var(--r-lg);border:2px solid var(--ink);box-shadow:var(--shadow);cursor:pointer;display:flex;align-items:center;gap:10px;font-family:inherit;transition:all .12s;}
    .tap-btn:hover{transform:translate(2px,2px);box-shadow:3px 3px 0 var(--ink);}
    .sp-footer{display:flex;align-items:center;gap:8px;font-size:11px;font-weight:700;color:var(--ink-faint);letter-spacing:.04em;margin-top:4px;}

    /* ── 학생 선택 ── */
    #student-screen{min-height:calc(100vh - clamp(56px,7vw,68px));padding:clamp(14px,2vw,24px) clamp(14px,3vw,28px);}
    .page-top{display:flex;align-items:center;gap:12px;margin-bottom:clamp(10px,1.8vw,18px);}
    .back-btn{width:42px;height:42px;border-radius:var(--r-sm);background:var(--white);border:2px solid var(--ink);display:flex;align-items:center;justify-content:center;cursor:pointer;font-size:14px;color:var(--ink);transition:all .12s;flex-shrink:0;}
    .back-btn:hover{transform:translate(2px,2px);}
    .page-title{font-family:'Black Han Sans';font-size:clamp(20px,3vw,28px);font-weight:400;color:var(--ink);line-height:1;}
    .page-sub{font-size:clamp(12px,1.4vw,13px);font-weight:600;color:var(--ink-soft);margin-top:4px;}
    .search-wrap{position:relative;margin-bottom:clamp(10px,1.6vw,16px);}
    .search-inp{width:100%;background:var(--white);border:2px solid var(--ink);border-radius:var(--r-md);padding:clamp(11px,1.5vw,13px) 14px clamp(11px,1.5vw,13px) 42px;font-family:inherit;font-size:clamp(14px,1.8vw,16px);font-weight:600;color:var(--ink);outline:none;}
    .search-inp::placeholder{color:#A89A7C;}
    .search-ic{position:absolute;left:14px;top:50%;transform:translateY(-50%);color:var(--ink-faint);font-size:15px;}
    .student-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(clamp(110px,16vw,150px),1fr));gap:clamp(10px,1.4vw,13px);}
    .stu-btn{background:var(--white);border:2px solid var(--ink);border-radius:var(--r-lg);padding:clamp(16px,2vw,20px) 8px clamp(12px,1.5vw,16px);cursor:pointer;display:flex;flex-direction:column;align-items:center;gap:8px;transition:all .12s;box-shadow:4px 4px 0 rgba(36,28,18,.12);position:relative;}
    .stu-btn:hover{transform:translate(2px,2px);box-shadow:2px 2px 0 rgba(36,28,18,.12);}
    .stu-btn:active{transform:translate(3px,3px);}
    .stu-photo{width:clamp(54px,8vw,66px);height:clamp(54px,8vw,66px);border-radius:50%;object-fit:cover;border:2px solid var(--ink);background:var(--white);}
    .stu-av{width:clamp(54px,8vw,66px);height:clamp(54px,8vw,66px);border-radius:50%;border:2px solid var(--ink);display:flex;align-items:center;justify-content:center;font-family:'Black Han Sans';font-size:clamp(22px,3.4vw,30px);color:#fff;background:var(--cobalt);}
    .stu-name{font-size:clamp(13px,1.6vw,16px);font-weight:800;color:var(--ink);text-align:center;}
    .stu-pts{display:inline-flex;align-items:center;gap:4px;font-size:clamp(10px,1.3vw,12px);font-weight:800;background:var(--t-butter);color:var(--ink);border:1.5px solid var(--ink);border-radius:100px;padding:3px 10px;}
    .stu-btn.hidden{display:none;}

    /* ── 학생 배너 (메뉴 위) ── */
    #menu-screen{min-height:calc(100vh - clamp(56px,7vw,68px));padding:clamp(12px,1.8vw,20px) clamp(14px,3vw,28px) 110px;}
    .stu-banner{display:flex;align-items:center;gap:13px;background:var(--cobalt);color:#fff;border:2px solid var(--ink);border-radius:var(--r-lg);box-shadow:var(--shadow);padding:clamp(12px,1.6vw,16px) clamp(14px,2.2vw,18px);margin-bottom:clamp(12px,1.6vw,16px);}
    .stu-banner-photo{width:clamp(46px,6vw,54px);height:clamp(46px,6vw,54px);border-radius:50%;object-fit:cover;border:2px solid var(--ink);background:#fff;flex-shrink:0;}
    .stu-banner-av{width:clamp(46px,6vw,54px);height:clamp(46px,6vw,54px);border-radius:50%;background:#fff;color:var(--ink);display:flex;align-items:center;justify-content:center;font-family:'Black Han Sans';font-size:clamp(18px,2.4vw,24px);border:2px solid var(--ink);flex-shrink:0;}
    .stu-banner-info{flex:1;min-width:0;}
    .stu-banner-name{font-weight:800;font-size:clamp(15px,2vw,19px);line-height:1.1;}
    .stu-banner-stats{display:flex;gap:8px;margin-top:5px;flex-wrap:wrap;}
    .stat-chip{display:inline-flex;align-items:center;gap:5px;background:var(--butter);color:var(--ink);border:2px solid var(--ink);border-radius:100px;padding:4px 11px;font-weight:800;font-size:clamp(11px,1.3vw,13px);white-space:nowrap;}
    .stat-chip.red-chip{background:var(--clay);color:#fff;}
    .stat-chip.orange-chip{background:var(--persimmon);color:#fff;}
    .stat-chip.status-chip{cursor:pointer;}
    .stat-chip.status-chip:hover{transform:translate(1px,1px);}
    .btn-change{display:flex;align-items:center;gap:4px;background:#fff;border:2px solid var(--ink);color:var(--ink);font-family:inherit;font-size:clamp(11px,1.3vw,13px);font-weight:800;padding:7px 12px;border-radius:100px;cursor:pointer;transition:all .12s;white-space:nowrap;flex-shrink:0;}
    .btn-change:hover{transform:translate(1px,1px);}

    /* 탭 */
    .tab-row{display:flex;gap:8px;margin-bottom:clamp(10px,1.6vw,16px);overflow-x:auto;padding-bottom:2px;}
    .tab-row::-webkit-scrollbar{display:none;}
    .tab-btn{display:flex;align-items:center;gap:6px;font-family:inherit;font-size:clamp(11px,1.5vw,14px);font-weight:800;padding:clamp(8px,1.1vw,11px) clamp(13px,1.8vw,18px);border-radius:100px;cursor:pointer;transition:all .12s;white-space:nowrap;border:2px solid var(--ink);background:var(--white);color:var(--ink-soft);}
    .tab-dot{width:8px;height:8px;border-radius:50%;background:currentColor;}
    .tab-btn.active-learn{background:var(--moss);color:#fff;}
    .tab-btn.active-fine{background:var(--clay);color:#fff;}
    .tab-btn.active-shop{background:var(--persimmon);color:#fff;}

    /* 메뉴 그리드 */
    .menu-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(clamp(110px,16vw,160px),1fr));gap:clamp(10px,1.4vw,13px);}
    .menu-btn{background:var(--white);border:2px solid var(--ink);border-radius:var(--r-lg);padding:clamp(15px,2vw,20px) clamp(12px,1.6vw,16px);cursor:pointer;display:flex;flex-direction:column;align-items:center;justify-content:flex-start;gap:9px;transition:all .12s;text-align:center;box-shadow:4px 4px 0 rgba(36,28,18,.12);position:relative;overflow:visible;}
    .menu-btn:hover{transform:translate(2px,2px);box-shadow:2px 2px 0 rgba(36,28,18,.12);}
    .menu-btn:active{transform:translate(3px,3px) !important;}
    .menu-ic{width:46px;height:46px;flex:none;border:2px solid var(--ink);border-radius:12px;display:flex;align-items:center;justify-content:center;}
    .type-learn .menu-ic{background:var(--t-moss);color:var(--moss);}
    .type-fine  .menu-ic{background:var(--t-clay);color:var(--clay);}
    .type-shop  .menu-ic{background:var(--t-choco);color:var(--persimmon);}
    .menu-btn.in-cart{border-width:3px;}
    .menu-btn.in-cart.type-learn{border-color:var(--moss);}
    .menu-btn.in-cart.type-fine{border-color:var(--clay);}
    .menu-btn.in-cart.type-shop{border-color:var(--persimmon);}
    .menu-btn.sold-out{opacity:.85;cursor:not-allowed;}
    .menu-btn.sold-out .menu-ic{filter:grayscale(.5);}
    #shop-unlock-badge{display:none;}
    #shopUnlockReqBtn:hover{transform:translate(2px,2px);}
    #shopUnlockReqBtn:active{transform:translate(3px,3px);}
    .menu-btn.sold-out:hover{transform:none;box-shadow:4px 4px 0 rgba(36,28,18,.12);}
    .menu-lbl{font-size:clamp(12px,1.5vw,14px);font-weight:800;color:var(--ink);line-height:1.25;}
    .menu-cost-tag{display:inline-flex;align-items:center;gap:4px;font-size:clamp(10px,1.3vw,12px);font-weight:800;padding:4px 10px;border-radius:100px;border:1.5px solid var(--ink);}
    .type-learn .menu-cost-tag{background:var(--t-moss);color:var(--moss);}
    .type-fine  .menu-cost-tag{background:var(--t-clay);color:var(--clay);}
    .type-shop  .menu-cost-tag{background:var(--t-butter);color:var(--ink);}
    .photo-badge-sm{position:absolute;top:-7px;right:-7px;display:flex;align-items:center;justify-content:center;width:24px;height:24px;background:var(--persimmon);color:#fff;border:2px solid var(--ink);border-radius:50%;}
    .photo-badge-sm svg{width:13px;height:13px;}
    .qty-ctrl{display:flex;align-items:center;border-radius:100px;overflow:hidden;border:2px solid var(--ink);background:var(--white);margin-top:2px;}
    .qty-minus,.qty-plus{width:30px;height:30px;border:none;cursor:pointer;font-size:18px;font-weight:900;display:flex;align-items:center;justify-content:center;background:transparent;line-height:1;color:var(--ink);}
    .qty-num{font-size:15px;font-weight:900;min-width:26px;text-align:center;color:var(--ink);font-variant-numeric:tabular-nums;}
    .menu-btn{cursor:pointer;}
    .bhs{font-family:'Black Han Sans';font-weight:400;}

    /* 장바구니 바 */
    .cart-bar{position:fixed;bottom:0;left:0;right:0;z-index:50;background:var(--paper);border-top:2px solid var(--ink);padding:clamp(10px,1.6vw,14px) clamp(14px,3vw,28px);display:none;align-items:center;justify-content:space-between;gap:10px;}
    .cart-bar.visible{display:flex;}
    .cart-ic{width:46px;height:46px;border-radius:var(--r-md);background:var(--white);border:2px solid var(--ink);display:flex;align-items:center;justify-content:center;color:var(--ink);flex-shrink:0;position:relative;}
    .cart-ic svg{width:24px;height:24px;}
    .cart-badge{position:absolute;top:-8px;right:-8px;background:var(--persimmon);color:#fff;font-size:11px;font-weight:900;min-width:22px;height:22px;border-radius:11px;display:flex;align-items:center;justify-content:center;border:2px solid var(--ink);padding:0 3px;}
    .cart-cnt{font-size:clamp(12px,1.4vw,14px);font-weight:800;color:var(--ink);}
    .cart-preview{font-size:clamp(10px,1.3vw,12px);font-weight:600;color:var(--ink-faint);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:clamp(100px,16vw,220px);}
    .cart-btns{display:flex;gap:8px;flex-shrink:0;}
    .btn-cc{background:var(--white);border:2px solid var(--ink);color:var(--ink);font-family:inherit;font-size:clamp(11px,1.4vw,13px);font-weight:700;padding:clamp(9px,1.4vw,12px) clamp(11px,1.8vw,15px);border-radius:var(--r-md);cursor:pointer;transition:all .12s;display:flex;align-items:center;}
    .btn-cc:hover{transform:translate(1px,1px);}
    .btn-cs{background:var(--persimmon);border:2px solid var(--ink);color:#fff;font-family:inherit;font-size:clamp(12px,1.6vw,15px);font-weight:800;padding:clamp(9px,1.4vw,12px) clamp(15px,2.2vw,22px);border-radius:var(--r-md);cursor:pointer;transition:all .12s;box-shadow:3px 3px 0 var(--ink);display:flex;align-items:center;gap:6px;}
    .btn-cs:hover{transform:translate(2px,2px);box-shadow:1px 1px 0 var(--ink);}

    /* 모달 */
    .modal-ov{position:fixed;inset:0;z-index:200;background:rgba(36,28,18,.55);display:none;align-items:center;justify-content:center;padding:16px;}
    .modal-ov.open{display:flex;}
    .modal-box{background:var(--paper);border:2px solid var(--ink);border-radius:var(--r-xl);padding:clamp(22px,3.5vw,32px) clamp(18px,3.5vw,28px);width:min(490px,96vw);box-shadow:8px 8px 0 var(--ink);animation:mpop .28s cubic-bezier(.34,1.4,.64,1);}
    @keyframes mpop{from{opacity:0;transform:scale(.9) translateY(14px);}to{opacity:1;transform:scale(1) translateY(0);}}
    .modal-title{display:flex;align-items:center;gap:8px;font-family:'Black Han Sans';font-size:clamp(18px,2.4vw,24px);font-weight:400;color:var(--ink);margin-bottom:5px;}
    .modal-sub{font-size:14px;font-weight:600;color:var(--ink-soft);}
    .photo-zone{border:2.5px dashed #C3B28F;border-radius:var(--r-lg);background:var(--white);padding:clamp(20px,3.5vw,32px) 20px;text-align:center;cursor:pointer;transition:all .15s;position:relative;overflow:hidden;margin:14px 0;}
    .photo-zone:hover{border-color:var(--cobalt);}
    .photo-zone input{position:absolute;inset:0;opacity:0;cursor:pointer;width:100%;height:100%;}
    .photo-prev{max-width:100%;max-height:200px;border-radius:var(--r-md);object-fit:cover;display:none;margin:0 auto;}
    .photo-ph{pointer-events:none;display:flex;flex-direction:column;align-items:center;gap:8px;}
    .photo-ph .ph-badge{width:54px;height:54px;border-radius:50%;border:2px solid var(--ink);background:var(--t-cobalt);color:var(--cobalt);display:flex;align-items:center;justify-content:center;}
    .photo-ph i{font-size:30px;color:var(--cobalt);}
    .photo-ph p{font-size:15px;font-weight:800;color:var(--ink);}
    .photo-ph span{font-size:12px;font-weight:600;color:var(--ink-faint);}
    .modal-btns{display:flex;gap:10px;margin-top:14px;}
    .btn-mc{flex:1;background:var(--white);border:2px solid var(--ink);color:var(--ink);font-family:inherit;font-size:14px;font-weight:800;padding:13px;border-radius:var(--r-md);cursor:pointer;transition:all .12s;}
    .btn-mc:hover{transform:translate(1px,1px);}
    .btn-mok{flex:2;background:var(--cobalt);border:2px solid var(--ink);color:#fff;font-family:inherit;font-size:14px;font-weight:800;padding:13px;border-radius:var(--r-md);cursor:pointer;box-shadow:3px 3px 0 var(--ink);display:flex;align-items:center;justify-content:center;gap:8px;transition:all .12s;}
    .btn-mok:disabled{opacity:.4;cursor:not-allowed;box-shadow:none;}
    .btn-mok:not(:disabled):hover{transform:translate(2px,2px);box-shadow:1px 1px 0 var(--ink);}

    /* 확인 모달 */
    #confirm-modal .modal-box{max-width:530px;}
    .confirm-stu-row{display:flex;align-items:center;gap:10px;background:var(--white);border:2px solid var(--ink);border-radius:var(--r-md);padding:12px 16px;margin-bottom:14px;}
    .confirm-av{width:44px;height:44px;border-radius:50%;object-fit:cover;border:2px solid var(--ink);}
    .confirm-av-txt{width:44px;height:44px;border-radius:50%;background:var(--cobalt);border:2px solid var(--ink);display:flex;align-items:center;justify-content:center;font-family:'Black Han Sans';font-size:18px;color:#fff;}
    .confirm-sn{font-size:17px;font-weight:800;color:var(--ink);}
    .order-list{display:flex;flex-direction:column;gap:8px;margin-bottom:13px;}
    .order-item{display:flex;align-items:center;gap:11px;background:var(--white);border:2px solid var(--ink);border-radius:var(--r-md);padding:10px 13px;}
    .order-emoji{width:36px;height:36px;flex:none;border:2px solid var(--ink);border-radius:10px;background:var(--paper-2);display:flex;align-items:center;justify-content:center;color:var(--ink);}
    .order-info{flex:1;}
    .order-lbl{font-size:13px;font-weight:800;}
    .order-qty{display:flex;align-items:center;gap:4px;font-size:11px;font-weight:600;color:var(--ink-faint);margin-top:1px;}
    .order-cost{display:flex;align-items:center;gap:3px;font-size:13px;font-weight:900;white-space:nowrap;}
    .order-cost.green{color:var(--moss);}
    .order-cost.red{color:var(--clay);}
    .order-cost.purple{color:var(--persimmon);}
    .total-row{display:flex;align-items:center;justify-content:space-between;background:var(--ink);border:2px solid var(--ink);border-radius:var(--r-md);padding:14px 16px;margin-bottom:15px;}
    .total-lbl{font-size:13px;font-weight:800;color:var(--paper);}
    .total-val{display:flex;align-items:center;gap:5px;font-family:'Black Han Sans';font-size:22px;font-weight:400;color:var(--butter);}

    /* 완료 화면 */
    #done-screen{min-height:calc(100vh - clamp(56px,7vw,68px));display:none;flex-direction:column;align-items:center;justify-content:center;padding:clamp(20px,3.5vw,44px) 16px;gap:clamp(12px,2.2vw,18px);}
    #done-screen.active{display:flex;}
    .done-anim{width:clamp(76px,11vw,104px);height:clamp(76px,11vw,104px);border-radius:28px;border:2px solid var(--ink);background:var(--moss);box-shadow:var(--shadow);display:flex;align-items:center;justify-content:center;color:#fff;animation:dpop 1s cubic-bezier(.34,1.4,.64,1);}
    .done-anim svg{width:54%;height:54%;}
    @keyframes dpop{from{transform:scale(0) rotate(-30deg);opacity:0;}60%{transform:scale(1.15) rotate(8deg);}to{transform:scale(1) rotate(0);opacity:1;}}
    .done-card{background:var(--paper);border:2px solid var(--ink);border-radius:var(--r-xl);padding:clamp(24px,3.5vw,36px) clamp(20px,3.5vw,32px);width:min(500px,96vw);box-shadow:8px 8px 0 rgba(36,28,18,.14);text-align:center;animation:mpop .4s cubic-bezier(.34,1.4,.64,1);}
    .done-title{font-family:'Black Han Sans';font-size:clamp(22px,3.5vw,34px);font-weight:400;color:var(--ink);margin-bottom:5px;}
    .done-sub{font-size:clamp(13px,1.7vw,16px);font-weight:600;color:var(--ink-soft);line-height:1.65;margin-bottom:clamp(14px,2.2vw,20px);}
    .sess-sum{background:var(--white);border:2px solid var(--ink);border-radius:var(--r-md);padding:clamp(13px,2vw,18px);margin-bottom:clamp(13px,2vw,18px);text-align:left;}
    .ss-title{display:flex;align-items:center;gap:6px;font-size:12px;font-weight:800;color:var(--ink-faint);margin-bottom:8px;letter-spacing:.04em;}
    .ss-row{display:flex;justify-content:space-between;align-items:center;padding:5px 0;border-bottom:1.5px dashed var(--line);}
    .ss-row:last-child{border-bottom:none;}
    .ss-lbl{font-size:12px;font-weight:600;color:var(--ink-soft);}
    .ss-val{display:flex;align-items:center;gap:4px;font-size:13px;font-weight:800;color:var(--ink);}
    .chips-row{display:flex;gap:8px;justify-content:center;margin-bottom:clamp(14px,2.2vw,20px);flex-wrap:wrap;}
    .chip{display:flex;align-items:center;gap:5px;font-size:12px;font-weight:800;padding:6px 14px;border-radius:100px;border:2px solid var(--ink);}
    .chip.ok{background:var(--t-moss);color:var(--moss);}
    .chip.fail{background:var(--t-clay);color:var(--clay);}
    .done-btns{display:flex;flex-direction:column;gap:10px;width:100%;}
    .btn-cont{width:100%;background:var(--persimmon);border:2px solid var(--ink);color:#fff;font-family:inherit;font-size:clamp(14px,1.9vw,17px);font-weight:800;padding:clamp(14px,2vw,17px);border-radius:var(--r-lg);cursor:pointer;transition:all .12s;box-shadow:var(--shadow);display:flex;align-items:center;justify-content:center;gap:8px;}
    .btn-cont:hover{transform:translate(2px,2px);box-shadow:3px 3px 0 var(--ink);}
    .btn-home{width:100%;background:var(--white);border:2px solid var(--ink);color:var(--ink);font-family:inherit;font-size:clamp(13px,1.7vw,15px);font-weight:800;padding:clamp(12px,1.7vw,15px);border-radius:var(--r-lg);cursor:pointer;transition:all .12s;}
    .btn-home:hover{transform:translate(2px,2px);}

    /* ── 번호표 화면 ── */
    #queue-screen{min-height:calc(100vh - clamp(56px,7vw,68px));display:none;flex-direction:column;align-items:center;justify-content:flex-start;padding:clamp(20px,3.5vw,44px) clamp(14px,3vw,28px);gap:clamp(14px,2.5vw,20px);}
    #queue-screen.active{display:flex;}
    .queue-hero{position:relative;width:100%;max-width:500px;background:var(--cobalt);border:2px solid var(--ink);border-radius:var(--r-xl);box-shadow:var(--shadow);padding:clamp(28px,4vw,42px) clamp(20px,3.5vw,36px);text-align:center;color:#fff;overflow:hidden;}
    .queue-hero::before{content:'';position:absolute;left:-13px;top:50%;transform:translateY(-50%);width:26px;height:26px;border-radius:50%;background:var(--paper);border:2px solid var(--ink);}
    .queue-hero::after{content:'';position:absolute;right:-13px;top:50%;transform:translateY(-50%);width:26px;height:26px;border-radius:50%;background:var(--paper);border:2px solid var(--ink);}
    .queue-label{font-size:clamp(12px,1.8vw,15px);font-weight:800;letter-spacing:.18em;opacity:.9;margin-bottom:6px;}
    .queue-number{font-family:'Black Han Sans';font-size:clamp(76px,15vw,120px);font-weight:400;line-height:1;color:var(--butter);animation:numPop .5s cubic-bezier(.34,1.4,.64,1);}
    @keyframes numPop{from{transform:scale(0) rotate(-15deg);opacity:0;}60%{transform:scale(1.12) rotate(5deg);}to{transform:scale(1) rotate(0);opacity:1;}}
    .queue-sub{font-size:clamp(13px,1.8vw,16px);font-weight:700;opacity:.95;margin-top:8px;}
    .queue-date{font-size:clamp(11px,1.4vw,13px);font-weight:600;opacity:.75;margin-top:6px;}
    .waiting-card{width:100%;max-width:500px;background:var(--white);border:2px solid var(--ink);border-radius:var(--r-lg);box-shadow:4px 4px 0 rgba(36,28,18,.12);padding:clamp(16px,2.5vw,22px);}
    .waiting-row{display:flex;align-items:center;justify-content:space-between;padding:10px 0;border-bottom:1.5px dashed var(--line);}
    .waiting-row:last-child{border-bottom:none;}
    .waiting-lbl{display:flex;align-items:center;gap:6px;font-size:clamp(13px,1.7vw,15px);font-weight:700;color:var(--ink-soft);}
    .waiting-val{font-family:'Black Han Sans';font-size:clamp(18px,2.2vw,22px);font-weight:400;color:var(--ink);}
    .waiting-val.big{font-size:clamp(26px,3.5vw,34px);color:var(--cobalt);}
    .queue-msg-box{width:100%;max-width:500px;border:2px solid var(--ink);border-radius:var(--r-lg);padding:clamp(14px,2.2vw,18px) clamp(16px,2.5vw,20px);display:flex;align-items:center;gap:12px;font-size:clamp(13px,1.7vw,15px);font-weight:800;}
    .queue-msg-box.warn{background:var(--t-butter);color:var(--ink);}
    .queue-msg-box.ok{background:var(--t-moss);color:var(--moss);}
    .queue-msg-box.info{background:var(--t-cobalt);color:var(--cobalt);}
    .queue-msg-icon{display:flex;align-items:center;flex-shrink:0;}
    .queue-msg-icon svg{width:24px;height:24px;}
    .btn-queue-draw{width:100%;max-width:500px;background:var(--cobalt);color:#fff;border:2px solid var(--ink);border-radius:var(--r-lg);padding:clamp(16px,2.5vw,20px);font-family:inherit;font-size:clamp(15px,2.2vw,19px);font-weight:800;cursor:pointer;box-shadow:var(--shadow);display:flex;align-items:center;justify-content:center;gap:10px;transition:all .12s;}
    .btn-queue-draw:hover{transform:translate(2px,2px);box-shadow:3px 3px 0 var(--ink);}
    .btn-queue-draw:disabled{opacity:.45;cursor:not-allowed;transform:none;box-shadow:none;}
    .queue-ticket-list{width:100%;max-width:500px;}
    .qtl-title{font-size:13px;font-weight:800;color:var(--ink-faint);margin-bottom:8px;letter-spacing:.04em;}
    .qtl-items{display:flex;flex-wrap:wrap;gap:7px;}
    .qtl-chip{padding:6px 13px;border-radius:100px;font-size:12px;font-weight:800;border:2px solid var(--ink);}
    .qtl-chip.waiting{background:var(--white);color:var(--cobalt);}
    .qtl-chip.called{background:var(--paper-2);color:var(--ink-faint);text-decoration:line-through;}
    .qtl-chip.mine{background:var(--cobalt);color:#fff;}

    /* 스플래시 번호표 버튼 */
    .queue-entry-btn{display:flex;align-items:center;gap:8px;background:var(--white);color:var(--ink);font-size:clamp(13px,1.8vw,16px);font-weight:800;padding:clamp(13px,1.5vw,16px) clamp(20px,3vw,28px);border-radius:var(--r-lg);border:2px solid var(--ink);cursor:pointer;box-shadow:var(--shadow);transition:all .12s;font-family:inherit;}
    .queue-entry-btn:hover{transform:translate(2px,2px);box-shadow:3px 3px 0 var(--ink);}
    .install-btn{display:inline-flex;align-items:center;gap:8px;background:var(--cobalt);color:#fff;font-size:clamp(13px,1.8vw,15px);font-weight:800;padding:clamp(11px,1.4vw,14px) clamp(18px,2.6vw,24px);border-radius:var(--r-lg);border:2px solid var(--ink);cursor:pointer;box-shadow:4px 4px 0 var(--ink);transition:all .12s;font-family:inherit;}
    .install-btn:hover{transform:translate(2px,2px);box-shadow:2px 2px 0 var(--ink);}
    .install-hint{max-width:300px;font-size:12px;font-weight:700;color:var(--ink-soft);line-height:1.5;background:var(--white);border:2px solid var(--ink);border-radius:var(--r-md);padding:10px 14px;}

    /* 피드백 토스트 */
    .fb-toast{position:fixed;bottom:100px;left:50%;transform:translateX(-50%);display:inline-flex;align-items:center;gap:6px;background:var(--ink);color:var(--paper);padding:10px 22px;border:2px solid var(--ink);border-radius:100px;font-size:14px;font-weight:800;z-index:9999;animation:fb-in .25s ease;pointer-events:none;white-space:nowrap;box-shadow:3px 3px 0 rgba(36,28,18,.3);}
    @keyframes fb-in{from{opacity:0;transform:translateX(-50%) translateY(10px);}to{opacity:1;transform:translateX(-50%) translateY(0);}}
    .confetti-p{position:fixed;z-index:9998;pointer-events:none;width:11px;height:11px;border-radius:2px;animation:cfly linear forwards;}
    @keyframes cfly{0%{transform:translateY(0) rotate(0) scale(1);opacity:1;}100%{transform:translateY(-60vh) rotate(720deg) scale(.4);opacity:0;}}
    .fade-up{animation:fadeUp .3s ease;}
    @keyframes fadeUp{from{opacity:0;transform:translateY(12px);}to{opacity:1;transform:translateY(0);}}
    .spinner{width:17px;height:17px;border:2.5px solid rgba(255,255,255,.35);border-top-color:#fff;border-radius:50%;animation:spin .65s linear infinite;}
    @keyframes spin{to{transform:rotate(360deg);}}
    ::-webkit-scrollbar{width:5px;height:5px;}
    ::-webkit-scrollbar-thumb{background:var(--ink-faint);border-radius:3px;}
    @media(max-width:480px){.student-grid{grid-template-columns:repeat(3,1fr);}.menu-grid{grid-template-columns:repeat(2,1fr);}.stat-chip{font-size:10px;}}
    @media(min-width:481px) and (max-width:768px){.student-grid{grid-template-columns:repeat(4,1fr);}.menu-grid{grid-template-columns:repeat(3,1fr);}}
    @media(min-width:769px){.student-grid{grid-template-columns:repeat(5,1fr);}.menu-grid{grid-template-columns:repeat(4,1fr);}}
    @media(min-width:1200px){.menu-grid{grid-template-columns:repeat(5,1fr);}}
  </style>

</head>

<body>

<header class="hdr">

  <div class="hdr-logo">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6Z"/><path d="M10.5 19a1.5 1.5 0 0 0 3 0"/></svg>
    <span class="hdr-wordmark">띵똥</span>
  </div>

  <div class="hdr-r">

    <button id="homeBtn" class="home-btn" onclick="goTo('splash')" style="display:none"><span data-ic="home" data-sz="15"></span> 홈</button>

    <div class="clock" id="clock"><span data-ic="clock" data-sz="14"></span><span id="clockTxt">--:--:--</span></div>

  </div>

</header>



<!-- 스플래시 -->

<div id="splash" onclick="goTo('student')">

  <div class="sp-logo">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6Z"/><path d="M10.5 19a1.5 1.5 0 0 0 3 0"/></svg>
  </div>

  <div class="sp-kicker">바꿈수학 초등 전용</div>

  <div class="sp-title">띵똥</div>

  <div class="sp-desc">잘하면 띵똥! 포인트가 쌓여요</div>

  <div class="sp-badge" id="spBadge"><span id="spSym"></span><span id="spDesc">포인트를 모아 간식과 바꿔요</span></div>

  <button class="tap-btn"><span data-ic="tap" data-sz="24" data-color="#fff"></span>화면을 눌러 시작</button>

  <button class="queue-entry-btn" onclick="event.stopPropagation();goToQueue()" id="queueEntryBtn"><span data-ic="ticket" data-sz="20"></span>번호표 뽑기</button>

  <button class="install-btn" id="installBtn" style="display:none" onclick="event.stopPropagation();installApp()"><span data-ic="plus" data-sz="18"></span>앱으로 설치하기</button>

  <div class="sp-footer"><span style="letter-spacing:.12em">제작자</span> 이지현 선생님</div>

</div>



<!-- 학생 선택 -->

<div class="screen" id="student-screen">

  <div style="padding:clamp(14px,2vw,24px) clamp(14px,3vw,28px);">

    <div class="page-top">

      <button class="back-btn" onclick="goTo('splash')"><span data-ic="back" data-sz="20"></span></button>

      <div>

        <div class="page-title">누구세요?</div>

        <div class="page-sub">내 이름을 찾아서 터치해요!</div>

      </div>

    </div>

    <div class="search-wrap">

      <span class="search-ic" data-ic="search" data-sz="18"></span>

      <input class="search-inp" id="searchInp" type="text" placeholder="이름 검색..."

             oninput="filterStudents(this.value)" autocomplete="off" spellcheck="false"/>

    </div>

    <div class="student-grid" id="studentGrid"></div>

  </div>

</div>



<!-- 메뉴 -->

<div class="screen" id="menu-screen">

  <div style="padding:clamp(12px,1.8vw,20px) clamp(14px,3vw,28px) 110px;">

    <div class="stu-banner">

      <div id="bannerAv"></div>

      <div class="stu-banner-info">

        <div class="stu-banner-name" id="bannerName"></div>

        <div class="stu-banner-stats" id="bannerStats"></div>

      </div>

      <div style="display:flex;gap:6px;flex-shrink:0;">

        <button class="btn-change" onclick="goTo('student')"><span data-ic="back" data-sz="14"></span>변경</button>

      </div>

    </div>

    <!-- 수학 전광판 칩 (수학 듣는 학생에게만 표시 · 쏘이지 점수 읽기) -->
    <div id="mathChipRow" style="display:none;margin-bottom:clamp(10px,1.4vw,14px);">
      <button id="mathBoardChip" onclick="openMathBoard()" style="display:inline-flex;align-items:center;gap:8px;background:#FCEBC9;color:#9A6B12;border:2px solid var(--ink);border-radius:100px;padding:clamp(8px,1.1vw,11px) clamp(15px,1.9vw,20px);font-size:clamp(14px,1.7vw,16px);font-weight:800;cursor:pointer;box-shadow:var(--shadow);transition:transform .12s ease;">
        <span style="font-size:1.15em;line-height:1;">⚾</span> 수학 전광판
      </button>
    </div>

    <div class="tab-row" id="tabRow">

      <button class="tab-btn active-shop" onclick="switchTab('shop')" id="tab-shop"><div class="tab-dot"></div>보상 상점</button>

    </div>

    <!-- 상점 잠금해제 배지 (해제 중 남은 시간) -->
    <div id="shop-unlock-badge" style="display:none;text-align:center;font-size:13px;font-weight:800;color:var(--moss);background:var(--t-moss);border:2px solid var(--ink);border-radius:100px;padding:5px 14px;margin-bottom:8px;"></div>

    <div style="position:relative;">

      <div class="menu-grid" id="menuGrid"></div>

      <!-- 상점 잠금 오버레이 -->
      <div id="shop-lock-overlay" style="display:none;position:absolute;inset:0;z-index:20;background:rgba(36,28,18,.6);border-radius:18px;flex-direction:column;align-items:center;justify-content:center;gap:14px;padding:32px;">
        <div style="width:72px;height:72px;border-radius:20px;border:2px solid #fff;background:rgba(255,255,255,.12);display:flex;align-items:center;justify-content:center;color:#fff;"><span data-ic="lock" data-sz="38" data-color="#fff"></span></div>
        <div style="color:white;font-size:18px;font-weight:800;text-align:center;">지금은 상점을 이용할 수 없어요</div>
        <div id="shopLockMsg" style="color:rgba(255,255,255,.8);font-size:14px;font-weight:700;text-align:center;">수업 중입니다</div>
        <div style="color:rgba(255,255,255,.65);font-size:12px;text-align:center;font-weight:600;">선생님께 승인 요청을 보내면<br/>잠시 주문이 가능해요!</div>
        <button id="shopUnlockReqBtn" onclick="requestShopUnlock()" style="margin-top:8px;padding:14px 26px;background:var(--persimmon);color:#fff;border:2px solid var(--ink);border-radius:14px;font-size:15px;font-weight:800;cursor:pointer;box-shadow:4px 4px 0 var(--ink);display:flex;align-items:center;gap:8px;">
          <span data-ic="consult" data-sz="18" data-color="#fff"></span>선생님께 상점 열기 요청
        </button>
        <div id="shopUnlockReqStatus" style="color:rgba(255,255,255,.85);font-size:13px;min-height:20px;text-align:center;font-weight:700;"></div>
      </div>

    </div>

  </div>

</div>



<!-- 완료 -->

<div id="done-screen">

  <div class="done-anim" id="doneEmoji"><span data-ic="check" data-sz="48" data-color="#fff"></span></div>

  <div class="done-card">

    <div class="done-title" id="doneTitle">기록 완료!</div>

    <div class="done-sub" id="doneSub"></div>

    <div class="sess-sum" id="sessSum"></div>

    <div class="chips-row" id="doneChips"></div>

    <div class="done-btns">

      <button class="btn-cont" onclick="continueOrder()"><span data-ic="plus" data-sz="18"></span><span id="btnContLbl">계속 담기</span></button>

      <button class="btn-home" onclick="goTo('splash')"><span data-ic="home" data-sz="16" style="margin-right:6px;display:inline-block;vertical-align:-3px"></span>처음으로</button>

    </div>

  </div>

</div>



<!-- 번호표 화면 -->

<div class="screen" id="queue-screen">

  <!-- 학생 선택 단계 -->

  <div id="queue-step-select" style="width:100%;max-width:500px;display:none;">

    <div style="text-align:center;margin-bottom:clamp(16px,2.5vw,24px);">

      <div style="font-family:'Black Han Sans';font-size:clamp(24px,3.8vw,32px);color:var(--ink);">번호표 뽑기</div>

      <div style="font-size:clamp(13px,1.7vw,15px);font-weight:600;color:var(--ink-soft);margin-top:6px;">이름을 선택하면 번호가 발급돼요!</div>

    </div>

    <!-- 상단: 현재 대기 인원 · 호출 순번 (실시간) -->
    <div style="display:flex;gap:10px;margin-bottom:clamp(14px,2vw,20px);">
      <div style="flex:1;background:var(--cobalt);color:#fff;border:2px solid var(--ink);border-radius:16px;box-shadow:var(--shadow);padding:clamp(12px,1.8vw,16px);text-align:center;">
        <div style="font-size:clamp(11px,1.5vw,13px);font-weight:800;opacity:.9;">현재 대기 인원</div>
        <div style="font-family:'Black Han Sans';font-size:clamp(30px,5.5vw,44px);line-height:1.15;margin-top:2px;"><span id="qSelWaiting">-</span><span style="font-size:.45em;font-family:Pretendard;font-weight:800;"> 명</span></div>
      </div>
      <div style="flex:1;background:var(--butter);color:var(--ink);border:2px solid var(--ink);border-radius:16px;box-shadow:var(--shadow);padding:clamp(12px,1.8vw,16px);text-align:center;">
        <div style="font-size:clamp(11px,1.5vw,13px);font-weight:800;opacity:.8;">지금 호출 순번</div>
        <div style="font-family:'Black Han Sans';font-size:clamp(30px,5.5vw,44px);line-height:1.15;margin-top:2px;"><span id="qSelNow">-</span><span style="font-size:.45em;font-family:Pretendard;font-weight:800;"> 번</span></div>
      </div>
    </div>

    <div style="font-size:clamp(13px,1.7vw,15px);font-weight:800;color:var(--ink);margin-bottom:8px;">번호표 뽑을 학생을 선택하세요</div>

    <div class="search-wrap">

      <span class="search-ic" data-ic="search" data-sz="18"></span>

      <input class="search-inp" id="queueSearchInp" type="text" placeholder="이름 검색..."

             oninput="filterQueueStudents(this.value)" autocomplete="off" spellcheck="false"/>

    </div>

    <div class="student-grid" id="queueStudentGrid"></div>

    <div style="margin-top:16px;text-align:center;">

      <button class="home-btn" onclick="goTo('splash')" style="margin:0 auto;"><span data-ic="back" data-sz="14" style="margin-right:4px;display:inline-block;vertical-align:-2px"></span>돌아가기</button>

    </div>

  </div>



  <!-- 번호표 결과 단계 -->

  <div id="queue-step-result" style="width:100%;display:flex;flex-direction:column;align-items:center;gap:clamp(14px,2.2vw,20px);display:none;">

    <!-- 번호 카드 -->

    <div class="queue-hero">

      <div class="queue-label">내 번호표</div>

      <div class="queue-number" id="queueNumber">--</div>

      <div class="queue-sub" id="queueStuName"></div>

      <div class="queue-date" id="queueDate"></div>

    </div>



    <!-- 대기 현황 -->

    <div class="waiting-card">

      <div class="waiting-row">

        <div class="waiting-lbl"><span data-ic="clock" data-sz="16" data-color="#11998A" style="margin-right:6px;display:inline-block;vertical-align:-3px"></span>내 앞 대기</div>

        <div class="waiting-val big" id="queueWaiting">--</div>

      </div>

      <div class="waiting-row">

        <div class="waiting-lbl"><span data-ic="users" data-sz="16" data-color="#8A7A5C" style="margin-right:6px;display:inline-block;vertical-align:-3px"></span>오늘 총 발급</div>

        <div class="waiting-val" id="queueTotal">--</div>

      </div>

    </div>



    <!-- 메시지 박스 -->

    <div class="queue-msg-box info" id="queueMsgBox">

      <div class="queue-msg-icon"><span data-ic="ticket" data-sz="24"></span></div>

      <div id="queueMsgText">번호를 기억해두세요!</div>

    </div>



    <!-- 오늘의 번호표 목록 -->

    <div class="queue-ticket-list" id="queueTicketList"></div>



    <!-- 버튼 -->

    <div style="display:flex;flex-direction:column;gap:9px;width:100%;max-width:500px;">

      <button class="btn-cont" onclick="goTo('student')" style="background:var(--cobalt);"><span data-ic="check" data-sz="18"></span>띵똥 이용하기</button>

      <button class="btn-home" onclick="goTo('splash')"><span data-ic="home" data-sz="16" style="margin-right:6px;display:inline-block;vertical-align:-3px"></span>처음으로</button>

    </div>

  </div>

</div>



<!-- 내 상태 모달 -->

<div class="modal-ov" id="my-status-modal">

  <div class="modal-box" style="max-width:400px;">

    <div class="modal-title"><span data-ic="record" data-sz="22"></span>내 현재 상태</div>

    <div id="myStatusContent" style="margin:12px 0;"></div>

    <div class="modal-btns">

      <button class="btn-mok" style="flex:1;" onclick="closeMyStatus()"><span data-ic="check" data-sz="18"></span>확인</button>

    </div>

  </div>

</div>



<!-- 장바구니 바 -->

<div class="cart-bar" id="cartBar">

  <div style="display:flex;align-items:center;gap:10px;">

    <div class="cart-ic"><span data-ic="cart" data-sz="24"></span><div class="cart-badge" id="cartBadge">0</div></div>

    <div>

      <div class="cart-cnt" id="cartCnt">0개 담음</div>

      <div class="cart-preview" id="cartPreview"></div>

    </div>

  </div>

  <div class="cart-btns">

    <button class="btn-cc" onclick="clearCart()"><span data-ic="trash" data-sz="17"></span></button>

    <button class="btn-cs" onclick="openConfirm()"><span data-ic="send" data-sz="17"></span>제출하기</button>

  </div>

</div>



<!-- 사진 인증 모달 -->

<div class="modal-ov" id="photo-modal">

  <div class="modal-box">

    <div class="modal-title"><span data-ic="camera" data-sz="22"></span>사진으로 인증해요!</div>

    <div class="modal-sub" id="photoSub"></div>

    <div class="photo-zone" onclick="triggerPhoto()">

      <input type="file" id="photoInput" accept="image/*" capture="environment" onchange="onPhoto(event)"/>

      <img class="photo-prev" id="photoPrev" alt=""/>

      <div class="photo-ph" id="photoPh"><div class="ph-badge"><span data-ic="camera" data-sz="26"></span></div><p>사진을 찍거나 갤러리에서 선택!</p><span>카메라 또는 앨범</span></div>

    </div>

    <textarea id="photoComment" placeholder="선생님께 한마디 남겨도 좋아요 (선택)" style="width:100%;min-height:70px;border:2px solid var(--g200);border-radius:var(--r-md);padding:10px 12px;font-family:inherit;font-size:14px;outline:none;resize:none;margin-bottom:4px;transition:border-color .2s;" onfocus="this.style.borderColor='var(--blue)'" onblur="this.style.borderColor='var(--g200)'"></textarea>

    <div class="modal-btns">

      <button class="btn-mc" onclick="closePhotoModal()">취소</button>

      <button class="btn-mok" id="photoOk" onclick="confirmPhoto()" disabled><span data-ic="check" data-sz="18"></span>인증 완료</button>

    </div>

  </div>

</div>



<!-- 확인 모달 -->

<div class="modal-ov" id="confirm-modal">

  <div class="modal-box">

    <div class="modal-title" style="margin-bottom:13px"><span data-ic="check" data-sz="22"></span>제출 확인</div>

    <div class="confirm-stu-row">

      <div id="confirmAv"></div>

      <div><div class="confirm-sn" id="confirmSn"></div><div style="font-size:11px;color:var(--g400)">학생</div></div>

    </div>

    <div class="order-list" id="orderList"></div>

    <div class="total-row"><div class="total-lbl">총 합계</div><div class="total-val" id="totalVal"></div></div>

    <div class="modal-btns">

      <button class="btn-mc" onclick="closeConfirm()"><span data-ic="close" data-sz="15" style="margin-right:4px;display:inline-block;vertical-align:-2px"></span>취소</button>

      <button class="btn-mok" id="confirmOk" onclick="doSubmit()"><span data-ic="send" data-sz="17"></span><span id="confirmTxt">제출하기</span></button>

    </div>

  </div>

</div>



<!-- 포인트 부족 → 대출 모달 -->
<div class="modal-ov" id="loan-modal">
  <div class="modal-box">
    <div class="modal-title" style="margin-bottom:13px"><span data-ic="star" data-sz="22"></span>포인트가 부족해요</div>
    <div id="loanBody" style="font-size:15px;line-height:1.7;color:var(--ink);margin-bottom:10px"></div>
    <div style="font-size:12px;color:var(--g400);line-height:1.6;margin-bottom:14px">대출하면 부족한 포인트를 빌리고, 그만큼 <b>오늘 추가 보충수업</b>을 해야 해요.<br>10포인트 = 1분 · 미상환 최대 3건까지</div>
    <div class="modal-btns">
      <button class="btn-mc" onclick="closeLoan()"><span data-ic="close" data-sz="15" style="margin-right:4px;display:inline-block;vertical-align:-2px"></span>취소</button>
      <button class="btn-mok" id="loanOk" onclick="doLoan()"><span data-ic="star" data-sz="17"></span><span id="loanTxt">대출하고 주문하기</span></button>
    </div>
  </div>
</div>



<script>

(function(){

const CFG_VER='2025-v3'

let CFG={currency:{unit:'포인트',symbol:'star',desc:''},menu:{learn:[],fine:[],shop:[]}}

let STUDENTS=[]

let ST={student:null,tab:'learn',cart:[],pendingItem:null,photoB64:null,submitting:false,sessionBalance:0,sessionOrders:[]}

let autoTimer=null



// 커스텀 SVG 아이콘 (이모지 전면 교체)
const ICONS = {
  bell:'<path d="M6 9a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6Z"/><path d="M10.5 19a1.5 1.5 0 0 0 3 0"/>',
  star:'FILL:<path d="M12 3.3l2.5 5.1 5.6.8-4 3.9 1 5.6-5-2.6-5 2.6 1-5.6-4-3.9 5.6-.8z"/>',
  search:'<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.2-4.2"/>',
  home:'<path d="M3.5 11 12 4l8.5 7"/><path d="M5.5 9.7V19h13V9.7"/>',
  back:'<path d="M15 6l-6 6 6 6"/>',
  clock:'<circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/>',
  plus:'<path d="M12 5v14M5 12h14"/>',
  check:'<path d="M5 12l5 5 9-11"/>',
  cart:'<circle cx="9.5" cy="20" r="1.4"/><circle cx="17" cy="20" r="1.4"/><path d="M3 4h2l2.4 11.5h10l2-7.5H6.2"/>',
  camera:'<path d="M4 8h3l2-2h6l2 2h3v11H4z"/><circle cx="12" cy="13" r="3.4"/>',
  ticket:'<path d="M4 7.5h16v3a2 2 0 0 0 0 3.5v3H4v-3a2 2 0 0 0 0-3.5z"/><path d="M14 7.5v9"/>',
  tap:'<path d="M9 11V6a1.6 1.6 0 0 1 3.2 0v5"/><path d="M12.2 11V8.5a1.6 1.6 0 0 1 3.2 0V11"/><path d="M15.4 11v-1a1.6 1.6 0 0 1 3.2 0v4.5a5.5 5.5 0 0 1-5.5 5.5h-1.4a5 5 0 0 1-3.6-1.6L5 16.4a1.6 1.6 0 0 1 2.4-2L9 16V8.5a1.6 1.6 0 0 1 3.2 0"/>',
  lock:'<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  users:'<circle cx="9" cy="9" r="3.2"/><path d="M3.5 19a5.5 5.5 0 0 1 11 0"/><path d="M16 6.2a3.2 3.2 0 0 1 0 6.1M20.5 19a5.5 5.5 0 0 0-4-5.3"/>',
  warn:'<path d="M12 4l8.5 15h-17z"/><path d="M12 10v4M12 17h.01"/>',
  // 학습 인증
  study:'<path d="M12 6c-2-1.3-5-1.3-7.5 0v12c2.5-1.3 5.5-1.3 7.5 0 2-1.3 5-1.3 7.5 0V6C17 4.7 14 4.7 12 6Z"/><path d="M12 6v12"/>',
  homework:'<path d="M4 20l4.5-1L18 9.5 14.5 6 5 15.5z"/><path d="M13.5 7l3.5 3.5"/>',
  question:'<path d="M5 5h14v10H10l-4 4z"/><path d="M12 8v3"/><circle cx="12" cy="12.6" r=".4" fill="currentColor" stroke="none"/>',
  record:'<rect x="6" y="4" width="12" height="17" rx="2"/><path d="M9 4.5h6V7H9z"/><path d="M9 11h6M9 15h4"/>',
  material:'<path d="M7 3h7l4 4v14H7z"/><path d="M14 3v4h4"/><path d="M10 13h5M10 16.5h5"/>',
  makeup:'<rect x="4" y="5" width="16" height="16" rx="2.5"/><path d="M4 9.5h16M9 3v4M15 3v4"/>',
  consult:'<path d="M4 5h16v11H10l-4 4V5Z"/><path d="M8 9h8M8 12h5"/>',
  // 벌점
  help:'<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/><path d="M6.3 6.3 9 9M17.7 6.3 15 9M6.3 17.7 9 15M17.7 17.7 15 15"/>',
  lostwork:'<path d="M12 4l8.5 15h-17z"/><path d="M12 10v4M12 17h.01"/>',
  nohomework:'<circle cx="12" cy="12" r="8"/><path d="M6.5 6.5l11 11"/>',
  // 벌점 단위
  finepoint:'<circle cx="12" cy="12" r="8"/><path d="M9.5 9h3.2a1.8 1.8 0 0 1 0 3.6H9.5V9zM9.5 12.6V16M9.5 9V7.5M12.5 16v1.5"/>',
  sheet:'<path d="M7 3h7l4 4v14H7z"/><path d="M14 3v4h4"/><path d="M10 13h5M10 16.5h5"/>',
  // 상점
  choco:'<rect x="5" y="4" width="14" height="16" rx="2"/><path d="M5 9h14M5 14h14M12 4v16"/>',
  jelly:'<path d="M5 18a7 7 0 0 1 14 0z"/><path d="M5 18h14"/>',
  candy:'<circle cx="12" cy="9" r="5"/><path d="M12 14v6"/>',
  snack:'<circle cx="12" cy="12" r="8"/><circle cx="9.5" cy="10" r=".9" fill="currentColor" stroke="none"/><circle cx="14" cy="9.5" r=".9" fill="currentColor" stroke="none"/><circle cx="13" cy="14" r=".9" fill="currentColor" stroke="none"/>',
  saekkomdal:'<ellipse cx="12" cy="12" rx="8" ry="6"/><path d="M12 6v12M6.5 9h11M6.5 15h11"/>',
  vitaminc:'<rect x="4" y="9" width="16" height="6" rx="3"/><path d="M12 9v6"/>',
  send:'<path d="M4 12 20 4l-5 16-3.5-6.5z"/><path d="M11.5 13.5 20 4"/>',
  close:'<path d="M6 6l12 12M18 6 6 18"/>',
  image:'<rect x="4" y="5" width="16" height="14" rx="2.5"/><circle cx="9" cy="10" r="1.6"/><path d="M5 17l4.5-4 3 2.6L16 11l3 3.5"/>',
  trash:'<path d="M5 7h14M9 7V5h6v2M7 7l1 13h8l1-13"/>'
};

// 기존 DB에 저장된 이모지 설정 호환 (이모지 → 아이콘 키)
const EMOJI_ALIAS = {'🏅':'star','📖':'study','✏️':'homework','✏':'homework','🙋':'question','📝':'record','📄':'material','📅':'makeup','💬':'consult','🆘':'help','😰':'lostwork','🚫':'nohomework','🍫':'choco','🍬':'jelly','🍭':'candy','🍿':'snack','🍋':'saekkomdal','💊':'vitaminc'};
function icon(name, size, color){
  size = size || 24; color = color || 'currentColor';
  if(name && !ICONS[name] && EMOJI_ALIAS[name]) name = EMOJI_ALIAS[name];
  let p = ICONS[name] || '', fill='none', stroke=color, sw='2';
  if(p.indexOf('FILL:')===0){ p=p.slice(5); fill=color; stroke='none'; }
  return '<svg viewBox="0 0 24 24" width="'+size+'" height="'+size+'" fill="'+fill+'" stroke="'+stroke+'" stroke-width="'+sw+'" stroke-linecap="round" stroke-linejoin="round" style="display:block;flex:none">'+p+'</svg>';
}

// 포인트 상징 마커 (currency.symbol='star' → 버터색 별, 레거시 텍스트는 그대로)
function symMark(sz){
  sz = sz || 14;
  var s = (CFG.currency && CFG.currency.symbol) || 'star';
  if(EMOJI_ALIAS[s]) s = EMOJI_ALIAS[s];
  return ICONS[s] ? icon(s, sz, '#F4B62B') : icon('star', sz, '#F4B62B');
}

// 메뉴 아이템의 유효한 아이콘 키 결정 (이모지/커스텀 텍스트 → 키, 없으면 탭 기본값)
function menuKey(m, tab){
  var k = m && m.icon;
  if(ICONS[k]) return k;
  if(EMOJI_ALIAS[k]) return EMOJI_ALIAS[k];
  return tab==='shop' ? 'snack' : tab==='fine' ? 'nohomework' : 'study';
}

// [data-ic] 스팬을 SVG로 치환 (정적 마크업 아이콘 주입)
function hydrateIcons(root){
  (root||document).querySelectorAll('[data-ic]').forEach(function(el){
    if(el.dataset.icDone) return;
    el.innerHTML = icon(el.dataset.ic, parseInt(el.dataset.sz||'20',10), el.dataset.color||'currentColor');
    el.dataset.icDone='1';
  });
}



// 시계

setInterval(()=>{const n=new Date();document.getElementById('clockTxt').textContent=[n.getHours(),n.getMinutes(),n.getSeconds()].map(x=>String(x).padStart(2,'0')).join(':')},1000)



// ── PWA: 앱 설치 (홈 화면에 추가) ──
if('serviceWorker' in navigator){
  window.addEventListener('load',function(){navigator.serviceWorker.register('/sw.js').catch(function(){})})
}
let deferredPrompt=null;
const isStandalone=window.matchMedia('(display-mode: standalone)').matches||navigator.standalone===true;
window.addEventListener('beforeinstallprompt',function(e){
  e.preventDefault();deferredPrompt=e;
  const b=document.getElementById('installBtn');if(b&&!isStandalone)b.style.display='inline-flex';
});
window.addEventListener('appinstalled',function(){
  deferredPrompt=null;const b=document.getElementById('installBtn');if(b)b.style.display='none';
});
window.installApp=async function(){
  if(deferredPrompt){
    deferredPrompt.prompt();
    try{await deferredPrompt.userChoice;}catch(_){}
    deferredPrompt=null;
    const b=document.getElementById('installBtn');if(b)b.style.display='none';
    return;
  }
  // iOS Safari 등 beforeinstallprompt 미지원: 안내 표시
  const ua=navigator.userAgent;
  const isIOS=/iphone|ipad|ipod/i.test(ua);
  const msg=isIOS
    ? '사파리 하단의 공유 버튼을 누른 뒤 "홈 화면에 추가"를 선택하세요.'
    : '브라우저 메뉴에서 "홈 화면에 추가" 또는 "앱 설치"를 선택하세요.';
  toast(msg);
};
// iOS는 beforeinstallprompt가 없으므로, 설치 전이면 버튼을 안내용으로 노출
window.addEventListener('load',function(){
  const ua=navigator.userAgent;const isIOS=/iphone|ipad|ipod/i.test(ua);
  const b=document.getElementById('installBtn');
  if(b&&isIOS&&!isStandalone)b.style.display='inline-flex';
});



// 화면 전환

const SCRS=['splash','student-screen','menu-screen','done-screen','queue-screen']

function goTo(id){

  clearTimeout(autoTimer)

  SCRS.forEach(s=>document.getElementById(s).classList.remove('active'))

  const MAP={splash:'splash',student:'student-screen',menu:'menu-screen',done:'done-screen',queue:'queue-screen'}

  const el=document.getElementById(MAP[id]);if(!el)return

  el.classList.add('active','fade-up');setTimeout(()=>el.classList.remove('fade-up'),350)

  document.getElementById('cartBar').classList.toggle('visible',id==='menu')

  // 홈버튼: splash 제외 모든 화면에서 표시

  const homeBtn=document.getElementById('homeBtn')

  if(homeBtn) homeBtn.style.display=(id==='splash')?'none':'flex'

  if(id==='student'){document.getElementById('searchInp').value='';filterStudents('')}

  if(id==='splash'){ST.cart=[];ST.student=null;ST.sessionBalance=0;ST.sessionOrders=[];updateCartBar()}

  // 수학 전광판: 메뉴 화면에서만 칩 노출 확인을 유지, 벗어나면 모달/폴링 정리
  if(id==='menu'){ startChipPoll() } else { stopChipPoll(); if(typeof closeMathBoard==='function') closeMathBoard() }

  // 번호표 선택화면 벗어나면 상단 상태 폴링 정리
  if(id!=='queue' && typeof stopQueueSelPoll==='function') stopQueueSelPoll()

}

window.goTo=goTo



// 내 상태 모달

window.openMyStatus=function(){

  const s=ST.student;if(!s){toast('학생을 먼저 선택해주세요');return}

  const c=CFG.currency

  let html='<div style="display:flex;flex-direction:column;gap:12px;">'

  // 포인트

  html+='<div style="background:var(--t-butter);border:2px solid var(--ink);border-radius:14px;padding:14px 16px;display:flex;align-items:center;gap:12px;">'

  html+='<div style="width:46px;height:46px;flex:none;border:2px solid var(--ink);border-radius:12px;background:#fff;display:flex;align-items:center;justify-content:center;">'+symMark(24)+'</div>'

  html+='<div><div style="font-size:12px;color:var(--ink-soft);font-weight:800;">내 포인트</div>'

  html+='<div class="bhs" style="font-size:26px;color:var(--ink);">'+s.points+' <span style="font-size:13px;font-family:Pretendard;font-weight:700;">'+c.unit+'</span></div></div>'

  html+='</div>'

  html+='</div>'

  document.getElementById('myStatusContent').innerHTML=html

  document.getElementById('my-status-modal').classList.add('open')

}

window.closeMyStatus=function(){

  document.getElementById('my-status-modal').classList.remove('open')

}



// 초기 로드

// ══ 키오스크 음성 방송 (관리자 호출/방송 → 음성 출력) ══
var _ttsReady=false, _ttsVoices=[]
function ttsLoadVoices(){ try{ _ttsVoices=window.speechSynthesis.getVoices()||[] }catch(e){} }
function ttsUnlock(){
  if(_ttsReady)return
  try{
    if(!('speechSynthesis' in window))return
    ttsLoadVoices()
    var u=new SpeechSynthesisUtterance(' ');u.volume=0
    window.speechSynthesis.speak(u)
    _ttsReady=true
  }catch(e){}
}
function speak(text){
  try{
    if(!('speechSynthesis' in window)||!text)return
    if(!_ttsVoices.length) ttsLoadVoices()
    var u=new SpeechSynthesisUtterance(String(text))
    u.lang='ko-KR';u.rate=0.95;u.pitch=1;u.volume=1
    for(var i=0;i<_ttsVoices.length;i++){ if(/ko/i.test(_ttsVoices[i].lang)){u.voice=_ttsVoices[i];break} }
    window.speechSynthesis.speak(u)
  }catch(e){}
}
if('speechSynthesis' in window){ try{ window.speechSynthesis.onvoiceschanged=ttsLoadVoices }catch(e){} }
// 첫 사용자 터치/클릭에 오디오 unlock (키오스크 자동재생 정책 대응)
;['touchstart','click','keydown'].forEach(function(ev){ document.addEventListener(ev, ttsUnlock, {passive:true}) })

// 칠판 표시 (kind: 'call'=번호표 호출-잠깐, 'board'=칠판-유지)
var annPopupTimer=null
function showAnnBoard(text,kind){
  var ov=document.getElementById('annPopup'), t=document.getElementById('annPopupText'), lb=document.getElementById('annPopupLabel')
  if(!ov||!t)return
  t.textContent=text
  if(lb) lb.textContent=(kind==='call'?'번호표 호출':'선생님 칠판')
  ov.style.display='flex'
  var card=document.getElementById('annPopupCard')
  if(card){ card.style.transform='scale(.94)'; requestAnimationFrame(function(){ card.style.transform='scale(1)' }) }
  if(annPopupTimer){ clearTimeout(annPopupTimer); annPopupTimer=null }
  if(kind==='call'){ annPopupTimer=setTimeout(function(){ ov.style.display='none' }, 7000) } // 호출은 잠깐, 칠판은 유지
}
window.closeAnnPopup=function(){ var ov=document.getElementById('annPopup'); if(ov)ov.style.display='none'; if(annPopupTimer){clearTimeout(annPopupTimer);annPopupTimer=null} }

// 방송 폴링: 마지막으로 읽은 id 이후 새 문구만 음성 출력 (중복 방지)
var ANN_KEY='ddingdong_ann_lastid'
var annLastId=null
var annBusy=false        // 폴 중복 실행 차단(겹침 방지)
var annSpoken={}         // 이미 읽은 id (한 번만 재생)
function annInit(){ var s=localStorage.getItem(ANN_KEY); annLastId=(s===null||s==='')?null:(parseInt(s)||0) }
function pollAnnounce(){
  if(annBusy)return
  annBusy=true
  var url='/api/announce/poll'+(annLastId!==null?('?since='+annLastId):'?since=init')
  fetch(url).then(function(r){return r.json()}).then(function(d){
    if(!d||!d.success)return
    if(annLastId===null){ // 첫 폴: 백로그 스킵 + 현재 칠판 복원(무음)
      annLastId=d.maxId||0; localStorage.setItem(ANN_KEY,String(annLastId))
      if(d.board) showAnnBoard(d.board,'board')
      return
    }
    var items=d.items||[], lastShow=null
    for(var i=0;i<items.length;i++){
      var it=items[i]
      if(annSpoken[it.id])continue   // 이미 처리한 것 → 스킵 (2번 재생 방지)
      annSpoken[it.id]=true
      if(it.kind==='clear'){ closeAnnPopup(); lastShow=null; continue }   // 칠판 지우기
      if(it.kind==='call') speak(it.text)   // 번호표 호출만 키오스크 음성. 칠판(board)은 관리자 기기에서 음성.
      lastShow=it
    }
    if(lastShow) showAnnBoard(lastShow.text, lastShow.kind||'call')
    if(d.maxId!=null && d.maxId>annLastId){ annLastId=d.maxId; localStorage.setItem(ANN_KEY,String(annLastId)) }
  }).catch(function(){}).then(function(){ annBusy=false })
}

async function init(){

  try{

    // 항상 서버(DB)에서 최신 설정 불러오기 (관리자 변경 즉시 반영)
    const r=await fetch('/api/config');const d=await r.json()

    CFG=d

    // localStorage는 더 이상 사용하지 않음 (삭제하여 혼동 방지)
    localStorage.removeItem('kiosk_config');localStorage.removeItem('kiosk_cfg_ver')

  }catch(e){}

  applyCurrencyUI()

  await loadStudents()

  hydrateIcons()

  goTo('splash')

  // 음성 방송 폴링 시작 (화면과 무관하게 항상 동작)
  annInit(); pollAnnounce(); setInterval(pollAnnounce, 3500)

}



async function loadStudents(){

  try{

    const r=await fetch('/api/students');const d=await r.json()

    if(d.success){STUDENTS=d.students;renderStudents()}

  }catch(e){}

}



function applyCurrencyUI(){

  const c=CFG.currency || {unit:'포인트', symbol:'star', desc:''}

  document.getElementById('spSym').innerHTML=symMark(18)

  document.getElementById('spDesc').textContent=c.desc||(c.unit+' 모으기!')

}



// 학생 그리드

function renderStudents(){

  const g=document.getElementById('studentGrid')

  g.innerHTML=STUDENTS.map((s,i)=>{

    const photoEl=s.photo_url

      ?'<img class="stu-photo" src="'+escHtml(s.photo_url)+'" alt="'+escHtml(s.name)+'"/>'

      :'<div class="stu-av" style="'+avatarStyle(i)+'">'+escHtml(s.name[0])+'</div>'

    return '<button class="stu-btn" data-name="'+escHtml(s.name)+'" onclick="selectStudent('+s.id+')">'+

      photoEl+

      '<div class="stu-name">'+escHtml(s.name)+'</div>'+

      '<div class="stu-pts">'+symMark(13)+' '+s.points+'P</div>'+

    '</button>'

  }).join('')

}



function escHtml(s){var r=String(s);r=r.split('&').join('&amp;');r=r.split('<').join('&lt;');r=r.split('>').join('&gt;');r=r.split(String.fromCharCode(34)).join('&#34;');return r}

// 아바타 액센트 6색 순환 (버터일 때만 글자 잉크색)
var AV_COLORS=['#11998A','#F2724B','#4C8A3A','#F4B62B','#7A5CD0','#C0473A'];
function avatarStyle(i){var bg=AV_COLORS[((i%6)+6)%6];var fg=(bg==='#F4B62B')?'#1E261F':'#fff';return 'background:'+bg+';color:'+fg+';'}



window.filterStudents=function(q){

  const kw=q.trim()

  document.querySelectorAll('#studentGrid .stu-btn').forEach(b=>{

    b.classList.toggle('hidden',!!kw&&!b.dataset.name.includes(kw))

  })

}



window.selectStudent=function(id){

  const s=STUDENTS.find(x=>x.id===id);if(!s)return

  ST.student=s;ST.cart=[];ST.sessionBalance=0;ST.sessionOrders=[]

  const av=document.getElementById('bannerAv')

  if(s.photo_url){av.outerHTML='<img class="stu-banner-photo" id="bannerAv" src="'+escHtml(s.photo_url)+'" alt="'+escHtml(s.name)+'"/>'}

  else{

    const newAv=document.createElement('div');newAv.id='bannerAv';newAv.className='stu-banner-av';newAv.textContent=s.name[0]

    av.replaceWith(newAv)

  }

  document.getElementById('bannerName').textContent=s.name

  updateBannerStats(s)

  const cav=document.getElementById('confirmAv')

  if(s.photo_url){

    cav.outerHTML='<img class="confirm-av" id="confirmAv" src="'+escHtml(s.photo_url)+'" alt="'+escHtml(s.name)+'"/>'

  } else {

    cav.outerHTML='<div class="confirm-av-txt" id="confirmAv">'+escHtml(s.name[0])+'</div>'

  }

  document.getElementById('confirmSn').textContent=s.name

  // 수학 전광판 칩: 일단 숨기고, 수학 수강생이면 표시
  var _mcr=document.getElementById('mathChipRow'); if(_mcr)_mcr.style.display='none'
  refreshMathChip()

  updateCartBar();switchTab('shop');goTo('menu')

}



function updateBannerStats(s){

  const c=CFG.currency

  const stats=document.getElementById('bannerStats')

  let html='<div class="stat-chip">'+symMark(15)+'<span class="bhs" style="font-size:15px">'+s.points+'</span> '+c.unit+'</div>'

  stats.innerHTML=html

}



// ── 상점 잠금 상태 ──
let SHOP_STATUS = { locked: false, forceLocked: false, unlocked: false, expiresAt: null }
let shopUnlockTimer = null
let shopPollTimer = null

async function checkShopStatus() {
  try {
    const sid = ST.student?.id
    const url = sid ? '/api/shop/status?student_id=' + sid : '/api/shop/status'
    const r = await fetch(url)
    const d = await r.json()
    SHOP_STATUS = d
    renderShopLockOverlay()
  } catch(_) {}
}

function renderShopLockOverlay() {
  const overlay = document.getElementById('shop-lock-overlay')
  if (!overlay) return

  // 상점 탭이 아닐 때는 오버레이/배지 항상 숨김
  if (ST.tab !== 'shop') {
    overlay.style.display = 'none'
    const b = document.getElementById('shop-unlock-badge')
    if (b) b.style.display = 'none'
    return
  }

  if (SHOP_STATUS.unlocked && !SHOP_STATUS.locked) {
    const exp = SHOP_STATUS.expiresAt ? new Date(SHOP_STATUS.expiresAt + 'Z') : null
    const remain = exp ? Math.max(0, Math.floor((exp.getTime() - Date.now()) / 1000)) : 0
    if (remain <= 0) {
      SHOP_STATUS.unlocked = false
      overlay.style.display = 'none'
      const b = document.getElementById('shop-unlock-badge')
      if (b) b.style.display = 'none'
      return
    }
    const mm = Math.floor(remain / 60), ss = remain % 60
    overlay.style.display = 'none'
    const badge = document.getElementById('shop-unlock-badge')
    if (badge) { badge.style.display = 'block'; badge.innerHTML = icon('lock',13,'currentColor') + ' ' + mm + ':' + String(ss).padStart(2,'0') + ' \uB0A8\uC74C' }
    return
  }

  if (SHOP_STATUS.locked) {
    overlay.style.display = 'flex'
    const lockMsg = document.getElementById('shopLockMsg')
    if (lockMsg) lockMsg.textContent = SHOP_STATUS.forceLocked ? '\uAD00\uB9AC\uc790\uAC00 \uC7A0\uAD38\uC2B5\uB2C8\uB2E4' : '\uC218\uC5C5 \uC911\uC785\uB2C8\uB2E4'
    const badge = document.getElementById('shop-unlock-badge')
    if (badge) { badge.style.display = 'none'; badge.textContent = '' }
    return
  }

  overlay.style.display = 'none'
  const badge = document.getElementById('shop-unlock-badge')
  if (badge) { badge.style.display = 'none'; badge.textContent = '' }
}




// 탭

window.switchTab=async function(tab){

  // 탭 변경 전 상점 polling 정지 (상점 탭 벗어날 때)
  if (tab !== 'shop' && shopPollTimer) {
    clearInterval(shopPollTimer); shopPollTimer = null
  }

  // 상점 탭이 아니면 오버레이/배지 반드시 숨김 (ST.tab 업데이트 전에 먼저 숨김)
  if (tab !== 'shop') {
    const ov = document.getElementById('shop-lock-overlay')
    if (ov) ov.style.display = 'none'
    const badge = document.getElementById('shop-unlock-badge')
    if (badge) badge.style.display = 'none'
  }

  // ST.tab 먼저 업데이트 (renderShopLockOverlay가 ST.tab 확인하므로)
  ST.tab = tab
  document.querySelectorAll('.tab-btn').forEach(b=>b.className='tab-btn')
  document.getElementById('tab-'+tab).classList.add('tab-btn','active-'+tab)

  // 상점 탭 클릭 시 잠금 확인
  if (tab === 'shop') {
    await checkShopStatus()
  }

  renderMenu()

  // 상점 탭이면 잠금 오버레이 처리
  if (tab === 'shop') renderShopLockOverlay()

}



// 메뉴 그리드

function renderMenu(){

  const items=(CFG.menu[ST.tab]||[]).filter(m=>!m.hidden)   // 숨김 처리된 항목 제외

  const g=document.getElementById('menuGrid')

  const c=CFG.currency

  g.innerHTML=items.map(m=>{

    // 보강신청은 외부 링크

    if(m.id==='makeup'||m.externalUrl){

      const url=m.externalUrl||'https://forms.gle/XwZk3PdQk9HVPVfW6'

      return '<div class="menu-btn type-'+ST.tab+' btn-menu-ext" data-url="'+url+'">'+

        '<div class="menu-ic">'+icon(menuKey(m,ST.tab),24)+'</div>'+

        '<div class="menu-lbl">'+escHtml(m.label)+'</div>'+

        '<div class="menu-cost-tag" style="background:var(--t-cobalt);color:var(--cobalt)">외부링크</div>'+

      '</div>'

    }

    const ci=ST.cart.find(x=>x.id===m.id&&x.tab===ST.tab)

    const qty=ci?ci.qty:0

    const inCart=qty>0

    let costTxt

    if(ST.tab==='learn'){

      const netPts=(m.reward||0)-(m.cost||0)

      costTxt=netPts>0?'+'+netPts+' '+symMark(12):netPts<0?netPts+' '+c.unit:'무료'

    } else if(ST.tab==='fine'){

      // 항목별 화폐 단위 표시
      const fineUnit=m.unit||(m.fineType==='time'?'분':m.fineType==='sheet'?'장':c.unit)
      const fineIcon=m.fineType==='time'?icon('clock',13,'currentColor'):m.fineType==='sheet'?icon('sheet',13,'currentColor'):icon('finepoint',13,'currentColor')
      costTxt=fineIcon+m.cost+' '+fineUnit

    } else {

      // shop: soldOut 체크
      if(m.soldOut){
        costTxt='품절'
      } else {
        costTxt=m.cost+' '+symMark(12)
      }

    }

    const photoBadge=m.requirePhoto?'<div class="photo-badge-sm">'+icon('camera',13,'#fff')+'</div>':''

    // shop 품절 처리
    const isSoldOut=(ST.tab==='shop'&&m.soldOut)

    let bottomHtml

    if(isSoldOut){

      bottomHtml='<div class="menu-cost-tag" style="background:var(--t-clay);color:var(--clay)">'+icon('nohomework',13,'currentColor')+'품절</div>'

    } else if(qty>0){

      bottomHtml='<div class="qty-ctrl" data-id="'+m.id+'" data-tab="'+ST.tab+'">'+

        '<button class="qty-minus">-</button>'+

        '<span class="qty-num">'+qty+'</span>'+

        '<button class="qty-plus">+</button>'+

      '</div>'

    } else {

      bottomHtml='<div class="menu-cost-tag">'+costTxt+'</div>'

    }

    const soldStamp=isSoldOut?'<div class="bhs" style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%) rotate(-7deg);border:2.5px solid var(--clay);color:var(--clay);font-size:20px;padding:2px 12px;border-radius:8px;opacity:.85;pointer-events:none">품절</div>':''

    return '<div class="menu-btn type-'+ST.tab+(inCart?' in-cart':'')+(isSoldOut?' sold-out':'')+' btn-menu-item" data-id="'+m.id+'" data-tab="'+ST.tab+'" data-soldout="'+isSoldOut+'">'+

      photoBadge+

      '<div class="menu-ic">'+icon(menuKey(m,ST.tab),24)+'</div>'+

      '<div class="menu-lbl">'+escHtml(m.label)+'</div>'+

      bottomHtml+

      soldStamp+

    '</div>'

  }).join('')

}



// 메뉴 그리드 이벤트 위임

document.addEventListener('click',function(e){

  // 외부링크 버튼

  const extBtn=e.target.closest('.btn-menu-ext')

  if(extBtn){window.open(extBtn.dataset.url,'_blank');return}

  // 수량 + 버튼

  if(e.target.closest('.qty-plus')){

    const ctrl=e.target.closest('.qty-ctrl')

    if(ctrl){

      const ex=ST.cart.find(x=>x.id===ctrl.dataset.id&&x.tab===ctrl.dataset.tab)

      if(ex&&canAddShop(ex.tab,1)){ex.qty++;updateCartBar();renderMenu()}

    }

    return

  }

  // 수량 - 버튼

  if(e.target.closest('.qty-minus')){

    const ctrl=e.target.closest('.qty-ctrl')

    if(ctrl){

      const ex=ST.cart.find(x=>x.id===ctrl.dataset.id&&x.tab===ctrl.dataset.tab)

      if(ex){

        ex.qty--

        if(ex.qty<=0)ST.cart.splice(ST.cart.indexOf(ex),1)

        updateCartBar();renderMenu()

      }

    }

    return

  }

  // 메뉴 카드 클릭 (수량 컨트롤 영역 제외, 품절 제외)

  const btn=e.target.closest('.btn-menu-item')

  if(btn&&!e.target.closest('.qty-ctrl')&&btn.dataset.soldout!=='true'){window.addToCart(btn.dataset.id,btn.dataset.tab)}

})



// 장바구니

function canAddShop(tab,add){
  const max=Number(CFG.shopMaxPerOrder||0)
  if(tab!=='shop'||max<=0)return true
  const cur=ST.cart.reduce((a,x)=>a+(x.tab==='shop'?x.qty:0),0)
  if(cur+add>max){toast('한 번에 '+max+'개까지 담을 수 있어요');return false}
  return true
}

window.addToCart=function(id,tab){

  const item=(CFG.menu[tab]||[]).find(x=>x.id===id);if(!item)return

  // 품절 처리
  if(item.soldOut){toast('품절된 상품이에요!');return}

  if(item.requirePhoto){ST.pendingItem={item,tab};openPhotoModal(item.label);return}

  pushCart(item,tab,null)

}

function pushCart(item,tab,photo,comment){

  if(!canAddShop(tab,1))return

  const ex=ST.cart.find(x=>x.id===item.id&&x.tab===tab)

  if(ex){ex.qty++}else{ST.cart.push({id:item.id,tab,icon:item.icon,label:item.label,cost:item.cost,reward:item.reward||0,requirePhoto:item.requirePhoto,qty:1,photo,comment:comment||'',fineType:item.fineType||'point',unit:item.unit||''})}

  updateCartBar();renderMenu()

  showFb(item.icon,item.label)

}

function toast(m){var fb=document.createElement('div');fb.className='fb-toast';fb.textContent=m;document.body.appendChild(fb);setTimeout(function(){fb.remove()},1500)}

function showFb(ic,label){

  const fb=document.createElement('div');fb.className='fb-toast';fb.innerHTML=(ICONS[ic]?icon(ic,16,'currentColor'):'')+'<span>'+escHtml(label)+' 담았어요!</span>'

  document.body.appendChild(fb);setTimeout(()=>fb.remove(),1500)

}

window.clearCart=function(){ST.cart=[];updateCartBar();renderMenu()}



// ── 상점 잠금해제 요청 ──────────────────────────────────────────────────────

window.requestShopUnlock = async function() {

  if (!ST.student) return

  const btn = document.getElementById('shopUnlockReqBtn')

  const status = document.getElementById('shopUnlockReqStatus')

  btn.disabled = true; btn.textContent = '요청 중...'

  try {

    const res = await fetch('/api/shop/request-unlock', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ studentName: ST.student.name, studentId: ST.student.id })
    })

    const d = await res.json()

    if (d.success) {

      btn.textContent = '요청 완료!'

      status.textContent = d.alreadyPending
        ? '이미 요청을 보냈어요. 선생님 승인을 기다려주세요'
        : '선생님께 알림을 보냈어요 승인되면 자동으로 열립니다'

      // 10초마다 승인 여부 폴링
      if (shopPollTimer) clearInterval(shopPollTimer)

      shopPollTimer = setInterval(async () => {

        await checkShopStatus()

        if (!SHOP_STATUS.locked) {

          clearInterval(shopPollTimer); shopPollTimer = null

          showFb('cart','상점이 열렸어요 빠르게 주문하세요!')

          renderShopLockOverlay()

          renderMenu()

          // 배지 표시
          const badge = document.getElementById('shop-unlock-badge')

          badge.style.display = 'block'

          // 1분마다 남은 시간 갱신
          const badgeTimer = setInterval(() => {

            if (!SHOP_STATUS.unlocked) { clearInterval(badgeTimer); badge.style.display='none'; return }

            const exp = SHOP_STATUS.expiresAt ? new Date(SHOP_STATUS.expiresAt + 'Z') : null

            const remain = exp ? Math.max(0, Math.floor((exp.getTime() - Date.now()) / 1000)) : 0

            if (remain <= 0) { clearInterval(badgeTimer); badge.style.display='none'; checkShopStatus(); return }

            const mm = Math.floor(remain/60), ss = remain%60

            badge.innerHTML = icon('lock',13,'currentColor') + ' 상점 오픈 중 · ' + mm + ':' + String(ss).padStart(2,'0') + ' \uB0A8\uC74C'

          }, 1000)

        }

      }, 10000)

    } else {

      status.textContent = '요청 실패. 다시 시도해주세요.'

      btn.disabled = false; btn.innerHTML = icon('consult',16)+' 선생님께 상점 열기 요청'

    }

  } catch(_) {

    status.textContent = '오류가 발생했어요.'

    btn.disabled = false; btn.innerHTML = icon('consult',16)+' 선생님께 상점 열기 요청'

  }

}

function updateCartBar(){

  const tot=ST.cart.reduce((a,x)=>a+x.qty,0)

  document.getElementById('cartBadge').textContent=tot

  document.getElementById('cartCnt').textContent=tot+'개 담음'

  document.getElementById('cartPreview').textContent=ST.cart.map(x=>x.icon+x.label+(x.qty>1?' ×'+x.qty:'')).join(' · ')

  const isMenu=document.getElementById('menu-screen').classList.contains('active')

  document.getElementById('cartBar').classList.toggle('visible',isMenu)

}



// 사진 모달

function openPhotoModal(label){

  document.getElementById('photoSub').textContent='[ '+label+' ] 사진 인증이 필요해요'

  document.getElementById('photoPrev').style.display='none'

  document.getElementById('photoPh').style.display='block'

  document.getElementById('photoOk').disabled=true

  ST.photoB64=null;document.getElementById('photo-modal').classList.add('open')

}

window.closePhotoModal=function(){document.getElementById('photo-modal').classList.remove('open');ST.pendingItem=null;ST.photoB64=null;document.getElementById('photoInput').value='';document.getElementById('photoComment').value=''}

window.triggerPhoto=function(){document.getElementById('photoInput').click()}

window.onPhoto=function(e){

  const f=e.target.files[0];if(!f)return

  const reader=new FileReader()

  reader.onload=function(ev){

    ST.photoB64=ev.target.result

    const p=document.getElementById('photoPrev');p.src=ST.photoB64;p.style.display='block'

    document.getElementById('photoPh').style.display='none'

    document.getElementById('photoOk').disabled=false

  };reader.readAsDataURL(f)

}

window.confirmPhoto=function(){

  if(!ST.pendingItem||!ST.photoB64)return

  const{item,tab}=ST.pendingItem

  const comment=document.getElementById('photoComment').value.trim()

  pushCart(item,tab,ST.photoB64,comment)

  closePhotoModal()

}



// 확인 모달

window.openConfirm=function(){

  if(ST.cart.length===0){showFb('cart','먼저 항목을 담아보세요!');return}

  const c=CFG.currency

  document.getElementById('orderList').innerHTML=ST.cart.map(x=>{

    const tab=x.tab;let cs,cc

    if(tab==='learn'){cs=x.reward>0?'+'+x.reward*x.qty+' '+symMark(13):'무료';cc='green'}

    else if(tab==='fine'){cs='-'+x.cost*x.qty+' '+c.unit;cc='red'}

    else{cs=x.cost*x.qty+' '+symMark(13);cc='purple'}

    return '<div class="order-item"><div class="order-emoji">'+icon(x.icon||'star',20)+'</div><div class="order-info"><div class="order-lbl">'+escHtml(x.label)+'</div><div class="order-qty">× '+x.qty+(x.requirePhoto?icon('camera',12,'currentColor'):'')+'</div></div><div class="order-cost '+cc+'">'+cs+'</div></div>'

  }).join('')

  const tc=calcTotal();const tv=document.getElementById('totalVal')

  if(tc===0){tv.textContent='무료';tv.style.color='var(--green)'}

  else if(tc>0){tv.textContent=tc+' '+c.unit+' 차감';tv.style.color='var(--red)'}

  else{tv.innerHTML='<span style="display:inline-flex;align-items:center;gap:4px">'+symMark(18)+Math.abs(tc)+' '+c.unit+' 획득!</span>';tv.style.color='var(--moss)'}

  const btn=document.getElementById('confirmOk');btn.disabled=false

  document.getElementById('confirmTxt').textContent='제출하기';btn.querySelector('.spinner')?.remove()

  document.getElementById('confirm-modal').classList.add('open')

}

window.closeConfirm=function(){document.getElementById('confirm-modal').classList.remove('open')}

// 포인트 부족 시 대출 제안 (부족분만큼 자동 대출 → 10포인트=1분 당일 보충수업)
window.closeLoan=function(){document.getElementById('loan-modal').classList.remove('open')}
function offerLoan(need,shortfall){
  ST.loanNeed=need
  const min=Math.ceil((shortfall||0)/10)
  document.getElementById('loanBody').innerHTML='지금 <b>'+shortfall+' '+CFG.currency.unit+'</b>이 부족해요.<br>대출하면 <b>'+shortfall+' '+CFG.currency.unit+'</b>을 빌리고, 오늘 <b>'+min+'분</b> 추가 보충수업을 하게 돼요.'
  const b=document.getElementById('loanOk');b.disabled=false;document.getElementById('loanTxt').textContent='대출하고 주문하기'
  document.getElementById('loan-modal').classList.add('open')
}
window.doLoan=async function(){
  if(ST.submitting)return;ST.submitting=true
  const b=document.getElementById('loanOk');b.disabled=true;document.getElementById('loanTxt').textContent='대출 중...'
  try{
    const res=await fetch('/api/loan',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:ST.student.name,need:ST.loanNeed})})
    const data=await res.json()
    if(!res.ok||!data||data.success===false){
      document.getElementById('loanTxt').textContent='대출하고 주문하기';b.disabled=false;ST.submitting=false
      toast((data&&data.error)?data.error:'대출에 실패했어요.')
      return
    }
    if(ST.student&&data.credited){ST.student.points+=data.credited}
    closeLoan();ST.submitting=false
    doSubmit() // 포인트가 채워졌으니 원래 주문 재전송
  }catch(err){document.getElementById('loanTxt').textContent='대출하고 주문하기';b.disabled=false;ST.submitting=false;toast('대출 전송 실패. 다시 시도해주세요.')}
}

function calcTotal(){

  return ST.cart.reduce((a,x)=>{

    if(x.tab==='learn'){

      // learn: reward 있으면 획득(음수), cost 있으면 차감(양수)

      return a - (x.reward||0)*x.qty + (x.cost||0)*x.qty

    }

    if(x.tab==='fine'){

      // fine: cost 차감 - reward 획득 (벌점이지만 일부 보상 가능)

      return a + (x.cost||0)*x.qty - (x.reward||0)*x.qty

    }

    // shop: cost 차감

    return a + (x.cost||0)*x.qty

  },0)

}



// 제출

window.doSubmit=async function(){

  if(ST.submitting)return;ST.submitting=true

  const btn=document.getElementById('confirmOk');btn.disabled=true

  document.getElementById('confirmTxt').textContent='전송 중...'

  const sp=document.createElement('div');sp.className='spinner';btn.insertBefore(sp,btn.firstChild)

  const ts=new Date().toLocaleString('ko-KR',{timeZone:'Asia/Seoul'})

  const hasFine=ST.cart.some(x=>x.tab==='fine');const hasShop=ST.cart.some(x=>x.tab==='shop')

  const category=hasFine?'fine':hasShop?'shop':'learn'

  const tc=calcTotal();ST.sessionBalance+=tc

  ST.sessionOrders.push({items:[...ST.cart],totalCost:tc,ts,category})

  try{

    const res=await fetch('/api/submit',{method:'POST',headers:{'Content-Type':'application/json'},

      body:JSON.stringify({

        name:ST.student.name,

        items:ST.cart.map(x=>({id:x.id,icon:x.icon,label:x.label,qty:x.qty,tab:x.tab,comment:x.comment||'',fineType:x.fineType||'point',unit:x.unit||''})),

        totalCost:tc,

        currency:CFG.currency.unit,

        category,

        photoBase64:ST.cart.find(x=>x.photo)?.photo||null,

        comment:ST.cart.filter(x=>x.comment).map(x=>x.icon+x.label+': '+x.comment).join(' / ')||null,

        timestamp:ts

      })})

    const data=await res.json()

    // 서버가 실패를 반환하면 완료화면 대신 오류 안내 (예: 재고/한도 초과)
    if(!res.ok||!data||data.success===false){
      ST.sessionOrders.pop();ST.sessionBalance-=tc
      const sp2=btn.querySelector('.spinner');if(sp2)sp2.remove()
      document.getElementById('confirmTxt').textContent='제출하기';btn.disabled=false
      ST.submitting=false
      // 포인트 부족(상점): 대출 옵션 제공
      if(data&&data.code==='insufficient_points'){offerLoan(tc,data.shortfall);return}
      toast((data&&data.error)?data.error:'주문 처리에 실패했어요. 다시 시도해주세요.')
      return
    }

    if(ST.student){ST.student.points-=tc}

    await loadStudents()

    // 업데이트된 학생 정보 반영

    const updStu=STUDENTS.find(x=>x.id===ST.student.id)

    if(updStu) ST.student=updStu

    closeConfirm();renderDone(data.slack,data.notion,ts,tc)

  }catch(err){ST.sessionOrders.pop();ST.sessionBalance-=tc;const sp3=btn.querySelector('.spinner');if(sp3)sp3.remove();document.getElementById('confirmTxt').textContent='제출하기';btn.disabled=false;toast('전송 실패. 네트워크를 확인하고 다시 시도해주세요.')}

  finally{ST.submitting=false}

}



// 완료 화면

function renderDone(slackOk,notionOk,ts,tc){

  const c=CFG.currency

  const lastOrder=ST.sessionOrders[ST.sessionOrders.length-1]

  const hasFine=lastOrder&&lastOrder.category==='fine'

  const hasShop=lastOrder&&lastOrder.category==='shop'

  document.getElementById('doneEmoji').innerHTML=icon(hasFine?'record':hasShop?'cart':'check',48,'#fff')

  document.getElementById('doneTitle').textContent=hasFine?'기록 완료!':hasShop?'교환 완료!':'잘했어요!'

  const newPts=ST.student?ST.student.points:0

  document.getElementById('doneSub').innerHTML='<strong>'+escHtml(ST.student.name)+'</strong>님 기록 완료!<br/>'+(tc<0?'<span style="color:var(--green)">+'+Math.abs(tc)+' '+c.unit+' 획득</span>':tc>0?'<span style="color:var(--red)">-'+tc+' '+c.unit+' 차감</span>':'<span style="color:var(--green)">무료 활동</span>')

  const totalItems=ST.cart.reduce((a,x)=>a+x.qty,0)

  document.getElementById('sessSum').innerHTML=

    '<div class="ss-title">'+icon('record',14,'currentColor')+'이번 기록</div>'+

    ssRow('학생',escHtml(ST.student.name))+

    ssRow('항목',totalItems+'개')+

    ssRow('이번 합계',tc===0?'무료':Math.abs(tc)+' '+(tc<0?c.unit+' 획득':c.unit+' 차감'))+

    ssRow('현재 포인트','<span style="display:inline-flex;align-items:center;gap:4px">'+symMark(13)+newPts+' '+c.unit+'</span>')

  document.getElementById('doneChips').innerHTML=mkChip(slackOk,'fab fa-slack','슬랙')+mkChip(notionOk,'fas fa-database','노션')

  document.getElementById('btnContLbl').textContent=escHtml(ST.student.name)+'님으로 계속 담기'

  if(tc<=0&&!hasFine)launchConfetti()

  goTo('done');autoTimer=setTimeout(()=>goTo('splash'),28000)

}

window.continueOrder=function(){clearTimeout(autoTimer);ST.cart=[];updateCartBar();renderMenu();switchTab('shop');goTo('menu')}

function ssRow(l,v){return '<div class="ss-row"><span class="ss-lbl">'+l+'</span><span class="ss-val">'+v+'</span></div>'}

function mkChip(ok,ic,lb){return '<div class="chip '+(ok?'ok':'fail')+'">'+(ok?icon('check',13,'currentColor'):icon('nohomework',13,'currentColor'))+' '+lb+'</div>'}

function launchConfetti(){

  const arr=['#11998A','#F2724B','#F4B62B','#4C8A3A','#7A5CD0','#C0473A']

  for(let i=0;i<14;i++){

    setTimeout(()=>{

      const el=document.createElement('div');el.className='confetti-p'

      

      el.style.cssText='left:'+Math.random()*100+'%;bottom:10%;width:'+(9+Math.random()*7)+'px;height:'+(9+Math.random()*7)+'px;background:'+arr[Math.floor(Math.random()*arr.length)]+';border:1.5px solid #1E261F;animation-duration:'+(1.2+Math.random()*.8)+'s;animation-delay:'+Math.random()*.3+'s;'

      document.body.appendChild(el);setTimeout(()=>el.remove(),2500)

    },i*60)

  }

}






// ──────────────────────────────────────────────────────────

//  번호표 시스템

// ──────────────────────────────────────────────────────────

let QUEUE_STUDENT = null  // 번호표 뽑을 학생



// 번호표 화면으로 이동 (학생 선택 단계)

window.goToQueue = function() {

  goTo('queue')

  // queue-screen 내 sub-step 제어

  document.getElementById('queue-step-select').style.display = 'block'

  document.getElementById('queue-step-result').style.display = 'none'

  document.getElementById('queueSearchInp').value = ''

  renderQueueStudents()

  startQueueSelPoll()   // 상단 대기 인원·순번 실시간 갱신

}

// 번호표 선택화면 상단 상태 (대기 인원 / 호출 순번)
function loadQueueSelectStatus(){
  fetch('/api/queue/status').then(function(r){return r.json()}).then(function(d){
    if(!d||!d.success)return
    var tickets=d.tickets||[]
    var waiting=tickets.filter(function(t){return t.status==='waiting'}).length
    var ans=tickets.filter(function(t){return t.status==='answering'})
    var nowNum=ans.length?ans[ans.length-1].number:null
    var w=document.getElementById('qSelWaiting'); if(w)w.textContent=waiting
    var n=document.getElementById('qSelNow'); if(n)n.textContent=(nowNum!=null?nowNum:'-')
  }).catch(function(){})
}
var queueSelTimer=null
function startQueueSelPoll(){ stopQueueSelPoll(); loadQueueSelectStatus(); queueSelTimer=setInterval(loadQueueSelectStatus,4000) }
function stopQueueSelPoll(){ if(queueSelTimer){clearInterval(queueSelTimer);queueSelTimer=null} }



// 번호표 학생 그리드 렌더

function renderQueueStudents() {

  const g = document.getElementById('queueStudentGrid')

  g.innerHTML = STUDENTS.map(s => {

    const photoEl = s.photo_url

      ? '<img class="stu-photo" src="'+escHtml(s.photo_url)+'" alt="'+escHtml(s.name)+'"/>'

      : '<div class="stu-av">'+escHtml(s.name[0])+'</div>'

    return '<button class="stu-btn" data-name="'+escHtml(s.name)+'" onclick="selectQueueStudent('+s.id+')">'+

      photoEl+'<div class="stu-name">'+escHtml(s.name)+'</div></button>'

  }).join('')

}



window.filterQueueStudents = function(q) {

  const kw = q.trim()

  document.querySelectorAll('#queueStudentGrid .stu-btn').forEach(b => {

    b.classList.toggle('hidden', !!kw && !b.dataset.name.includes(kw))

  })

}



// 학생 선택 후 번호표 발급

window.selectQueueStudent = async function(id) {

  const s = STUDENTS.find(x => x.id === id); if (!s) return

  QUEUE_STUDENT = s



  // 단계 전환 (결과 화면으로)

  document.getElementById('queue-step-select').style.display = 'none'

  document.getElementById('queue-step-result').style.display = 'flex'

  stopQueueSelPoll()   // 결과 화면에선 별도 현황(loadQueueStatus) 사용



  // 임시 로딩 표시

  document.getElementById('queueNumber').textContent = '...'

  document.getElementById('queueStuName').textContent = s.name

  document.getElementById('queueWaiting').textContent = '-'

  document.getElementById('queueTotal').textContent = '-'



  try {

    const res = await fetch('/api/queue/draw', {

      method: 'POST',

      headers: {'Content-Type':'application/json'},

      body: JSON.stringify({ studentName: s.name })

    })

    const data = await res.json()



    if (!data.success) {

      // 오류 처리

      const msgBox = document.getElementById('queueMsgBox')

      const msgText = document.getElementById('queueMsgText')

      msgBox.className = 'queue-msg-box warn'

      document.querySelector('#queueMsgBox .queue-msg-icon').innerHTML = data.error === 'consecutive' ? icon('consult',24,'currentColor') : icon('warn',24,'currentColor')

      msgText.textContent = data.message || '번호표를 발급할 수 없어요.'

      document.getElementById('queueNumber').textContent = '!'

      // 현황 불러오기

      await loadQueueStatus(null)

      return

    }



    // 성공

    document.getElementById('queueNumber').textContent = data.number

    document.getElementById('queueDate').textContent = data.date + ' 발급'



    const msgBox = document.getElementById('queueMsgBox')

    const msgText = document.getElementById('queueMsgText')



    if (data.waiting === 0) {

      msgBox.className = 'queue-msg-box ok'

      document.querySelector('#queueMsgBox .queue-msg-icon').innerHTML = icon('check',24,'currentColor')

      msgText.textContent = '첫 번째 바로 이용할 수 있어요!'

    } else if (data.waiting <= 2) {

      msgBox.className = 'queue-msg-box info'

      document.querySelector('#queueMsgBox .queue-msg-icon').innerHTML = icon('clock',24,'currentColor')

      msgText.textContent = '앞에 ' + data.waiting + '명 있어요. 거의 다 왔어요!'

    } else {

      msgBox.className = 'queue-msg-box info'

      document.querySelector('#queueMsgBox .queue-msg-icon').innerHTML = icon('ticket',24,'currentColor')

      msgText.textContent = '앞에 ' + data.waiting + '명이 기다리고 있어요!'

    }



    await loadQueueStatus(data.number)



  } catch (err) {

    document.getElementById('queueNumber').textContent = '!'

    document.getElementById('queueMsgText').textContent = '네트워크 오류가 발생했어요.'

  }

}



// 현황 조회 및 목록 표시

async function loadQueueStatus(myNumber) {

  try {

    const res = await fetch('/api/queue/status')

    const data = await res.json()

    if (!data.success) return



    document.getElementById('queueWaiting').textContent = myNumber

      ? (data.tickets.filter(t => !t.called && t.number < myNumber).length) + '명'

      : (data.waiting + '명')

    document.getElementById('queueTotal').textContent = data.total + '장'



    // 번호표 목록 렌더

    const listEl = document.getElementById('queueTicketList')

    if (data.tickets.length > 0) {

      const chips = data.tickets.map(t => {

        const isMine = myNumber && t.number === myNumber

        const cls = isMine ? 'mine' : (t.called ? 'called' : 'waiting')

        return '<div class="qtl-chip ' + cls + '">' + t.number + '번 ' + escHtml(t.student_name) + (isMine ? ' (나)' : '') + '</div>'

      }).join('')

      listEl.innerHTML = '<div class="qtl-title">오늘의 번호표 현황</div><div class="qtl-items">' + chips + '</div>'

    } else {

      listEl.innerHTML = ''

    }

  } catch (e) {}

}



// ══ 수학 전광판 (수학야구) — 쏘이지 점수 읽어서 표시 ══
// 색·규칙은 계획서(ddingdong_kiosk_plan.md) 6번 그대로.
var MB={open:false,poll:null,idle:null,chipPoll:null,last:null,loadedFor:null}
var MB_IDLE_MS=45000   // 키오스크: 손 안 대면 자동 닫힘 (지현님이 조정)
var MB_POLL_MS=3000    // 모달 열려있을 때 실시간 갱신 주기
var MB_CHIP_MS=12000   // 메뉴 화면에서 칩 노출 여부 주기적 확인

function mbFetch(s){
  var q='/api/baseball/board?student_id='+encodeURIComponent(s.id!=null?s.id:'')+'&name='+encodeURIComponent(s.name||'')
  return fetch(q).then(function(r){return r.json()}).catch(function(){return {success:false}})
}

// 칩 노출: 수학 수강생(board 존재)에게만 표시. board:null(비수강)이면 숨김.
function refreshMathChip(){
  var s=ST.student; var row=document.getElementById('mathChipRow')
  if(!s||!row){return}
  mbFetch(s).then(function(d){
    if(!ST.student||ST.student.name!==s.name)return   // 응답 오는 사이 학생 바뀌면 무시
    row.style.display=(d&&d.success&&d.exists)?'block':'none'
  })
}
function startChipPoll(){ refreshMathChip() }   // 메뉴 진입 시 1회 확인 (쏘이지 부하 최소화)
function stopChipPoll(){ if(MB.chipPoll){clearInterval(MB.chipPoll);MB.chipPoll=null} }

// 연동요청서 응답 → 화면용 board 정규화 (S/B/O, round, pendingMakeup ...)
function mbNorm(board,fallbackName,photo){
  board=board||{}
  var n=function(v){return Number(v)||0}
  return {
    name: board.name||fallbackName||'',
    classLabel: board.classLabel||'',
    photo: photo||board.photo||'',
    S: n(board.S!=null?board.S:board.strike),
    B: n(board.B!=null?board.B:board.ball),
    O: n(board.O!=null?board.O:board.out),
    round: n(board.round!=null?board.round:((board.penaltyRounds||0)+1))||1,
    pendingMakeup: !!(board.pendingMakeup||board.supplement),
    honey: n(board.honey),
    status: board.status||'',
    goal: board.goal||'',
    recent: Array.isArray(board.recent)?board.recent:(Array.isArray(board.records)?board.records:[]),
    history: Array.isArray(board.history)?board.history:[],
    rules: Array.isArray(board.rules)?board.rules:[],
    cfg: board.cfg||null
  }
}

// 점(LED) 한 줄 렌더: 켜진 칸 on개, 전체 max칸 + 숫자(접근성)
function mbDots(on,max,onColor){
  var h=''
  for(var i=0;i<max;i++){
    var c=i<on?onColor:'#5A4630'
    h+='<span style="width:clamp(18px,2.4vw,24px);height:clamp(18px,2.4vw,24px);border-radius:50%;background:'+c+';flex:0 0 auto;transition:background .35s ease;"></span>'
  }
  return h
}
function mbRow(labelKo,labelSub,labelColor,on,max,onColor){
  return '<div style="display:flex;align-items:center;gap:clamp(9px,1.4vw,13px);margin-top:11px;">'
    +'<div style="width:clamp(86px,12vw,104px);flex:0 0 auto;">'
    +'<span style="font-size:clamp(14px,1.8vw,16px);font-weight:800;color:'+labelColor+'">'+labelKo+'</span>'
    +' <span style="font-size:clamp(12px,1.5vw,14px);font-weight:800;color:rgba(255,255,255,.7)">'+on+'<span style="opacity:.55">/'+max+'</span></span>'
    +'<br><span style="font-size:clamp(10px,1.3vw,12px);color:rgba(255,255,255,.5)">'+labelSub+'</span></div>'
    +mbDots(on,max,onColor)+'</div>'
}

// 목표 한 줄: 쏘이지가 보내준 goal 우선, 없으면 규칙으로 친절한 기본 문구
function mbGoalText(b){
  if(b.goal) return b.goal
  if(b.pendingMakeup) return '아웃 3개 — 보충 수업이 예정돼 있어요'
  if(b.B===3) return '볼 1개만 더 모으면 아웃 하나가 사라져요!'
  if(b.S===2) return '스트라이크 1개만 더 쌓이면 아웃이에요. 조심해요!'
  if(b.S===0&&b.B===0&&b.O===0) return '아직 깨끗해요. 이대로 가요!'
  return '좋은 행동(볼)으로 아웃을 지워봐요!'
}

// 기록 tone → [글씨색, 배경색]
function mbToneStyle(t){
  if(t==='ball')   return ['#1B7A3A','#D6F5E0']
  if(t==='minus')  return ['#1B7A3A','#D6F5E0']   // 스트라이크/아웃 감소(좋은 쪽)
  if(t==='honey')  return ['#9A6B12','#FCEBC9']
  if(t==='makeup') return ['#B23A2E','#FBD9D4']
  if(t==='out')    return ['#B23A2E','#FBD9D4']
  if(t==='strike') return ['#9A4A14','#FCE3CC']
  return ['#5A4630','#EFE7DA']
}
// 기록 한 줄 (recent/history 공용)
function mbRecItem(r){
  var st=mbToneStyle(r.tone||r.type||'')
  var badge=r.delta||r.label||'기록'
  var sub=(r.delta&&r.label)?r.label:''
  var h='<div style="display:flex;align-items:center;gap:10px;background:#F4EEE3;border:2px solid var(--ink);border-radius:12px;padding:9px 12px;margin-bottom:7px;">'
  h+='<span style="font-size:11px;font-weight:800;color:'+st[0]+';background:'+st[1]+';padding:3px 9px;border-radius:100px;white-space:nowrap;">'+escHtml(badge)+'</span>'
  if(sub) h+='<span style="font-size:clamp(12px,1.5vw,14px);font-weight:700;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">'+escHtml(sub)+'</span>'
  if(r.date) h+='<span style="margin-left:auto;font-size:11px;color:var(--ink-soft);font-weight:700;flex:none;">'+escHtml(r.date)+'</span>'
  h+='</div>'
  return h
}
// 회차별 기록 보기: history 를 round 로 묶어 표시
function mbHistoryHtml(history){
  var groups={},order=[]
  for(var i=0;i<history.length;i++){
    var r=history[i]; var rd=r.round||0
    if(!groups[rd]){groups[rd]=[];order.push(rd)}
    groups[rd].push(r)
  }
  order.sort(function(a,b){return b-a})
  var h=''
  for(var k=0;k<order.length;k++){
    var rd=order[k]
    h+='<div style="margin-top:12px;"><div style="font-size:12px;font-weight:800;color:var(--ink-soft);margin-bottom:6px;">'+(rd>0?rd+'회차':'기타')+'</div>'
    for(var j=0;j<groups[rd].length;j++){ h+=mbRecItem(groups[rd][j]) }
    h+='</div>'
  }
  return h||'<p style="font-size:12px;color:var(--ink-soft);font-weight:700;margin:10px 0;">기록이 없어요.</p>'
}
window.mbToggleHistory=function(){
  MB.histOpen=!MB.histOpen
  var box=document.getElementById('mb-history'), btn=document.getElementById('mb-history-btn')
  if(box) box.style.display=MB.histOpen?'block':'none'
  if(btn) btn.textContent=MB.histOpen?'회차별 기록 접기 ▲':'회차별 기록 보기 ▼'
  mbPoke()
}

// 상벌점 항목 안내: kind로 벌점(스트라이크)·상점(볼) 두 칸, 각 sort 오름차순. cfg로 규칙 한 줄.
function mbRulesHtml(rules,cfg){
  var strikes=[],balls=[]
  for(var i=0;i<rules.length;i++){
    var r=rules[i]
    if(r.kind==='strike') strikes.push(r)
    else if(r.kind==='ball') balls.push(r)
  }
  var bySort=function(a,b){return (a.sort||0)-(b.sort||0)}
  strikes.sort(bySort); balls.sort(bySort)
  var col=function(title,color,arr){
    var c='<div style="flex:1;min-width:0;"><div style="font-size:clamp(12px,1.5vw,13px);font-weight:800;color:'+color+';margin-bottom:6px;">'+title+'</div>'
    if(!arr.length){ c+='<div style="font-size:12px;color:var(--ink-soft);font-weight:700;">없음</div>' }
    for(var i=0;i<arr.length;i++){
      c+='<div style="display:flex;justify-content:space-between;gap:8px;font-size:clamp(12px,1.5vw,13px);font-weight:700;padding:3px 0;">'
      c+='<span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">'+escHtml(arr[i].label||'')+'</span>'
      c+='<span style="flex:none;color:'+color+';">+'+(Number(arr[i].points)||0)+'</span></div>'
    }
    return c+'</div>'
  }
  var h='<div style="display:flex;gap:14px;">'
  h+=col('벌점 · 스트라이크','#C0562A',strikes)
  h+=col('상점 · 볼','#1B7A3A',balls)
  h+='</div>'
  if(cfg){
    var p=[]
    p.push('스트라이크 '+(cfg.strikesPerOut||3)+'개 = 아웃 1개')
    p.push('볼 '+(cfg.ballsToClearOut||4)+'개 = 아웃 1개 감소')
    p.push('아웃 '+(cfg.outsForMakeup||3)+'개 = 보충')
    if(cfg.monthlyReset!==false) p.push('매월 초기화')
    h+='<p style="font-size:clamp(11px,1.4vw,12px);color:var(--ink-soft);font-weight:700;margin:10px 0 0;line-height:1.55;border-top:1px dashed rgba(36,28,18,.25);padding-top:9px;">'+escHtml(p.join(' · '))+'</p>'
  }
  return h
}
window.mbToggleRules=function(){
  MB.rulesOpen=!MB.rulesOpen
  var box=document.getElementById('mb-rules'), btn=document.getElementById('mb-rules-btn')
  if(box) box.style.display=MB.rulesOpen?'block':'none'
  if(btn) btn.textContent=MB.rulesOpen?'상벌점 항목 안내 접기 ▲':'상벌점 항목 안내 ▼'
  mbPoke()
}

function mbRenderBoard(b){
  // 데이터가 안 바뀌었으면 다시 그리지 않음(깜빡임/펼침상태 보존)
  var key=JSON.stringify(b)
  if(key===MB.lastKey) return
  MB.lastKey=key; MB.last=b
  var h=''
  // 이름 헤더 — 이니셜 카드 + 이름 옆 회차 칩(penaltyRounds+1) (+꿀 있으면)
  h+='<div style="display:flex;align-items:center;gap:13px;margin-bottom:12px;padding-right:44px;">'
  h+='<div style="width:clamp(48px,6.5vw,58px);height:clamp(48px,6.5vw,58px);flex:0 0 auto;display:flex;align-items:center;justify-content:center;background:#FCEBC9;border:2px solid var(--ink);border-radius:14px;color:#9A6B12;font-weight:800;font-size:clamp(20px,2.6vw,24px);font-family:\\'Black Han Sans\\',sans-serif;">'+escHtml((b.name||'?').slice(0,1))+'</div>'
  h+='<div style="min-width:0;flex:1;">'
  h+='<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">'
  h+='<p style="font-weight:800;font-size:clamp(18px,2.4vw,22px);margin:0;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">'+escHtml(b.name||'')+'</p>'
  h+='<span style="flex:none;display:inline-flex;align-items:center;background:#EAE2D4;color:var(--ink);border:2px solid var(--ink);border-radius:100px;padding:3px 10px;font-size:clamp(11px,1.4vw,13px);font-weight:800;">'+b.round+'회</span>'
  if(b.honey>0) h+='<span style="flex:none;display:inline-flex;align-items:center;gap:4px;background:#FCEBC9;color:#9A6B12;border:2px solid var(--ink);border-radius:100px;padding:3px 10px;font-size:clamp(11px,1.4vw,13px);font-weight:800;">🍯 '+b.honey+'</span>'
  h+='</div>'
  if(b.classLabel) h+='<p style="font-size:clamp(12px,1.5vw,14px);color:var(--ink-soft);margin:2px 0 0;font-weight:700;">'+escHtml(b.classLabel)+'</p>'
  h+='</div></div>'
  // 보충 대상일 때만 빨강 강조 (좋아요/주의 상태 칩은 표시 안 함)
  if(b.pendingMakeup){
    h+='<div style="display:flex;align-items:center;gap:8px;background:#FBD9D4;border:2px solid var(--ink);border-radius:14px;padding:10px 14px;margin-bottom:12px;font-weight:800;font-size:clamp(13px,1.6vw,15px);color:#B23A2E;">⚠️ 보충 대상</div>'
  }
  // 전광판 패널
  h+='<div style="background:#3A2A1A;border-radius:18px;padding:clamp(14px,2vw,18px) clamp(15px,2.1vw,19px);">'
  h+=mbRow('스트라이크','숙제 미제출','#FF7A3D',b.S,3,'#FF7A3D').replace('margin-top:11px;','margin-top:0;')
  h+=mbRow('볼','좋은 행동','#5DD67F',b.B,4,'#34C759')
  h+=mbRow('아웃','3개면 보충','#FF4438',b.O,3,'#FF4438')
  h+='</div>'
  // 요약 + 목표
  h+='<p style="text-align:center;font-size:clamp(12px,1.5vw,13px);font-weight:800;color:var(--ink-soft);margin:12px 0 0;">스트라이크 '+b.S+'개 · 볼 '+b.B+'개 · 아웃 '+b.O+'개</p>'
  h+='<div style="display:flex;align-items:center;gap:10px;background:var(--t-moss,#E4F3E4);border:2px solid var(--ink);border-radius:14px;padding:clamp(11px,1.5vw,14px) 14px;margin-top:10px;">'
  h+='<span style="font-size:1.4em;line-height:1;">🎯</span>'
  h+='<span style="font-size:clamp(13px,1.7vw,15px);font-weight:800;color:var(--ink,#241C12);">'+escHtml(mbGoalText(b))+'</span></div>'
  // 상벌점 항목 안내 (rules/cfg 있을 때만, 토글)
  if((b.rules&&b.rules.length)||b.cfg){
    h+='<button id="mb-rules-btn" onclick="mbToggleRules()" style="width:100%;margin-top:10px;background:#F1E9DC;border:2px solid var(--ink);border-radius:12px;padding:10px;font-size:clamp(12px,1.5vw,14px);font-weight:800;color:var(--ink);cursor:pointer;">'+(MB.rulesOpen?'상벌점 항목 안내 접기 ▲':'상벌점 항목 안내 ▼')+'</button>'
    h+='<div id="mb-rules" style="display:'+(MB.rulesOpen?'block':'none')+';background:#FBF7EF;border:2px solid var(--ink);border-radius:12px;padding:12px;margin-top:7px;">'+mbRulesHtml(b.rules,b.cfg)+'</div>'
  }
  // 최근 기록
  if(b.recent&&b.recent.length){
    h+='<p style="font-size:clamp(12px,1.5vw,13px);color:var(--ink-soft);font-weight:800;margin:16px 0 8px;">최근 기록</p>'
    for(var i=0;i<b.recent.length&&i<6;i++){ h+=mbRecItem(b.recent[i]) }
  }
  // 회차별 기록 보기 (history 있을 때만)
  if(b.history&&b.history.length){
    h+='<button id="mb-history-btn" onclick="mbToggleHistory()" style="width:100%;margin-top:10px;background:#F1E9DC;border:2px solid var(--ink);border-radius:12px;padding:10px;font-size:clamp(12px,1.5vw,14px);font-weight:800;color:var(--ink);cursor:pointer;">'+(MB.histOpen?'회차별 기록 접기 ▲':'회차별 기록 보기 ▼')+'</button>'
    h+='<div id="mb-history" style="display:'+(MB.histOpen?'block':'none')+';">'+mbHistoryHtml(b.history)+'</div>'
  }
  document.getElementById('mb-body').innerHTML=h
}

function mbRenderState(kind,msg){
  var el=document.getElementById('mb-body'); if(!el)return
  if(kind==='loading'){
    var sk='<span style="display:inline-block;width:60px;height:14px;border-radius:8px;background:#EDE6DA;animation:mbPulse 1s ease-in-out infinite;"></span>'
    el.innerHTML='<style>@keyframes mbPulse{0%,100%{opacity:.45}50%{opacity:1}}</style>'
      +'<div style="padding:8px 0 4px;"><div style="height:22px;width:48%;border-radius:8px;background:#EDE6DA;margin-bottom:16px;animation:mbPulse 1s ease-in-out infinite;"></div>'
      +'<div style="background:#3A2A1A;border-radius:18px;padding:18px;display:flex;flex-direction:column;gap:14px;">'
      +'<div style="display:flex;gap:10px;align-items:center;">'+sk+sk+sk+'</div>'
      +'<div style="display:flex;gap:10px;align-items:center;">'+sk+sk+sk+'</div>'
      +'<div style="display:flex;gap:10px;align-items:center;">'+sk+sk+sk+'</div></div></div>'
  } else {
    el.innerHTML='<div style="text-align:center;padding:40px 16px;color:var(--ink-soft);font-weight:800;font-size:clamp(14px,1.8vw,16px);line-height:1.6;">'+escHtml(msg)+'</div>'
  }
}

function mbLoad(showSkeleton){
  var s=ST.student; if(!s)return
  if(showSkeleton&&MB.loadedFor!==s.name) mbRenderState('loading')
  mbFetch(s).then(function(d){
    if(!MB.open||!ST.student||ST.student.name!==s.name)return
    if(d&&d.success&&d.exists&&d.board){ MB.loadedFor=s.name; mbRenderBoard(mbNorm(d.board,s.name,d.photo)) }
    else if(d&&d.success&&!d.exists){ // 아직 점수 없는 학생 → 빈 전광판(깨끗)
      MB.loadedFor=s.name
      mbRenderBoard(mbNorm({name:s.name},s.name,s.photo_url||''))
    }
    else { if(!MB.last) mbRenderState('msg','점수를 불러오지 못했어요.\\n잠시 후 다시 시도해 주세요.') }
  })
}

function mbPoke(){ // 카드 안 터치 → 자동 닫힘 타이머 리셋 (카드 안쪽은 안 닫힘)
  if(MB.idle)clearTimeout(MB.idle)
  MB.idle=setTimeout(closeMathBoard,MB_IDLE_MS)
}

window.openMathBoard=function(){
  var s=ST.student; if(!s){toast('학생을 먼저 선택해주세요');return}
  if(MB.open)return // 중복 열림 방지
  MB.open=true; MB.last=null; MB.lastKey=null; MB.loadedFor=null; MB.histOpen=false; MB.rulesOpen=false
  var ov=document.getElementById('mb-overlay'), card=document.getElementById('mb-card')
  ov.style.display='flex'
  document.body.style.overflow='hidden'
  requestAnimationFrame(function(){ ov.style.opacity='1'; card.style.transform='translateY(0) scale(1)' })
  mbLoad(true)
  if(MB.poll)clearInterval(MB.poll)
  MB.poll=setInterval(function(){mbLoad(false)},MB_POLL_MS)
  mbPoke()
}

window.closeMathBoard=function(){
  if(!MB.open)return
  MB.open=false
  var ov=document.getElementById('mb-overlay'), card=document.getElementById('mb-card')
  ov.style.opacity='0'; card.style.transform='translateY(14px) scale(.98)'
  document.body.style.overflow=''
  if(MB.poll){clearInterval(MB.poll);MB.poll=null}
  if(MB.idle){clearTimeout(MB.idle);MB.idle=null}
  setTimeout(function(){ if(!MB.open) ov.style.display='none' },210)
}

window.mbBgClose=function(e){ if(e.target&&e.target.id==='mb-overlay')closeMathBoard() }
window.mbPoke=mbPoke

init()

})()

</script>

<!-- ── 칠판 (호출/방송 시 손글씨로 표시 + 음성) · 화면 꽉 채움 ── -->
<div id="annPopup" onclick="closeAnnPopup()" style="display:none;position:fixed;inset:0;z-index:1200;background:rgba(20,12,4,.72);align-items:center;justify-content:center;padding:clamp(8px,1.5vw,18px);">
  <div id="annPopupCard" style="width:97vw;height:94vh;background:#8a5a2b;background-image:linear-gradient(#8a5a2b,#6f4620);border-radius:22px;padding:clamp(10px,1.4vw,16px);box-shadow:0 16px 0 rgba(36,28,18,.28), inset 0 0 0 2px rgba(0,0,0,.15);transition:transform .28s cubic-bezier(.34,1.5,.6,1);box-sizing:border-box;">
    <div style="position:relative;width:100%;height:100%;background:#2f4a3a;background-image:radial-gradient(rgba(255,255,255,.05) 1px, transparent 1.5px);background-size:18px 18px;border:2px solid rgba(0,0,0,.35);border-radius:12px;padding:clamp(24px,4vw,56px);text-align:center;display:flex;flex-direction:column;align-items:center;justify-content:center;box-sizing:border-box;">
      <div id="annPopupLabel" style="position:absolute;top:clamp(14px,2vw,22px);left:0;right:0;font-family:'Gaegu',cursive;font-size:clamp(16px,2.4vw,24px);color:rgba(255,255,255,.55);">선생님 칠판</div>
      <div id="annPopupText" style="font-family:'Gaegu','Black Han Sans',cursive;font-weight:700;font-size:clamp(40px,9vw,120px);color:#f7f7f0;text-shadow:0 2px 0 rgba(0,0,0,.25);word-break:keep-all;white-space:pre-line;line-height:1.25;letter-spacing:.5px;max-height:100%;overflow:auto;"></div>
      <div style="position:absolute;bottom:clamp(12px,1.8vw,20px);left:0;right:0;font-family:'Gaegu',cursive;font-size:clamp(13px,1.8vw,18px);color:rgba(255,255,255,.45);">화면을 누르면 닫혀요</div>
    </div>
  </div>
</div>

<!-- ── 수학 전광판 모달 (쏘이지 점수 읽기 전용 · 키오스크 크게) ── -->
<div id="mb-overlay" onclick="mbBgClose(event)" style="display:none;position:fixed;inset:0;z-index:1000;background:rgba(20,12,4,.6);align-items:center;justify-content:center;padding:18px;opacity:0;transition:opacity .2s ease;">
  <div id="mb-card" onclick="mbPoke()" role="dialog" aria-modal="true" aria-label="수학 전광판" style="position:relative;width:100%;max-width:540px;max-height:90vh;overflow-y:auto;-webkit-overflow-scrolling:touch;background:#fff;border:3px solid var(--ink);border-radius:24px;padding:clamp(18px,2.4vw,26px);box-shadow:0 18px 0 rgba(36,28,18,.18);transform:translateY(14px) scale(.98);transition:transform .22s cubic-bezier(.2,.9,.3,1.2);">
    <button onclick="closeMathBoard()" aria-label="닫기" style="position:absolute;top:12px;right:12px;width:40px;height:40px;display:flex;align-items:center;justify-content:center;background:#F1E9DC;border:2px solid var(--ink);border-radius:50%;cursor:pointer;font-size:20px;font-weight:800;color:var(--ink);line-height:1;">×</button>
    <div id="mb-body"></div>
  </div>
</div>

</body>

</html>`



// ══════════════════════════════════════════════════════════════════════════════

//  관리자 HTML

// ══════════════════════════════════════════════════════════════════════════════

const ADMIN_HTML = `<!DOCTYPE html>

<html lang="ko">

<head>

  <meta charset="UTF-8"/>

  <meta name="viewport" content="width=device-width,initial-scale=1"/>

  <title>관리자 - 바꿈수학</title>

  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>&#x2699;</text></svg>"/>

  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>

  <link href="https://fonts.googleapis.com/css2?family=Black+Han+Sans&family=Gaegu:wght@400;700&display=swap" rel="stylesheet"/>

  <link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/static/pretendard.css"/>

  <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet"/>

  <style>

    /* 띵똥 디자인 토큰 (변수명 유지, 값만 민트 초코 팔레트로 교체) */
    :root{--blue:#11998A;--blue-d:#0E8275;--blue-s:#E2F1EF;--blue-m:#7FC9C0;--white:#fff;--g50:#EEF3EE;--g100:#E4EDE3;--g200:#D8C9A8;--g400:#8A7A5C;--g600:#6B5E45;--g800:#1E261F;--red:#C0473A;--red-s:#FCE7E2;--green:#4C8A3A;--green-s:#E6F1E5;--yellow:#F4B62B;--yellow-s:#FCF3DC;--purple:#7A5CD0;--purple-s:#EFEAFB;--orange:#F2724B;--indigo:#11998A;--indigo-s:#E2F1EF;}

    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}

    body{font-family:'Pretendard',sans-serif;background:#EEF3EE;background-image:radial-gradient(#DBE6DB 1.3px, transparent 1.5px);background-size:22px 22px;color:var(--g800);min-height:100vh;}



    /* 로그인 */

    #login-screen{position:fixed;inset:0;z-index:999;background:linear-gradient(160deg,#dff3fc,#f0f9ff);display:flex;align-items:center;justify-content:center;padding:20px;}

    #login-screen.hidden{display:none;}

    .login-box{background:var(--white);border-radius:24px;padding:40px 36px;width:min(400px,96vw);box-shadow:0 20px 60px rgba(41,171,226,.15);text-align:center;}

    .login-logo{height:50px;margin-bottom:20px;}

    .login-title{font-size:22px;font-weight:900;color:var(--g800);margin-bottom:6px;}

    .login-sub{font-size:14px;color:var(--g400);margin-bottom:24px;line-height:1.6;}

    .pw-wrap{position:relative;margin-bottom:14px;}

    .pw-inp{width:100%;background:var(--g50);border:2px solid var(--g200);border-radius:14px;padding:14px 46px 14px 16px;font-family:inherit;font-size:20px;font-weight:700;outline:none;transition:all .2s;text-align:center;letter-spacing:8px;}

    .pw-inp:focus{border-color:var(--blue);box-shadow:0 0 0 3px rgba(41,171,226,.1);}

    .pw-eye{position:absolute;right:14px;top:50%;transform:translateY(-50%);cursor:pointer;color:var(--g400);font-size:16px;}

    .btn-login{width:100%;background:linear-gradient(135deg,var(--blue),var(--blue-d));color:white;border:none;border-radius:14px;font-family:inherit;font-size:16px;font-weight:800;padding:15px;cursor:pointer;transition:all .2s;box-shadow:0 4px 16px rgba(41,171,226,.35);}

    .btn-login:hover{transform:translateY(-1px);}

    .login-err{font-size:13px;color:var(--red);margin-top:10px;display:none;background:var(--red-s);border:1px solid rgba(239,68,68,.2);border-radius:8px;padding:8px 14px;}

    .login-err.show{display:block;}



    /* 헤더 */

    #main-screen.hidden{display:none;}

    .hdr{background:var(--white);border-bottom:1.5px solid var(--g200);padding:0 clamp(14px,3vw,32px);height:64px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:10;box-shadow:0 1px 6px rgba(0,0,0,.05);}

    .hdr-l{display:flex;align-items:center;gap:12px;}

    .hdr-l img{height:34px;width:auto;}

    .hdr-ttl{font-size:15px;font-weight:800;color:var(--blue);}

    .hdr-r{display:flex;gap:8px;align-items:center;}

    .btn-kiosk{display:flex;align-items:center;gap:5px;background:var(--blue);color:white;text-decoration:none;font-size:13px;font-weight:700;padding:7px 14px;border-radius:100px;transition:all .2s;}

    .btn-kiosk:hover{background:var(--blue-d);}

    .btn-logout{background:var(--g100);border:1.5px solid var(--g200);color:var(--g600);font-family:inherit;font-size:13px;font-weight:700;padding:7px 14px;border-radius:100px;cursor:pointer;transition:all .2s;}

    .btn-logout:hover{background:var(--red-s);color:var(--red);border-color:rgba(239,68,68,.3);}



    /* 탭 네비 */

    .main-tabs{display:flex;gap:4px;padding:14px clamp(14px,3vw,32px) 0;background:var(--white);border-bottom:1.5px solid var(--g200);overflow-x:auto;}

    .main-tabs::-webkit-scrollbar{display:none;}

    .mtab{display:flex;align-items:center;gap:6px;font-family:inherit;font-size:13px;font-weight:700;padding:10px 16px;border-radius:10px 10px 0 0;cursor:pointer;border:none;background:transparent;color:var(--g400);transition:all .2s;white-space:nowrap;border-bottom:2.5px solid transparent;margin-bottom:-1.5px;}

    .mtab:hover{color:var(--g800);background:var(--g50);}

    .mtab.active{color:var(--blue);border-bottom-color:var(--blue);background:var(--blue-s);}

    .mtab .badge{min-width:18px;height:18px;border-radius:9px;font-size:10px;font-weight:900;display:inline-flex;align-items:center;justify-content:center;padding:0 5px;}

    .mtab .badge.red{background:var(--red);color:white;}

    .mtab .badge.yellow{background:var(--yellow);color:#78350f;}

    .mtab .badge.blue{background:var(--blue);color:white;}



    /* 콘텐츠 영역 */

    .content{padding:clamp(14px,2.5vw,28px) clamp(14px,3vw,32px);max-width:1200px;margin:0 auto;}

    .tab-panel{display:none;}

    .tab-panel.active{display:block;}



    /* 카드 */

    .card{background:var(--white);border-radius:16px;border:1.5px solid var(--g200);box-shadow:0 2px 10px rgba(0,0,0,.04);margin-bottom:16px;overflow:hidden;}

    .card-head{display:flex;align-items:center;justify-content:space-between;padding:16px 20px;border-bottom:1.5px solid var(--g100);gap:10px;flex-wrap:wrap;}

    .card-title{font-size:15px;font-weight:800;color:var(--g800);display:flex;align-items:center;gap:7px;}

    .card-body{padding:16px 20px;}



    /* 필터 버튼 */

    .filter-row{display:flex;gap:6px;flex-wrap:wrap;}

    .filter-btn{font-family:inherit;font-size:12px;font-weight:700;padding:6px 14px;border-radius:100px;border:1.5px solid var(--g200);background:var(--white);color:var(--g600);cursor:pointer;transition:all .15s;}

    .filter-btn:hover{border-color:var(--blue);color:var(--blue);}

    .filter-btn.active{background:var(--blue);border-color:var(--blue);color:white;}



    /* 번호표 아이템 */

    .ticket-item{display:flex;align-items:center;gap:12px;padding:12px 0;border-bottom:1px solid var(--g100);}

    .ticket-item:last-child{border-bottom:none;}

    .ticket-num{width:46px;height:46px;border-radius:12px;display:flex;align-items:center;justify-content:center;font-family:'Nunito',sans-serif;font-size:20px;font-weight:900;flex-shrink:0;}

    .ticket-num.waiting{background:#dbeafe;color:#1d4ed8;}

    .ticket-num.answering{background:var(--yellow-s);color:#92400e;}

    .ticket-num.done{background:var(--green-s);color:#166534;}

    .ticket-info{flex:1;min-width:0;}

    .ticket-name{font-size:14px;font-weight:800;}

    .ticket-time{font-size:11px;color:var(--g400);margin-top:2px;}

    .ticket-actions{display:flex;gap:6px;flex-shrink:0;}

    .ticket-status-badge{display:inline-flex;align-items:center;gap:4px;font-size:11px;font-weight:800;padding:4px 10px;border-radius:100px;}

    .ticket-status-badge.waiting{background:#dbeafe;color:#1d4ed8;}

    .ticket-status-badge.answering{background:var(--yellow-s);color:#92400e;}

    .ticket-status-badge.done{background:var(--green-s);color:#166534;}

    .stat-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:10px;margin-bottom:16px;}

    .stat-card{background:var(--white);border:1.5px solid var(--g200);border-radius:14px;padding:14px 16px;text-align:center;}

    .stat-card .num{font-family:'Nunito',sans-serif;font-size:28px;font-weight:900;line-height:1;}

    .stat-card .lbl{font-size:11px;font-weight:700;color:var(--g400);margin-top:4px;}

    .stat-card.blue .num{color:#1d4ed8;}

    .stat-card.yellow .num{color:#92400e;}

    .stat-card.green .num{color:#166534;}

    .stat-card.gray .num{color:var(--g600);}



    /* 요청사항 */

    .req-item{display:flex;gap:12px;padding:14px 0;border-bottom:1px solid var(--g100);}

    .req-item:last-child{border-bottom:none;}

    .req-av{width:36px;height:36px;border-radius:50%;background:linear-gradient(135deg,var(--blue-s),#cde9f8);display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:900;color:var(--blue-d);flex-shrink:0;border:2px solid var(--blue-m);}

    .req-body{flex:1;min-width:0;}

    .req-top{display:flex;align-items:center;gap:8px;margin-bottom:4px;flex-wrap:wrap;}

    .req-name{font-size:13px;font-weight:800;}

    .req-time{font-size:11px;color:var(--g400);}

    .req-msg{font-size:13px;color:var(--g600);line-height:1.5;word-break:break-all;}

    .req-note{font-size:12px;color:var(--indigo);background:var(--indigo-s);border-radius:8px;padding:6px 10px;margin-top:6px;}

    .req-photo-badge{display:inline-flex;align-items:center;gap:3px;font-size:10px;font-weight:800;background:var(--orange);color:white;padding:2px 7px;border-radius:100px;}

    .req-actions{display:flex;gap:5px;flex-shrink:0;flex-direction:column;align-items:flex-end;}

    .status-badge{display:inline-flex;align-items:center;gap:3px;font-size:11px;font-weight:800;padding:4px 10px;border-radius:100px;white-space:nowrap;}

    .status-badge.pending{background:#fef3c7;color:#92400e;}

    .status-badge.in_progress{background:var(--blue-s);color:var(--blue-d);}

    .status-badge.done{background:var(--green-s);color:#166534;}



    /* 주문 현황 */

    .order-item{display:flex;gap:10px;padding:12px 0;border-bottom:1px solid var(--g100);align-items:flex-start;}

    .order-item:last-child{border-bottom:none;}

    .order-cat{width:32px;height:32px;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:15px;flex-shrink:0;}

    .order-cat.learn{background:var(--green-s);}

    .order-cat.fine{background:var(--red-s);}

    .order-cat.shop{background:var(--purple-s);}

    .order-body{flex:1;min-width:0;}

    .order-top{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:3px;}

    .order-stu{font-size:13px;font-weight:800;}

    .order-time{font-size:11px;color:var(--g400);}

    .order-items-txt{font-size:12px;color:var(--g600);}

    .order-cost{font-size:13px;font-weight:900;white-space:nowrap;flex-shrink:0;}

    .order-cost.gain{color:var(--green);}

    .order-cost.loss{color:var(--red);}

    .order-cost.free{color:var(--g400);}



    /* 학생 관리 */

    .stu-list-item{display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid var(--g100);}

    .stu-list-item:last-child{border-bottom:none;}

    .stu-av-sm{width:36px;height:36px;border-radius:50%;object-fit:cover;border:2px solid var(--blue-m);flex-shrink:0;}

    .stu-av-txt{width:36px;height:36px;border-radius:50%;background:var(--blue-s);border:2px solid var(--blue-m);display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:900;color:var(--blue-d);flex-shrink:0;}

    .stu-name-lbl{font-size:14px;font-weight:800;flex:1;}

    .stu-pts-lbl{font-size:12px;font-weight:700;background:var(--yellow-s);color:#92400e;border:1px solid rgba(251,191,36,.3);border-radius:100px;padding:2px 8px;}



    /* 메뉴 항목 / 화폐 설정 */

    .menu-item-row{display:flex;align-items:center;gap:8px;padding:10px 0;border-bottom:1px dashed var(--g100);flex-wrap:wrap;}

    .menu-item-row:last-child{border-bottom:none;}

    .item-label{font-size:13px;font-weight:700;flex:1;min-width:80px;}

    .item-cost-inp{width:72px;border:1.5px solid var(--g200);border-radius:8px;padding:5px 8px;font-family:inherit;font-size:12px;font-weight:700;text-align:center;outline:none;}

    .item-cost-inp:focus{border-color:var(--blue);}

    .item-unit-sel{border:1.5px solid var(--g200);border-radius:8px;padding:5px 6px;font-family:inherit;font-size:12px;font-weight:700;outline:none;background:var(--white);}

    .item-unit-sel:focus{border-color:var(--blue);}

    .item-del-btn{width:28px;height:28px;border-radius:8px;border:1.5px solid rgba(239,68,68,.25);background:var(--red-s);color:var(--red);font-size:12px;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;}



    /* 입력 컨트롤 */

    .inp{width:100%;border:1.5px solid var(--g200);border-radius:10px;padding:9px 12px;font-family:inherit;font-size:14px;font-weight:500;outline:none;transition:all .2s;background:var(--white);}

    .inp:focus{border-color:var(--blue);box-shadow:0 0 0 3px rgba(41,171,226,.08);}

    .sel{border:1.5px solid var(--g200);border-radius:10px;padding:9px 12px;font-family:inherit;font-size:14px;font-weight:500;outline:none;background:var(--white);cursor:pointer;}

    .btn{font-family:inherit;font-size:13px;font-weight:700;padding:8px 16px;border-radius:10px;cursor:pointer;border:none;transition:all .2s;}

    .btn-blue{background:var(--blue);color:white;}

    .btn-blue:hover{background:var(--blue-d);}

    .btn-green{background:var(--green);color:white;}

    .btn-green:hover{background:#16a34a;}

    .btn-red{background:var(--red);color:white;}

    .btn-red:hover{background:#dc2626;}

    .btn-gray{background:var(--g100);color:var(--g600);border:1.5px solid var(--g200);}

    .btn-gray:hover{background:var(--g200);}

    .btn-sm{padding:5px 11px;font-size:12px;border-radius:8px;}

    .btn-xs{padding:3px 8px;font-size:11px;border-radius:6px;}

    .btn-icon{width:32px;height:32px;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:14px;}



    /* 히스토리 모달 */

    .modal-ov{position:fixed;inset:0;z-index:300;background:rgba(15,23,42,.45);backdrop-filter:blur(6px);display:none;align-items:center;justify-content:center;padding:16px;}

    .modal-ov.open{display:flex;}

    .modal-box{background:var(--white);border-radius:20px;padding:28px 24px;width:min(520px,96vw);max-height:80vh;overflow-y:auto;box-shadow:0 24px 60px rgba(0,0,0,.16);}
    .rcpt{font-variant-numeric:tabular-nums;font-size:13px;}
    .rcpt-meta{color:var(--g600);font-size:12px;line-height:1.7;padding-bottom:10px;border-bottom:1.5px dashed var(--g200);}
    .rcpt-row{display:grid;grid-template-columns:1fr auto;gap:2px 10px;padding:10px 0;border-bottom:1px dashed var(--g200);}
    .rcpt-row .sub{grid-column:1/-1;display:flex;align-items:center;justify-content:space-between;font-size:12px;color:var(--g400);}
    .rcpt-row.done>b,.rcpt-row.done>span{color:var(--g400);text-decoration:line-through;}
    .rcpt-step{display:inline-flex;align-items:center;gap:6px;color:var(--g600);}
    .rcpt-step button{width:28px;height:28px;border-radius:8px;border:1.5px solid var(--g200);background:var(--white);font-weight:900;cursor:pointer;}
    .rcpt-sum{display:flex;justify-content:space-between;padding:10px 0;font-weight:900;}
    .rcpt-ref{color:var(--red);}
    .order-item.clickable{cursor:pointer;}

    .modal-title{font-size:18px;font-weight:900;margin-bottom:16px;}

    .hist-item{display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--g100);font-size:13px;}

    .hist-item:last-child{border-bottom:none;}

    .hist-delta{font-weight:900;}

    .hist-delta.pos{color:var(--green);}

    .hist-delta.neg{color:var(--red);}



    /* 저장 바 */

    .save-bar{position:sticky;bottom:0;background:rgba(255,255,255,.95);backdrop-filter:blur(10px);border-top:1.5px solid var(--g200);padding:12px 20px;display:flex;align-items:center;justify-content:space-between;gap:10px;margin:0 -20px -16px;}





    /* 토스트 */

    .toast{position:fixed;bottom:24px;right:24px;background:var(--g800);color:white;padding:10px 20px;border-radius:100px;font-size:13px;font-weight:700;z-index:9999;animation:tst-in .3s ease;pointer-events:none;}

    @keyframes tst-in{from{opacity:0;transform:translateY(10px);}to{opacity:1;transform:translateY(0);}}



    /* 반응형 */

    @media(max-width:640px){

      .ticket-actions,.req-actions{flex-direction:row;}

      .order-item{flex-wrap:wrap;}

    }

  </style>

</head>

<body>



<!-- 로그인 -->

<div id="login-screen">

  <div class="login-box">

    <img class="login-logo" src="/static/logo_horizontal.png" alt="바꿈수학"/>

    <div class="login-title">관리자 로그인</div>

    <div class="login-sub">바꿈수학 띵똥 관리자 페이지입니다.</div>

    <div class="pw-wrap">

      <input class="pw-inp" type="password" id="pwInp" placeholder="비밀번호" onkeydown="if(event.key==='Enter')doLogin()"/>

      <i class="fas fa-eye pw-eye" onclick="var i=document.getElementById('pwInp');i.type=i.type==='password'?'text':'password'"></i>

    </div>

    <button class="btn-login" onclick="doLogin()">로그인</button>

    <div class="login-err" id="loginErr">비밀번호가 틀렸습니다.</div>

  </div>

</div>



<!-- 메인 -->

<div id="main-screen" class="hidden">

  <header class="hdr">

    <div class="hdr-l">

      <img src="/static/logo_horizontal.png" alt="바꿈수학"/>

      <span class="hdr-ttl">관리자</span>

    </div>

    <div class="hdr-r">

      <a href="/" class="btn-kiosk" target="_blank"><i class="fas fa-desktop"></i> 띵똥</a>

      <button class="btn-logout" onclick="doLogout()"><i class="fas fa-sign-out-alt"></i> 로그아웃</button>

    </div>

  </header>



  <!-- 탭 네비 -->

  <nav class="main-tabs" id="mainTabs">

    <button class="mtab active" data-tab="queue" onclick="switchMainTab('queue')">

      <i class="fas fa-ticket"></i> 번호표

      <span class="badge blue" id="badge-queue">0</span>

    </button>

    <button class="mtab" data-tab="orders" onclick="switchMainTab('orders')">

      <i class="fas fa-list-check"></i> 주문현황

    </button>

    <button class="mtab" data-tab="students" onclick="switchMainTab('students')">

      <i class="fas fa-users"></i> 학생관리

    </button>

    <button class="mtab" data-tab="menu" onclick="switchMainTab('menu')">

      <i class="fas fa-utensils"></i> 메뉴설정

    </button>

    <button class="mtab" data-tab="shoplock" onclick="switchMainTab('shoplock')">

      <i class="fas fa-store"></i> 상점잠금

    </button>

    <button class="mtab" data-tab="loans" onclick="switchMainTab('loans')">

      <i class="fas fa-hand-holding-dollar"></i> 대출

      <span class="badge red" id="badge-loans" style="display:none;">0</span>

    </button>

  </nav>



  <div class="content">



    <!-- ══ 번호표 탭 ══ -->

    <div class="tab-panel active" id="tab-queue">

      <div class="card">

        <div class="card-head">

          <div class="card-title"><i class="fas fa-chalkboard"></i> 칠판 (키오스크 화면 + 음성)</div>

        </div>

        <div class="card-body">

          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">

            <input type="text" id="announceText" class="inp" style="flex:1;min-width:220px;" placeholder="예: 잠시 후 수업을 시작합니다" onkeydown="if(event.key==='Enter')sendAnnounce()"/>

            <button class="btn btn-blue" onclick="sendAnnounce()"><i class="fas fa-chalkboard"></i> 칠판에 쓰기</button>

            <button class="btn btn-gray" onclick="clearBoard()"><i class="fas fa-eraser"></i> 지우기</button>

          </div>

          <div style="margin-top:10px;">

            <button class="btn btn-green" style="width:100%;font-size:15px;padding:12px;" onclick="openBoardMode()"><i class="fas fa-expand"></i> 전체화면 칠판 모드 열기</button>

          </div>

          <div style="font-size:12px;color:var(--g400);margin-top:8px;">쓴 문장이 키오스크 <b>칠판</b>에 손글씨로 뜨고 음성으로 읽어줘요. <b>지우기</b> 전까지 화면에 유지됩니다. 전체화면 모드에선 <b>Enter=음성</b>, <b>Alt+Enter=줄바꿈</b>. (번호표 <b>호출</b>은 잠깐 떴다 사라짐)</div>

        </div>

      </div>

      <div class="card">

        <div class="card-head">

          <div class="card-title"><i class="fas fa-ticket"></i> 오늘 번호표 현황</div>

          <div style="display:flex;gap:8px;align-items:center;">

            <input type="date" id="queueDatePick" class="inp" style="width:160px;" onchange="loadQueue()"/>

            <button class="btn btn-blue btn-sm" onclick="loadQueue()"><i class="fas fa-rotate"></i> 새로고침</button>

          </div>

        </div>

        <div class="card-body">

          <div class="stat-cards" id="queueStats">

            <div class="stat-card blue"><div class="num" id="qs-waiting">-</div><div class="lbl">대기중</div></div>

            <div class="stat-card yellow"><div class="num" id="qs-answering">-</div><div class="lbl">답변중</div></div>

            <div class="stat-card green"><div class="num" id="qs-done">-</div><div class="lbl">완료</div></div>

            <div class="stat-card gray"><div class="num" id="qs-total">-</div><div class="lbl">총 발급</div></div>

          </div>

          <div class="filter-row" style="margin-bottom:12px;">

            <button class="filter-btn active" onclick="filterQueue('all',this)">전체</button>

            <button class="filter-btn" onclick="filterQueue('waiting',this)">대기중</button>

            <button class="filter-btn" onclick="filterQueue('answering',this)">답변중</button>

            <button class="filter-btn" onclick="filterQueue('done',this)">완료</button>

          </div>

          <div id="queueList"><div style="color:var(--g400);text-align:center;padding:20px;">로딩 중...</div></div>

        </div>

      </div>

    </div>



    <!-- ══ 주문현황 탭 ══ -->

    <div class="tab-panel" id="tab-orders">

      <div class="card">

        <div class="card-head">

          <div class="card-title"><i class="fas fa-list-check"></i> 제출 내역</div>

          <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">

            <input class="inp" id="orderSearch" placeholder="학생 이름 검색..." style="width:160px;" oninput="loadOrders()"/>

            <select class="sel" id="orderCatFilter" onchange="loadOrders()" style="padding:8px 10px;font-size:13px;">

              <option value="">전체 분류</option>

              <option value="learn">학습활동</option>

              <option value="shop">보상교환</option>

            </select>

            <button class="btn btn-blue btn-sm" onclick="loadOrders()"><i class="fas fa-rotate"></i> 새로고침</button>

          </div>

        </div>

        <div class="card-body">

          <div id="orderList"><div style="color:var(--g400);text-align:center;padding:20px;">로딩 중...</div></div>

        </div>

      </div>

    </div>



    <!-- ══ 대출 탭 ══ -->

    <div class="tab-panel" id="tab-loans">

      <div class="card">

        <div class="card-head">

          <div class="card-title"><i class="fas fa-hand-holding-dollar"></i> 포인트 교환 대출</div>

          <button class="btn btn-blue btn-sm" onclick="loadLoans()"><i class="fas fa-rotate"></i> 새로고침</button>

        </div>

        <div class="card-body">

          <div style="font-size:12px;color:var(--g400);margin-bottom:10px;">미상환 대출은 학생당 최대 3건. 당일 보충수업(10P=1분) 완료 후 <b>상환</b>을 눌러주세요. 상환하면 다시 대출할 수 있어요.</div>

          <div id="loanList"><div style="color:var(--g400);text-align:center;padding:20px;">로딩 중...</div></div>

        </div>

      </div>

    </div>



    <!-- ══ 학생 관리 탭 ══ -->

    <div class="tab-panel" id="tab-students">

      <div class="card">

        <div class="card-head">

          <div class="card-title"><i class="fas fa-users"></i> 학생 목록</div>

          <div style="display:flex;gap:8px;">

            <input class="inp" id="newStuName" placeholder="새 학생 이름" style="width:160px;" onkeydown="if(event.key==='Enter')addStudent()"/>

            <button class="btn btn-green btn-sm" onclick="addStudent()"><i class="fas fa-plus"></i> 추가</button>

          </div>

        </div>

        <div class="card-body">

          <div id="stuList">로딩 중...</div>

        </div>

      </div>

    </div>



    <!-- ══ 메뉴 설정 탭 ══ -->

    <div class="tab-panel" id="tab-menu">

      <div class="card">

        <div class="card-head">

          <div class="card-title"><i class="fas fa-shopping-bag"></i> 보상 상점</div>

        </div>

        <div class="card-body">

          <div id="menuShopList"></div>

          <div style="display:flex;gap:7px;margin-top:10px;flex-wrap:wrap;align-items:flex-end;">
            <input class="inp" id="nSLbl" placeholder="항목명" style="flex:1;min-width:100px;"/>
            <input class="inp" id="nSCost" placeholder="비용" type="number" style="width:70px;"/>
            <div style="display:flex;flex-direction:column;gap:2px;">
              <input class="inp" id="nSDailyLimit" placeholder="0" type="number" min="0" style="width:60px;" title="하루 구매 한도 (0=무제한)"/>
              <span style="font-size:10px;color:var(--g400);text-align:center;">일한도</span>
            </div>
            <div style="display:flex;flex-direction:column;gap:2px;">
              <input class="inp" id="nSMonthlyStock" placeholder="0" type="number" min="0" style="width:60px;" title="월 재고 (0=무제한)"/>
              <span style="font-size:10px;color:var(--g400);text-align:center;">월재고</span>
            </div>
            <button class="btn btn-blue btn-sm" id="addShopBtn">추가</button>
          </div>

          <div style="display:flex;align-items:center;gap:8px;margin-top:14px;padding-top:12px;border-top:1.5px solid var(--g200);flex-wrap:wrap;">
            <span style="font-size:12px;font-weight:700;">한 번에 담을 수 있는 총 개수</span>
            <input class="inp" id="shopMaxPerOrder" type="number" min="0" placeholder="0" style="width:70px;"/>
            <span style="font-size:11px;color:var(--g400);">0이면 제한 없어요</span>
          </div>

        </div>

      </div>

      <div style="position:sticky;bottom:0;background:rgba(255,255,255,.95);backdrop-filter:blur(10px);border-top:1.5px solid var(--g200);padding:12px 0;display:flex;gap:8px;justify-content:flex-end;">

        <button class="btn btn-gray btn-sm" id="resetmenuBtn"><i class="fas fa-rotate-left"></i> 기본값</button>

        <button class="btn btn-blue" id="savemenuBtn"><i class="fas fa-floppy-disk"></i> 메뉴 저장</button>

      </div>

    </div>



  <!-- ══ 상점 잠금 탭 ══ -->
    <div class="tab-panel" id="tab-shoplock">
 
      <!-- 승인 요청 목록 -->
      <div class="card">
        <div class="card-head">
          <div class="card-title"><i class="fas fa-bell"></i> 상점 열기 요청</div>
          <button class="btn btn-sm btn-green" onclick="loadShopRequests()"><i class="fas fa-refresh"></i></button>
        </div>
        <div class="card-body">
          <div id="shopRequestList"><div style="color:var(--g400);text-align:center;padding:16px;">로딩 중...</div></div>
        </div>
      </div>
 
      <!-- 현재 상태 -->
      <div class="card">
        <div class="card-head">
          <div class="card-title"><i class="fas fa-store"></i> 상점 현재 상태</div>
        </div>
        <div class="card-body">
          <div id="shopStatusBadge" style="margin-bottom:12px;padding:10px 14px;border-radius:10px;font-weight:700;font-size:14px;">확인 중...</div>
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
            <button class="btn btn-green btn-sm" id="adminUnlockBtn" onclick="adminUnlockShop()"><i class="fas fa-unlock"></i> 열기</button>
            <button class="btn btn-red btn-sm" id="adminLockBtn" onclick="adminLockShop()"><i class="fas fa-lock"></i> 즉시 잠금</button>
          </div>
        </div>
      </div>
 
      <!-- 수업 시간표 설정 -->
      <div class="card">
        <div class="card-head">
          <div class="card-title"><i class="fas fa-calendar-week"></i> 수업 시간표 설정</div>
        </div>
        <div class="card-body">
          <div style="font-size:12px;color:var(--g500);margin-bottom:10px;background:#f0f9ff;border:1px solid #bae6fd;border-radius:8px;padding:8px 10px;">
            <i class="fas fa-info-circle" style="color:#0ea5e9;margin-right:4px;"></i>
            수업 시간 중에는 상점이 자동으로 잠깁니다.<br>
            <b>시간표 모드</b>에서만 적용돼요. 강제 잠금/오픈 상태에서는 시간표가 무시됩니다.
          </div>
          <div id="scheduleSlots"></div>
          <button class="btn btn-blue btn-sm" style="margin-top:8px;" onclick="addScheduleSlot()"><i class="fas fa-plus"></i> 시간대 추가</button>
          <div style="margin-top:14px;display:flex;gap:8px;">
            <button class="btn btn-green" onclick="saveSchedule()"><i class="fas fa-floppy-disk"></i> 시간표 저장</button>
          </div>
        </div>
      </div>
 
      <!-- 이번 달 재고 관리 -->
      <div class="card">
        <div class="card-head">
          <div class="card-title"><i class="fas fa-box"></i> 이번 달 재고 관리</div>
          <button class="btn btn-sm btn-green" onclick="doRestock()"><i class="fas fa-rotate"></i> 이번 달 재고 채우기</button>
        </div>
        <div class="card-body">
          <div style="font-size:12px;color:var(--g500);margin-bottom:12px;background:#fff7ed;border:1px solid #fed7aa;border-radius:8px;padding:8px 10px;">
            <i class="fas fa-info-circle" style="color:#f97316;margin-right:4px;"></i>
            메뉴설정 → 보상 상점에서 <b>월 재고</b>를 설정한 후,<br>
            매달 초에 <b>이번 달 재고 채우기</b> 버튼을 눌러주세요.<br>
            학생들이 구매할 때마다 재고가 자동으로 줄어들어요.
          </div>
          <div id="shopStockInfo">
            <div style="color:var(--g400);font-size:13px;">로딩 중...</div>
          </div>
        </div>
      </div>
 
    </div>

   

</div><!-- /main-screen -->



<!-- 주문 영수증·환불 모달 -->
<div class="modal-ov" id="rcpt-modal" onclick="if(event.target===this)closeReceipt()">
  <div class="modal-box" style="max-width:420px;">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
      <div class="modal-title" style="margin:0;">영수증</div>
      <button class="btn btn-gray btn-sm" onclick="closeReceipt()"><i class="fas fa-xmark"></i></button>
    </div>
    <div id="rcptBody"></div>
  </div>
</div>

<!-- 포인트 이력 모달 -->

<div class="modal-ov" id="hist-modal">

  <div class="modal-box">

    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">

      <div class="modal-title" id="histTitle">포인트 이력</div>

      <button class="btn btn-gray btn-sm" id="closeHistBtn"><i class="fas fa-xmark"></i></button>

    </div>

    <div id="histList"></div>

  </div>

</div>






<!-- 학생 시간표 설정 모달 -->
<div class="modal-ov" id="stu-sched-modal" onclick="if(event.target===this)closeStuSchedModal()">
  <div class="modal-box" style="max-width:460px;width:95%;">
    <div class="modal-head" style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">
      <span class="modal-title" id="stuSchedTitle">수업 시간표</span>
      <button class="btn btn-gray btn-sm" onclick="closeStuSchedModal()">×</button>
    </div>
    <div style="font-size:12px;color:var(--g500);margin-bottom:10px;background:#f0f9ff;border-radius:8px;padding:8px 10px;border:1px solid #bae6fd;">
      <i class="fas fa-info-circle" style="color:#0ea5e9;margin-right:4px;"></i>
      수업 시간 중에는 이 학생의 상점이 자동으로 잠깁니다.<br>
      비워두면 전체 공통 시간표가 적용됩니다.
    </div>
    <div id="stuSchedSlots" style="margin-bottom:12px;"></div>
    <button class="btn btn-gray btn-sm" onclick="addStuSchedSlot()" style="margin-bottom:14px;">
      <i class="fas fa-plus"></i> 시간대 추가
    </button>
    <div style="display:flex;gap:8px;">
      <button class="btn btn-green" onclick="saveStuSchedule()" style="flex:1;">
        <i class="fas fa-floppy-disk"></i> 저장
      </button>
      <button class="btn btn-gray" onclick="closeStuSchedModal()">취소</button>
    </div>
  </div>
</div>

<!-- ── 전체화면 칠판 모드 (관리자) : Enter=음성, Alt+Enter=줄바꿈 ── -->
<div id="boardMode" style="display:none;position:fixed;inset:0;z-index:9000;background:#6f4620;padding:clamp(10px,1.5vw,18px);box-sizing:border-box;flex-direction:column;">
  <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:6px 8px 10px;">
    <div style="font-family:'Gaegu',cursive;font-size:20px;color:#f7f7f0;font-weight:700;">🖍️ 칠판 모드 &nbsp;<span style="font-size:14px;color:rgba(255,255,255,.7);">Enter = 음성 · Alt+Enter = 줄바꿈</span></div>
    <div style="display:flex;gap:8px;">
      <button class="btn btn-blue btn-sm" onclick="testVoice()"><i class="fas fa-volume-high"></i> 소리 테스트</button>
      <button class="btn btn-gray btn-sm" onclick="clearBoard()"><i class="fas fa-eraser"></i> 지우기</button>
      <button class="btn btn-red btn-sm" onclick="closeBoardMode()"><i class="fas fa-xmark"></i> 닫기</button>
    </div>
  </div>
  <textarea id="boardInput" spellcheck="false" placeholder="여기에 쓰면 키오스크 칠판에 떠요. Enter로 음성이 나갑니다."
    style="flex:1;width:100%;resize:none;border:none;outline:none;border-radius:14px;background:#2f4a3a;background-image:radial-gradient(rgba(255,255,255,.05) 1px, transparent 1.5px);background-size:20px 20px;color:#f7f7f0;font-family:'Gaegu',cursive;font-weight:700;font-size:clamp(32px,6vw,72px);line-height:1.3;text-align:center;padding:clamp(20px,4vh,60px) clamp(16px,3vw,40px);box-sizing:border-box;caret-color:#f7f7f0;"></textarea>
</div>

<script src="/static/admin.js?v=20260922a"></script>
</body>

</html>`

export default app

