/**
 * Phase 63 (OBS-01): Tests for classifyError pure helper.
 *
 * classifyError normalises any thrown value into a { errorClass, errorMessage }
 * pair that can be dropped into an audit entry. These tests lock the decision
 * table before the agent loop starts calling it.
 */
import { describe, test, expect } from 'bun:test'
import { classifyError } from './error-classifier.js'

describe('classifyError', () => {
  test('1: Node fs error with code=EROFS → errorClass EROFS', () => {
    const err = Object.assign(new Error('read-only file system'), { code: 'EROFS' })
    const { errorClass, errorMessage } = classifyError(err)
    expect(errorClass).toBe('EROFS')
    expect(errorMessage).toContain('read-only file system')
  })

  test('2: Node fs error with code=EBADF → errorClass EBADF', () => {
    const err = Object.assign(new Error('bad file descriptor'), { code: 'EBADF' })
    const { errorClass, errorMessage } = classifyError(err)
    expect(errorClass).toBe('EBADF')
    expect(errorMessage).toContain('bad file descriptor')
  })

  test('3: plain Error with no code → errorClass Error', () => {
    const err = new Error('boom')
    const { errorClass, errorMessage } = classifyError(err)
    expect(errorClass).toBe('Error')
    expect(errorMessage).toBe('boom')
  })

  test('4: HTTP-shaped error with status=400 → errorClass HTTPError, message includes status', () => {
    const err = { status: 400, message: 'Bad Request' }
    const { errorClass, errorMessage } = classifyError(err)
    expect(errorClass).toBe('HTTPError')
    expect(errorMessage).toContain('400')
    expect(errorMessage).toContain('Bad Request')
  })

  test('5: string throw → errorClass Unknown, message equals the string', () => {
    const { errorClass, errorMessage } = classifyError('nope')
    expect(errorClass).toBe('Unknown')
    expect(errorMessage).toBe('nope')
  })

  test('6: null / undefined → errorClass Unknown', () => {
    const a = classifyError(null)
    const b = classifyError(undefined)
    expect(a.errorClass).toBe('Unknown')
    expect(b.errorClass).toBe('Unknown')
  })

  test('7: Error.message longer than 500 chars → truncated to 500 with trailing ellipsis', () => {
    const longMsg = 'x'.repeat(600)
    const err = new Error(longMsg)
    const { errorMessage } = classifyError(err)
    expect(errorMessage.length).toBe(500)
    expect(errorMessage.endsWith('…')).toBe(true)
  })

  test('8: Anthropic/OpenAI-style error with name=APIError → errorClass APIError', () => {
    const err = Object.assign(new Error('provider returned 429'), { name: 'APIError' })
    const { errorClass, errorMessage } = classifyError(err)
    expect(errorClass).toBe('APIError')
    expect(errorMessage).toContain('provider returned 429')
  })
})
