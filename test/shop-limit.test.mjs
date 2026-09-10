// 한 번 주문 총 개수 제한 자체 점검: node test/shop-limit.test.mjs
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'

const src = readFileSync(new URL('../src/index.tsx', import.meta.url), 'utf8')

// 키오스크에 심어둔 canAddShop 함수를 그대로 꺼내 실행한다 (문법 오류도 여기서 잡힌다)
const fnText = src.match(/function canAddShop\(tab,add\)\{[\s\S]*?\n\}/)[0]
let toasted = null
const make = (max, cart) =>
  new Function('CFG', 'ST', 'toast', fnText + '; return canAddShop')(
    { shopMaxPerOrder: max },
    { cart },
    (m) => { toasted = m },
  )

const cart = [{ tab: 'shop', qty: 2 }, { tab: 'fine', qty: 5 }]

assert.equal(make(0, cart)('shop', 1), true, '0이면 제한 없음')
assert.equal(make(3, cart)('shop', 1), true, '2+1 <= 3 이면 담긴다')
assert.equal(make(2, cart)('shop', 1), false, '2+1 > 2 이면 막힌다')
assert.equal(toasted, '한 번에 2개까지 담을 수 있어요')
assert.equal(make(2, cart)('fine', 1), true, '상점 외 탭은 제한 없음')

// 서버도 같은 문구/기준으로 막는지 (한도 초과 시 400)
assert.match(src, /if \(totalQty > maxPerOrder\)/)

console.log('ok')
