import test from 'node:test'
import assert from 'node:assert/strict'
import { validHelpMessage, validHelpPhone } from '../help.ts'

test('help accepts local and formatted international phone numbers', () => {
  for (const phone of ['9876543210', '+91 98765 43210', '+1 (202) 555-0123', ' 020-1234567 ', '+123456789012345']) {
    assert.equal(validHelpPhone(phone), true, phone)
  }
})

test('help rejects invalid phone numbers', () => {
  for (const phone of ['', '12345', '+1234567890123456', 'call me please', '98765abc43210', '++919876543210', '123+4567890']) {
    assert.equal(validHelpPhone(phone), false, phone)
  }
})

test('help requires a meaningful bounded message', () => {
  for (const message of ['', 'short', '          ', 'x'.repeat(3001)]) assert.equal(validHelpMessage(message), false)
  assert.equal(validHelpMessage('The assessment page is not loading.'), true)
  assert.equal(validHelpMessage('x'.repeat(10)), true)
  assert.equal(validHelpMessage('x'.repeat(3000)), true)
})
